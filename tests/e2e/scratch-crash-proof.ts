import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runFx, FIBER_BIN } from "./eval-helpers";
import {
  chatGptAccessToken,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const USAGE_DETAILS = {
  input_tokens: 130,
  output_tokens: 25,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  output_tokens_details: { reasoning_tokens: 5 },
};

function codexCompletionWithIdentity(text: string, responseId: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: responseId, status: "completed", usage: USAGE_DETAILS },
    })}\n\n`;
}

const root = mkdtempSync(join(tmpdir(), "fiber-crash-proof-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });

const PLANT = "Plant the crash proof turn.";
const RESOLVE = "Resolve after the crash.";
const codex = startFakeCodex({
  route: (body: string) => {
    if (body.includes(RESOLVE)) return codexCompletionWithIdentity("Resolved after crash.", "resp_proof_2");
    return codexCompletionWithIdentity("Planted turn completed.", "resp_proof_1");
  },
});
let failed = false;
const check = (name: string, cond: boolean) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed = true;
};
try {
  writeSeededChatGptLogin(home, chatGptAccessToken());
  const plant = await runFx(["ask", "--json", "--permission-mode", "auto", PLANT], {
    cwd: workspace, env: fakeCodexEnv(home, codex), timeoutMs: 30_000,
  });
  check("plant exit 0", plant.code === 0);
  const plantJson = JSON.parse(plant.stdout.trim()).data;
  const id = plantJson.session_id as string;
  check("plant session id", typeof id === "string" && id.length > 0);
  check("plant made 1 request", codex.requests.length === 1);

  // Crash the victim run at its first commit (run_started).
  const readyPath = join(root, "boundary.ready");
  const child = spawn(FIBER_BIN, ["ask", "--json", "--permission-mode", "auto", "--resume-id", id, "Victim turn never streams."],
    { cwd: workspace, env: { ...fakeCodexEnv(home, codex), FIBER_E2E_SESSION_BOUNDARY: "after_event_append", FIBER_E2E_SESSION_BOUNDARY_READY: readyPath } as Record<string, string>, stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (!existsSync(readyPath)) {
    if (Date.now() > deadline) throw new Error("boundary never paused");
    await Bun.sleep(100);
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => { child.on("close", () => resolve()); setTimeout(() => resolve(), 10_000); });
  check("victim made no model request", codex.requests.length === 1);

  const resolve = await runFx(["ask", "--json", "--permission-mode", "auto", "--resume-id", id, RESOLVE], {
    cwd: workspace, env: fakeCodexEnv(home, codex), timeoutMs: 30_000,
  });
  check("resolve exit 0", resolve.code === 0);
  check("resolve stderr clean", resolve.stderr === "");
  const resolveJson = JSON.parse(resolve.stdout.trim()).data;
  check("resolve output", (resolveJson.output as string).includes("Resolved after crash."));
  check("resolve same session", resolveJson.session_id === id);

  const show = await runFx(["session", "show", "--id", id, "--json"], {
    cwd: workspace, env: { HOME: home }, timeoutMs: 15_000,
  });
  check("show exit 0", show.code === 0);
  const detail = JSON.parse(show.stdout.trim()).data;
  const userTexts = (detail.history as Array<{ user?: { text?: string } }>).map((t) => t.user?.text);
  check("history has plant + resolve", detail.history_len === 2 && userTexts.includes(PLANT) && userTexts.includes(RESOLVE));

  // Independent fold of the log: every run_started closed, usage exact.
  const events = readFileSync(join(home, ".fiber", "sessions", id, "events.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.kind as string);
  const count = (k: string) => kinds.filter((x) => x === k).length;
  check("run_started balanced by run_completed", count("run_started") === count("run_completed"));
  check("victim run left no line (killed pre-commit)", count("run_started") === 2);
  check("2 turns completed", count("turn_started") === 2 && count("turn_completed") === 2);
  check("no history_turn_committed", !kinds.includes("history_turn_committed"));
  check("no usage_checkpointed", !kinds.includes("usage_checkpointed"));
  const seen = new Map<string, { input_tokens: number; output_tokens: number }>();
  for (const e of events) if (e.kind === "usage_recorded") seen.set(e.payload.generation_id, e.payload);
  let input = 0, output = 0;
  for (const g of seen.values()) { input += g.input_tokens; output += g.output_tokens; }
  console.log(`INFO usage generations=${seen.size} input=${input} output=${output} requests=${codex.requests.length}`);
  check("usage generations match model calls", seen.size === codex.requests.length && input === 260 && output === 50);
} finally {
  codex.stop();
}
if (failed) { console.log("PROOF FAILED"); process.exit(1); }
console.log("PROOF PASSED");
