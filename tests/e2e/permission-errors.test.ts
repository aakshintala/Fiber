import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexLatestToolResult,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  fakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 120_000;

type FxJson = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

type PermissionEcho = {
  type: string;
  tool_name: string;
  message: string;
  reason: string;
  denied: boolean;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".fiber"), { recursive: true });
  writeSeededChatGptLogin(home, chatGptAccessToken());
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

function parseFxJson(result: { stdout: string; stderr: string; code: number | null }): FxJson {
  if (result.code !== 0) {
    throw new Error(`fiber exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()).data as FxJson;
}

// Tool results ride the Responses input as function_call_output items. The
// denial echo itself is transport-independent; only the gateway result
// framing around it is gone, so the helper returns the echo JSON directly.
function executionDeniedReason(body: string, toolCallId: string): string {
  const result = codexLatestToolResult(body);
  expect(result).not.toBeNull();
  expect(result!.callId).toBe(toolCallId);
  return result!.output;
}

function permissionEnv(
  home: string,
  codex: ReturnType<typeof startFakeCodex>,
) {
  return fakeCodexEnv(home, codex, {
    FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
    NO_COLOR: "1",
  });
}

async function waitForPaneExit(
  session: TmuxSession,
  expectedStatus: number,
) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const status = session.paneStatus();
    if (status.dead) {
      expect(status.status).toBe(expectedStatus);
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Timed out waiting for fiber ask to exit.\n${await session.captureFullScrollback()}`,
  );
}

async function runTtyPromptPermissionsCase(
  outputMode: "json" | "quiet",
  decision: "approve" | "deny",
) {
  const root = createIsolatedRoot(
    `fiber-${outputMode}-prompt-permissions-${decision}-`,
  );
  const marker = join(root.workspace, `${decision}-marker.txt`);
  const stdoutPath = join(root.root, `${decision}.stdout`);
  writeFileSync(
    join(root.home, ".fiber", "settings.json"),
    JSON.stringify({ permission_mode: "ask", sandbox: "none" }),
  );
  writeFileSync(stdoutPath, "");
  const codex = startFakeCodex({
    route: (body) => {
      const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
      if (items.some((item) => item.type === "function_call_output")) {
        return codexFinalText(`${decision} ${outputMode} complete`);
      }
      return codexToolCall(`${decision}_${outputMode}_call`, "shell", {
        action: "run",
        command: `touch ${JSON.stringify(marker)}`,
        yield_time_ms: 30_000,
        timeout_ms: 600_000,
      });
    },
  });
  let session: TmuxSession | null = null;
  try {
    session = await TmuxSession.create({
      cmd: `${JSON.stringify(FIBER_BIN)} ask --${outputMode} --permission-mode ask --no-save "Run the exact ${outputMode} fixture." > ${JSON.stringify(stdoutPath)}`,
      cwd: root.workspace,
      env: permissionEnv(root.home, codex),
      remainOnExit: true,
    });
    const prompt = await session.waitForText("Approve? [y/N]", TIMEOUT);
    expect(prompt).toContain("fiber wants to run:");
    expect(existsSync(marker)).toBe(false);
    await session.sendText(decision === "approve" ? "y" : "n");
    await waitForPaneExit(session, 0);

    const stdout = readFileSync(stdoutPath, "utf8");
    expect(stdout).not.toContain("Approve? [y/N]");
    if (outputMode === "json") {
      const json = JSON.parse(stdout).data as FxJson;
      expect(json.exit_code).toBe(0);
      expect(json.tool_calls).toContainEqual(
        expect.objectContaining({
          name: "shell",
          status: decision === "approve" ? "success" : "error",
        }),
      );
    } else {
      expect(stdout).toBe("");
    }
    expect(existsSync(marker)).toBe(decision === "approve");
    expect(codex.requests).toHaveLength(2);
  } finally {
    if (session) await session.kill();
    codex.stop();
    rmSync(root.root, { recursive: true, force: true });
  }
}

describe("generic permission typed errors", () => {
  test(
    "returns typed JSON for denied terminal",
    async () => {
      const root = createIsolatedRoot("fiber-permission-error-");
      const marker = join(root.workspace, "denied-marker.txt");
      const toolCallId = "permission_denied_call";
      const codex = startFakeCodex({
        route: (body) => {
          const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
          if (items.some((item) => item.type === "function_call_output")) {
            return codexFinalText("permission error observed");
          }
          return codexToolCall(toolCallId, "shell", {
            action: "run",
            command: `touch ${JSON.stringify(marker)}`,
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
          });
        },
      });
      try {
        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({
            workspaces: {
              [root.workspace]: {
                permission: {
                  bash: {
                    "touch *denied-marker.txt*": "deny",
                  },
                },
              },
            },
          }),
        );

        const result = await runFx(["ask", "--json", "--no-save", "--permission-mode", "auto", "Run the denied command."], {
          cwd: root.workspace,
          env: permissionEnv(root.home, codex),
          timeoutMs: TIMEOUT,
        });
        const json = parseFxJson(result);
        expect(result.stderr).toBe('Running touch "./denied-marker.txt"\n');
        expect(json.tool_calls).toContainEqual({ name: "shell", status: "error" });
        expect(existsSync(marker)).toBe(false);
        expect(codex.requests).toHaveLength(2);

        const toolResult = JSON.parse(
          executionDeniedReason(codex.requests[1]!.body, toolCallId),
        ) as { error: PermissionEcho };
        const echo = toolResult.error;
        expect(echo.type).toBe("tool_permission_denied");
        expect(echo.tool_name).toBe("shell");
        expect(echo.message).toBe("Tool access was denied by configured policy");
        expect(echo.reason).toBe("policy_denied");
        expect(echo.denied).toBe(true);
      } finally {
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "JSON prompt-permissions approval and denial preserve stdout and exact execution",
    async () => {
      for (const decision of ["approve", "deny"] as const) {
        await runTtyPromptPermissionsCase("json", decision);
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "JSON prompt-permissions does not prompt after repeated advisory cautions",
    async () => {
      const root = createIsolatedRoot("fiber-json-auto-prompt-permissions-");
      const markers = Array.from(
        { length: 4 },
        (_, index) => join(root.workspace, `auto-marker-${index + 1}.txt`),
      );
      const stdoutPath = join(root.root, "auto.stdout");
      writeFileSync(
        join(root.home, ".fiber", "settings.json"),
        JSON.stringify({ permission_mode: "auto", sandbox: "none" }),
      );
      writeFileSync(stdoutPath, "");
      // The caution denial payload serializes transport-independently, so the
      // follow-up requests still carry the review_caution marker.
      let reviews = 0;
      const codex = startFakeCodex({
        route: (body) => {
          if (body.includes("<permission_review>")) {
            reviews += 1;
            return codexToolCall(`auto_review_${reviews}`, "permission_decision", {
              risk: "high",
              decision: "caution",
              rationale: "test fixture",
            });
          }
          const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
          const done = items.filter((item) => item.type === "function_call_output").length;
          if (done >= markers.length) {
            return codexFinalText("Advisory cautions handled normally.");
          }
          if (done > 0) expect(body).toContain("review_caution");
          const marker = markers[done]!;
          return codexToolCall(`auto_call_${done + 1}`, "shell", {
            action: "run",
            command: `touch ${JSON.stringify(marker)}`,
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
          });
        },
      });
      let session: TmuxSession | null = null;
      try {
        session = await TmuxSession.create({
          cmd: `${JSON.stringify(FIBER_BIN)} ask --permission-mode auto --json --no-save "Run the advisory caution fixture." > ${JSON.stringify(stdoutPath)}`,
          cwd: root.workspace,
          env: permissionEnv(root.home, codex),
          remainOnExit: true,
        });
        await waitForPaneExit(session, 0);
        const scrollback = await session.captureFullScrollback();
        expect(scrollback).not.toContain("Approve? [y/N]");
        for (const marker of markers) expect(existsSync(marker)).toBe(false);
        expect(
          codex.requests.filter((request) => request.body.includes("<permission_review>")),
        ).toHaveLength(4);

        const stdout = readFileSync(stdoutPath, "utf8");
        expect(stdout).not.toContain("Approve? [y/N]");
        const json = JSON.parse(stdout).data as FxJson;
        expect(json.output).toContain("Advisory cautions handled normally.");
        expect(json.tool_calls.filter((call) => call.status === "error")).toHaveLength(4);
        expect(json.tool_calls.filter((call) => call.status === "success")).toHaveLength(0);
        expect(codex.requests.filter((request) => !request.body.includes("<permission_review>"))).toHaveLength(5);
        expect(
          codex.requests.filter((request) => request.body.includes("<permission_review>")),
        ).toHaveLength(4);
      } finally {
        if (session) await session.kill();
        codex.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "quiet prompt-permissions approval and denial keep stdout empty",
    async () => {
      for (const decision of ["approve", "deny"] as const) {
        await runTtyPromptPermissionsCase("quiet", decision);
      }
    },
    TIMEOUT,
  );

  test(
    "JSON and quiet permission prompting remain fail-closed without a TTY or explicit opt in",
    async () => {
      const cases = [
        { mode: "json", args: ["--json"], optIn: false },
        { mode: "json", args: ["--json", "--permission-mode", "ask"], optIn: true },
        { mode: "quiet", args: ["--quiet"], optIn: false },
        { mode: "quiet", args: ["--quiet", "--permission-mode", "ask"], optIn: true },
      ] as const;

      for (const testCase of cases) {
        const root = createIsolatedRoot(
          `fiber-${testCase.mode}-${testCase.optIn ? "opt-in" : "default"}-non-tty-`,
        );
        const marker = join(root.workspace, "must-not-run.txt");
        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({ permission_mode: "ask", sandbox: "none" }),
        );
        const codex = startFakeCodex({
          route: (body) => {
            const items = (JSON.parse(body).input ?? []) as Array<{ type?: string }>;
            if (items.some((item) => item.type === "function_call_output")) {
              return codexFinalText("non-TTY fixture complete");
            }
            return codexToolCall("non_tty_call", "shell", {
              action: "run",
              command: `touch ${JSON.stringify(marker)}`,
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            });
          },
        });
        try {
          const result = await runFx(
            [
              "ask",
              ...testCase.args,
              "--no-save",
              "Run the non-TTY fixture.",
            ],
            {
              cwd: root.workspace,
              env: permissionEnv(root.home, codex),
              timeoutMs: TIMEOUT,
            },
          );

          expect(result.timedOut).toBe(false);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
          expect(result.stderr).not.toContain("Approve? [y/N]");
          if (testCase.mode === "json") {
            const json = JSON.parse(result.stdout).data as FxJson & {
              error: string;
            };
            expect(json.error).toBe("NonInteractivePermissionRequired");
          } else {
            expect(result.stdout).toBe("");
          }
          expect(codex.requests.filter((request) => !request.body.includes("<permission_review>"))).toHaveLength(1);
          expect(existsSync(marker)).toBe(false);
        } finally {
          codex.stop();
          rmSync(root.root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});
