import { afterEach, describe, expect, test } from "bun:test";
import { HAS_API_KEY } from "./eval-helpers";
import {
  hasEmptyComposer,
  isComposerLine,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const LIVE_SKIP = !tmuxAvailable() || !HAS_API_KEY;
const TIMEOUT = 30_000;
// Live agentic turns run tools and can stream for a minute or more.
const LIVE_TURN_TIMEOUT = 120_000;

let session: TmuxSession | null = null;

afterEach(async () => {
  if (session) { await session.kill(); session = null; }
});

describe.skipIf(LIVE_SKIP)("tui: key bindings", () => {
  test(
    "Ctrl+C twice exits the app",
    async () => {
      session = await TmuxSession.create();
      await session.waitForComposer(10_000);

      await session.sendKeys("C-c");
      await session.sendKeys("C-c");

      const exited = await session.waitForSessionEnd(5_000);
      expect(exited).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "Ctrl+C once during idle shows exit hint",
    async () => {
      session = await TmuxSession.create();
      await session.waitForComposer(10_000);

      await session.sendKeys("C-c");

      const pane = await session.waitForText(/ctrl\+c/i, TIMEOUT);
      expect(pane.toLowerCase()).toContain("ctrl+c");
    },
    TIMEOUT,
  );

  test(
    "Up arrow recalls previous input after clearing",
    async () => {
      session = await TmuxSession.create();
      await session.waitForComposer(10_000);

      await session.sendKeys("-l 'test-history-recall'");
      await session.sendKeys("Enter");
      // Poll for the live turn itself instead of a fixed sleep: Up must
      // recall from committed history after the response, and a sleep lets
      // a broken recall hide behind the still-visible submitted text.
      // Phase 1 proves the submission was accepted (turn started); phase 2
      // proves the response completed (turn done).
      await session.waitForPane(
        (pane) => /thinking/i.test(pane) || pane.includes("Streaming ("),
        TIMEOUT,
        { description: "live turn starts after submit" },
      );
      await session.waitForPane(
        (pane) =>
          hasEmptyComposer(pane) &&
          !/thinking/i.test(pane) &&
          !pane.includes("Streaming ("),
        LIVE_TURN_TIMEOUT,
        { description: "live turn completes" },
      );

      // Assert composer content, not whole-pane containment: the submitted
      // text stays in the transcript regardless, so a whole-pane assert
      // passes even when Up-recall is broken. Note a plain composer-line
      // match also hits the transcript's own user-message row, so require the
      // post-Up delta: exactly one more hit than before Up was pressed.
      const recallHits = (pane: string): number =>
        pane.split("\n").filter((line) =>
          isComposerLine(line) && line.includes("test-history-recall")
        ).length;
      const before = recallHits(await session.capturePane());
      await session.sendKeys("Up");
      const recalled = await session.waitForPane(
        (pane) => recallHits(pane) === before + 1,
        TIMEOUT,
        { description: "Up recalls previous input into the composer" },
      );
      expect(recallHits(recalled)).toBe(before + 1);
    },
    // 2x the sequential sum: 10 + 30 + 120 + 30 = 190s of internal waits.
    TIMEOUT * 7,
  );
});
