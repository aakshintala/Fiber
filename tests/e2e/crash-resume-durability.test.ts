/**
 * Crash-resume durability E2E (per-item log, #201).
 *
 * Owned regression proof that a SIGKILL before the first commit loses
 * nothing: the plant turn's history survives, every run_started is closed,
 * and the usage fold reproduces the exact billed totals across resume.
 * Uniquely end-to-end here: it drives real `fiber ask` binaries against a
 * fake Codex server, SIGKILLs the victim run mid-boundary, and resumes.
 * Fold math itself is covered in-process (session_event.zig,
 * session_log.zig) and is not re-proved here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const PLANT = "Plant the crash proof turn.";
const RESOLVE = "Resolve after the crash.";

describe("crash-resume durability", () => {
  test("SIGKILL before the first commit resumes with history, balanced runs, exact usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "fiber-crash-proof-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const codex = startFakeCodex({
      route: (body: string) => {
        if (body.includes(RESOLVE)) return codexCompletionWithIdentity("Resolved after crash.", "resp_proof_2");
        return codexCompletionWithIdentity("Planted turn completed.", "resp_proof_1");
      },
    });
    try {
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const plant = await runFx(["ask", "--json", "--permission-mode", "auto", PLANT], {
        cwd: workspace, env: fakeCodexEnv(home, codex), timeoutMs: 30_000,
      });
      expect(plant.code).toBe(0);
      const plantJson = JSON.parse(plant.stdout.trim()).data;
      const id = plantJson.session_id as string;
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(codex.requests.length).toBe(1);

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
      expect(codex.requests.length).toBe(1);

      const resolve = await runFx(["ask", "--json", "--permission-mode", "auto", "--resume-id", id, RESOLVE], {
        cwd: workspace, env: fakeCodexEnv(home, codex), timeoutMs: 30_000,
      });
      expect(resolve.code).toBe(0);
      expect(resolve.stderr).toBe("");
      const resolveJson = JSON.parse(resolve.stdout.trim()).data;
      expect(resolveJson.output as string).toContain("Resolved after crash.");
      expect(resolveJson.session_id).toBe(id);

      const show = await runFx(["session", "show", "--id", id, "--json"], {
        cwd: workspace, env: { HOME: home }, timeoutMs: 15_000,
      });
      expect(show.code).toBe(0);
      const detail = JSON.parse(show.stdout.trim()).data;
      const userTexts = (detail.history as Array<{ user?: { text?: string } }>).map((t) => t.user?.text);
      expect(detail.history_len).toBe(2);
      expect(userTexts).toContain(PLANT);
      expect(userTexts).toContain(RESOLVE);

      // Independent fold of the log: every run_started closed, usage exact.
      const events = readFileSync(join(home, ".fiber", "sessions", id, "events.jsonl"), "utf8")
        .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const kinds = events.map((e) => e.kind as string);
      const count = (k: string) => kinds.filter((x) => x === k).length;
      expect(count("run_started")).toBe(count("run_completed"));
      expect(count("run_started")).toBe(2);
      expect(count("turn_started")).toBe(2);
      expect(count("turn_completed")).toBe(2);
      expect(kinds).not.toContain("history_turn_committed");
      expect(kinds).not.toContain("usage_checkpointed");
      // One durable line per boundary: restored starts are never re-emitted,
      // so every started id appears exactly once.
      for (const kind of ["message_started", "reasoning_started"] as const) {
        const ids = events.filter((e) => e.kind === kind).map((e) => `${e.turn_id}:${e.item_id}`);
        expect(new Set(ids).size).toBe(ids.length);
      }
      const seen = new Map<string, { input_tokens: number; output_tokens: number }>();
      for (const e of events) if (e.kind === "usage_recorded") seen.set(e.payload.generation_id, e.payload);
      let input = 0, output = 0;
      for (const g of seen.values()) { input += g.input_tokens; output += g.output_tokens; }
      expect(seen.size).toBe(codex.requests.length);
      expect(input).toBe(260);
      expect(output).toBe(50);
    } finally {
      codex.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
