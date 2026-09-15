import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexToolCall,
  seededFakeCodexEnv,
  startFakeCodex,
  writeSeededChatGptLogin,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
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

describe("web_fetch permission progress", () => {
  test(
    "default ask emits no native fetch progress before authentication",
    async () => {
      const result = await runWithoutCodexAuth([
        "ask",
        "--permission-mode", "auto",
        "fetch https://example.com/ and summarize it",
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("fiber needs a Codex subscription login for this model. Run fiber auth login codex.");
      expectNoFetchProgress(result.stderr);
    },
    TIMEOUT,
  );

  test(
    "admitted fetch emits native progress once authenticated",
    async () => {
      // Positive leg for the pre-auth negative above: with credentials
      // present the same tool call IS attempted (the follow-up model request
      // carries the tool result) and emits Fetching progress. The negative
      // therefore proves ordering (no progress before auth), not a broken
      // progress pipe. Only the progress line is asserted, never the fetch
      // outcome, so no live-network dependence beyond starting transport.
      const root = mkdtempSync(join(tmpdir(), "fiber-web-fetch-admitted-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      mkdirSync(join(home, ".fiber"), { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({ permission: { web_fetch: { "domain:example.com": "allow" } } }),
      );
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const codex = startFakeCodex({
        route: (body) =>
          JSON.parse(body).input?.some(
            (item: { type?: string }) => item.type === "function_call_output",
          )
            ? codexFinalText("fetch done")
            : codexToolCall("fetch_progress_1", "web_fetch", { url: "https://example.com/" }),
      });
      try {
        const result = await runFx(
          [
            "ask",
            "--permission-mode", "auto",
            "fetch https://example.com/ and summarize it",
          ],
          {
            cwd: workspace,
            env: seededFakeCodexEnv(home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        expect(codex.requests.length).toBeGreaterThanOrEqual(2);
        expect(result.stderr).toContain("Fetching ");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

});
