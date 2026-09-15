import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(stderrPath, "");
      codex = startFakeCodex({ route: () => codexFinalText(RESPONSE_TEXT) });

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        env: seededFakeCodexEnv(home, codex, {
          FIBER_PERMISSION_MODE: "auto",
        }),
      });
      await session.waitForComposer(10_000);

      await session.sendText("What is 2+2? Reply with just the number.");

      const pane = await session.waitForText(RESPONSE_TEXT, 60_000);
      expect(pane).toContain(RESPONSE_TEXT);
      // Pin the causal path: the answer must arrive via at least one model
      // turn, not an echo or cached render, and auto mode must not surface
      // an approval prompt for this tool-free response. The prompt renders
      // in the footer viewport, so assert on the pane, not the scrollback.
      expect(codex!.requests.length).toBeGreaterThanOrEqual(1);
      expect(pane).not.toContain("Choose now");
      expect(pane).not.toContain("Allow once");
      expect(pane).not.toContain("allow this action");
      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain(RESPONSE_TEXT);
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await session.sendText("/quit");
      expect(await session.waitForSessionEnd(10_000)).toBe(true);
    },
    // 2x the sequential sum: 10 + 60 + 10 = 80s of internal waits.
    TIMEOUT * 3,
  );
});
