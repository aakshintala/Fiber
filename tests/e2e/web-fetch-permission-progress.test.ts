import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFx } from "../evals/eval-helpers";

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
      expect(result.stderr).toContain("fiber needs a Codex subscription login for this model. Run fiber login codex.");
      expectNoFetchProgress(result.stderr);
    },
    TIMEOUT,
  );

});
