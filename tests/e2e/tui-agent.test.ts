import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexFinalText,
  seededFakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const SKIP = !tmuxAvailable();
const TIMEOUT = 60_000;
const RESPONSE_TEXT = "AGENT_PROMPT_ANSWER";

let session: TmuxSession | null = null;
let codex: ReturnType<typeof startFakeCodex> | null = null;
let root: string | null = null;

afterEach(async () => {
  if (session) { await session.kill(); session = null; }
  codex?.stop();
  codex = null;
  if (root) { rmSync(root, { recursive: true, force: true }); root = null; }
});

describe.skipIf(SKIP)("tui: agent prompt", () => {
  test(
    "agent responds to a simple question",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-agent-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      codex = startFakeCodex({ route: () => codexFinalText(RESPONSE_TEXT) });

      session = await TmuxSession.create({
        cwd: workspace,
        env: seededFakeCodexEnv(home, codex, {
          FIBER_PERMISSION_MODE: "auto",
        }),
      });
      await session.waitForComposer(10_000);

      await session.sendText("What is 2+2? Reply with just the number.");

      const pane = await session.waitForText(RESPONSE_TEXT, 60_000);
      expect(pane).toContain(RESPONSE_TEXT);
    },
    TIMEOUT,
  );
});
