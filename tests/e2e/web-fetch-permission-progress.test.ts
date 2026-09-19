import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "./eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexToolCall,
  seededFakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

// runFx resolves on child `close` (eval-helpers.ts), which Node emits only
// after stdout and stderr have ended. A negative progress check is therefore
// not racing a drain. The #402 flake was bun's 15s test deadline matching
// that kill timer: a loaded macOS runner aborted with `timed out at 15000ms`
// before close, then passed on retry. bun's budget must stay strictly above
// the process budget so the login-required stderr is observed in full.
const ASK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;
const LOGIN_REQUIRED =
  "fiber needs a Codex subscription login for this model. Run fiber auth login codex.";
const NO_CODEX_AUTH = {
  FIBER_DISABLE_KEYCHAIN: "1",
};

async function runWithoutCodexAuth(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "fiber-web-fetch-no-auth-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  try {
    return await runFx(args, {
      cwd: workspace,
      env: { ...NO_CODEX_AUTH, HOME: home },
      timeoutMs: ASK_TIMEOUT_MS,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectNoFetchProgress(stderr: string) {
  expect(stderr).not.toContain("Fetching ");
  expect(stderr).not.toContain("Converting ");
  expect(stderr).not.toContain("Extracting ");
}

function expectAuthFailureWithoutFetchProgress(
  result: Awaited<ReturnType<typeof runFx>>,
) {
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(LOGIN_REQUIRED);
  expectNoFetchProgress(result.stderr);
}

describe("web_fetch permission progress", () => {
  test(
    "default ask emits no native fetch progress before authentication",
    async () => {
      const result = await runWithoutCodexAuth([
        "ask",
        "--permission-mode", "auto",
        "fetch http://localhost/ and summarize it",
      ]);

      expectAuthFailureWithoutFetchProgress(result);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "admitted fetch is attempted once authenticated",
    async () => {
      // Positive leg for the pre-auth negative above: with credentials
      // present the same tool call IS admitted and attempted — the follow-up
      // model request carries the tool result. The URL is rejected by local
      // URL policy (localhost is non-public) before progress emission or
      // transport, so this leg performs zero network I/O by construction:
      // no live host appears anywhere in the test. The allow rule keeps the
      // leg order-agnostic (permission-first or validation-first both end
      // in the same local rejection). Progress rendering itself is pinned
      // by unit tests (tool_presentation Fetching snapshot); here the
      // admission trace (a later request carrying function_call_output) is
      // what proves the negative is about pre-auth ordering, not a dead tool.
      const root = mkdtempSync(join(tmpdir(), "fiber-web-fetch-admitted-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      mkdirSync(join(home, ".fiber"), { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({ permission: { web_fetch: { "domain:localhost": "allow" } } }),
      );
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const codex = startFakeCodex({
        route: (body) =>
          JSON.parse(body).input?.some(
            (item: { type?: string }) => item.type === "function_call_output",
          )
            ? codexFinalText("fetch done")
            : codexToolCall("fetch_progress_1", "web_fetch", { url: "http://localhost/" }),
      });
      try {
        const result = await runFx(
          [
            "ask",
            "--permission-mode", "auto",
            "fetch http://localhost/ and summarize it",
          ],
          {
            cwd: workspace,
            env: seededFakeCodexEnv(home, codex),
            timeoutMs: ASK_TIMEOUT_MS,
          },
        );

        expect(result.timedOut).toBe(false);
        expect(codex.requests.length).toBeGreaterThanOrEqual(2);
        expect(
          codex.requests.some((request) =>
            JSON.parse(request.body).input?.some(
              (item: { type?: string }) => item.type === "function_call_output",
            ),
          ),
        ).toBe(true);
        // Local policy rejects before progress emission, so no Fetching
        // progress — and no transport — could have occurred.
        expectNoFetchProgress(result.stderr);
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

});
