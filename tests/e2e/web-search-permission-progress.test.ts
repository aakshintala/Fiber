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
  const root = mkdtempSync(join(tmpdir(), "fiber-web-search-no-auth-"));
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

function expectNoSearchProgress(stderr: string) {
  // Match the bare verb: the rendered line is `● Searching` with no
  // trailing detail, so "Searching " (trailing space) would pass even
  // while progress is emitted.
  expect(stderr).not.toContain("Searching");
  expect(stderr).not.toContain("Found ");
}

describe("web_search permission progress", () => {
  test(
    "default ask emits no native search progress before authentication",
    async () => {
      const result = await runWithoutCodexAuth([
        "ask",
        "--permission-mode", "auto",
        "search the web for current news",
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("fiber needs a Codex subscription login for this model. Run fiber auth login codex.");
      expectNoSearchProgress(result.stderr);
    },
    TIMEOUT,
  );

  test(
    "admitted search emits native progress once authenticated",
    async () => {
      // Positive leg for the pre-auth negative above: with credentials
      // present the same tool call IS attempted (the follow-up model request
      // carries the tool result) and emits Searching progress. The negative
      // therefore proves ordering (no progress before auth), not a broken
      // progress pipe. Only the progress line and the attempt are asserted,
      // never the search outcome, so no search backend is needed.
      const root = mkdtempSync(join(tmpdir(), "fiber-web-search-admitted-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      mkdirSync(join(home, ".fiber"), { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({ permission: { web_search: { "*": "allow" } } }),
      );
      writeSeededChatGptLogin(home, chatGptAccessToken());
      const codex = startFakeCodex({
        route: (body) =>
          JSON.parse(body).input?.some(
            (item: { type?: string }) => item.type === "function_call_output",
          )
            ? codexFinalText("search done")
            : codexToolCall("search_progress_1", "web_search", { query: "current news" }),
      });
      try {
        const result = await runFx(
          [
            "ask",
            "--permission-mode", "auto",
            "search the web for current news",
          ],
          {
            cwd: workspace,
            env: seededFakeCodexEnv(home, codex),
            timeoutMs: TIMEOUT,
          },
        );

        expect(codex.requests.length).toBeGreaterThanOrEqual(2);
        expect(result.stderr).toContain("Searching");
      } finally {
        codex.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "help does not print the ordinary tool inventory",
    async () => {
      const result = await runFx(["--help"]);

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("web_search");
    },
    TIMEOUT,
  );
});
