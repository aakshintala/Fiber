import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 120_000;
const CONFIGURED_SANDBOX = process.platform === "darwin" ? "os" : "none";

type FxJson = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  mkdirSync(workspace, { recursive: true });
  mkdirSync(external, { recursive: true });
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    external: realpathSync(external),
  };
}

function parseFxJson(result: { stdout: string; stderr: string; code: number | null }): FxJson {
  if (result.code !== 0) {
    throw new Error(`fiber exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()).data as FxJson;
}

// Review requests carry the reviewer prompt inline; agent requests never do.
// Filtering on that marker is the Responses-protocol equivalent of counting
// the removed Gateway classifier endpoint hits.
function reviewRequests(codex: ReturnType<typeof startFakeCodex>) {
  return codex.requests.filter((request) => request.body.includes("<permission_review>"));
}

// The Codex helper serves one callback instead of a finite queue: answer the
// single forced permission_decision review call with a clear decision, serve
// the first agent turn from `first`, and close the turn after tool results.
function agentRoute(first: () => string, finalText: string) {
  return (body: string) => {
    if (body.includes("<permission_review>")) {
      return codexToolCall("review_decision_1", "permission_decision", {
        risk: "low",
        decision: "clear",
        rationale: "test fixture",
      });
    }
    const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
    if (items.some((item) => item.type === "function_call_output")) {
      return codexFinalText(finalText);
    }
    return first();
  };
}

async function runWithFakeCodex(
  root: ReturnType<typeof createIsolatedRoot>,
  args: string[],
  route: (body: string) => string,
  env: Record<string, string> = {},
) {
  const codex = startFakeCodex({ route });
  try {
    const result = await runFx(args, {
      cwd: root.workspace,
      env: fakeCodexEnv(root.home, codex, {
        FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
        ...env,
      }),
      timeoutMs: TIMEOUT,
    });
    return { codex, result };
  } finally {
    codex.stop();
  }
}

describe("external file permissions", () => {
  test(
    "fiber ask --permission-mode yolo bypasses a configured write denial without a classifier request",
    async () => {
      const root = createIsolatedRoot("fiber-yolo-permissions-");
      try {
        const target = join(root.external, "yolo-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        const settingsPath = join(root.home, ".fiber", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            permission_mode: "ask",
            sandbox: CONFIGURED_SANDBOX,
            yolo_acknowledged: false,
            permission: { edit: "deny" },
          }) + "\n",
        );

        const { codex, result } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--permission-mode", "yolo",
            `Use only the write_file tool to create ${target} with exactly this content: FIBER_E2E_YOLO.`,
          ],
          agentRoute(
            () =>
              codexToolCall("yolo_write_1", "write_file", {
                path: target,
                content: "FIBER_E2E_YOLO",
              }),
            "yolo write complete",
          ),
          {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission",
          },
        );

        expect(result.stderr).toContain(
          "YOLO enabled: fiber permission checks disabled",
        );
        const output = parseFxJson(result);
        expect(
          output.tool_calls.some(
            (call) => call.name === "write_file" && call.status === "success",
          ),
        ).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("FIBER_E2E_YOLO");
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).not.toContain("event=auto_review_start");
        expect(reviewRequests(codex)).toHaveLength(0);
        expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
          permission_mode: "ask",
          sandbox: CONFIGURED_SANDBOX,
          yolo_acknowledged: true,
        });
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask reads external paths and exercises classifier and rule-gated writes",
    async () => {
      const root = createIsolatedRoot("fiber-file-permissions-");
      try {
        const readTarget = join(root.external, "read-fixture.txt");
        const classifiedTarget = join(root.external, "classified-write.txt");
        const allowedTarget = join(root.external, "allowed-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        writeFileSync(readTarget, "FIBER_E2E_EXTERNAL_READ\n");
        writeFileSync(classifiedTarget, "before");
        writeFileSync(join(root.home, ".fiber", "settings.json"), "{}");

        const { result: readResult } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--permission-mode", "auto",
            `Use only the read_file tool to read ${readTarget}, then reply with exactly the file content and nothing else.`,
          ],
          agentRoute(
            () =>
              codexToolCall("external_read_1", "read_file", { path: readTarget }),
            "FIBER_E2E_EXTERNAL_READ",
          ),
        );
        const read = parseFxJson(readResult);
        expect(read.tool_calls).toContainEqual({ name: "read_file", status: "success" });
        expect(read.output).toContain("FIBER_E2E_EXTERNAL_READ");

        const { codex: classifiedCodex, result: classifiedResult } =
          await runWithFakeCodex(
            root,
            [
              "ask",
              "--json",
              "--no-save",
              "--permission-mode", "auto",
              `Use only the write_file tool to overwrite ${classifiedTarget} with exactly this content: FIBER_E2E_EXTERNAL_CLASSIFIED.`,
            ],
            agentRoute(
              () =>
                codexToolCall("classified_write_1", "write_file", {
                  path: classifiedTarget,
                  content: "FIBER_E2E_EXTERNAL_CLASSIFIED",
                }),
              "classified write complete",
            ),
            {
              FIBER_TRACE_LOG: tracePath,
              FIBER_TRACE_SCOPES: "permission",
            },
          );
        const trace = readFileSync(tracePath, "utf-8");
        expect(trace.match(/event=auto_review_start/g)).toHaveLength(1);
        expect(trace.match(/event=auto_review_result/g)).toHaveLength(1);
        expect(trace).toContain("event=auto_review_result tool_name=write_file decision=clear");
        expect(reviewRequests(classifiedCodex)).toHaveLength(1);
        const classified = parseFxJson(classifiedResult);
        expect(classified.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(classifiedTarget, "utf-8")).toBe("FIBER_E2E_EXTERNAL_CLASSIFIED");

        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({
            permission: {
              edit: {
                [`${root.external}/**`]: "allow",
              },
            },
          }),
        );

        const { codex: allowedCodex, result: allowedResult } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--permission-mode", "auto",
            `Use only the write_file tool to create ${allowedTarget} with exactly this content: FIBER_E2E_EXTERNAL_ALLOWED.`,
          ],
          agentRoute(
            () =>
              codexToolCall("allowed_write_1", "write_file", {
                path: allowedTarget,
                content: "FIBER_E2E_EXTERNAL_ALLOWED",
              }),
            "allowed write complete",
          ),
        );
        const allowed = parseFxJson(allowedResult);
        expect(allowed.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(allowedTarget, "utf-8")).toBe("FIBER_E2E_EXTERNAL_ALLOWED");
        expect(reviewRequests(allowedCodex)).toHaveLength(0);
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
