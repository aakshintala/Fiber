import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, runFx } from "./eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexSerializedToolCall,
  codexToolCall,
  fakeCodexModelsPayload,
  FAKE_CODEX_DEFAULT_MODEL,
  hasEmptyComposer,
  isEmptyComposerLine,
  isVolatileTokenStatusRow,
  paneExitMatches,
  seededFakeCodexEnv,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";
import { readTapeFrames } from "./render-lab/tape";
import {
  TIMEOUT,
  codexEventLines,
  codexSse,
  countOccurrences,
  createCodexStreamCtx,
  fakeShellRun,
  parseReplayData,
  sessionIdFromHome,
  shellQuote,
  startCodexQueue,
  streamedTextResponse,
  stripAnsi,
  waitForCondition,
  waitForQuiescentReplay,
  waitForScrollback,
  waitForScrollbackMarkers,
  waitForSessionPickerClosed,
  normalizeVolatileStatusRows,
} from "./tui-resume-helpers";

test.skipIf(!tmuxAvailable())(
  "saved fiber ask metadata appears after interactive Ctrl-O resume",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-ask-metadata-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const prompt = "Persist this fiber ask metadata.";
    const answer = "FIBER_ASK_METADATA_COMPLETE";
    const askGateway = startCodexQueue([codexFinalText(answer)]);
    let active: TmuxSession | null = null;
    try {
      const ask = await runFx(["ask", "--json", "--permission-mode", "auto", prompt], {
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, askGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        timeoutMs: TIMEOUT,
      });
      expect(ask.code).toBe(0);
      // Seeded settings carry the inert legacy `sandbox` key, which issue #26
      // reports as an unknown-config-key diagnostic on stderr.
      expect(ask.stderr).toBe(
        "fiber ask: config user: unknown_config_key; key=sandbox; unknown configuration key; check the spelling or remove it\n",
      );
      expect(JSON.parse(ask.stdout).data.session_id).toBeTruthy();

      const resumeGateway = startCodexQueue([]);
      try {
        active = await TmuxSession.create({
          cmd: `${FIBER_BIN} continue`,
          cwd: realpathSync(workspace),
          env: seededFakeCodexEnv(home, resumeGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          stderrPath,
          width: 100,
          height: 32,
          startupWaitMs: 0,
        });
        await active.waitForComposer(TIMEOUT);
        await active.waitForText(answer, TIMEOUT);
        await active.sendKeys("C-o");
        const full = await active.waitForPane(
          (pane) =>
            pane.includes("Full detail · ctrl o close") &&
            pane.includes("UTC · Usage") &&
            /\(↑\d+ ↓2\)/.test(pane),
          TIMEOUT,
        );
        expect(full).toContain(prompt);
        expect(full).toContain(answer);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      } finally {
        if (active) await active.kill();
        resumeGateway.stop();
      }
    } finally {
      askGateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "session resume command group opens last and explicit session ids",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-session-resume-command-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const seedStderrPath = join(root, "seed-stderr.log");
    const exactStderrPath = join(root, "exact-stderr.log");
    const lastStderrPath = join(root, "last-stderr.log");
    const title = "Save the grouped session resume fixture.";
    const marker = "GROUPED_SESSION_RESUME_FIXTURE";
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(seedStderrPath, "");
    writeFileSync(exactStderrPath, "");
    writeFileSync(lastStderrPath, "");

    const seedGateway = startCodexQueue([codexFinalText(marker)]);
    const resumeGateway = startCodexQueue([]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, seedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: seedStderrPath,
        width: 100,
        height: 30,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText(title);
      await active.waitForText(marker, TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd(TIMEOUT)).toBe(true);
      await active.kill();
      active = null;

      const sessionId = sessionIdFromHome(home);
      const cases = [
        {
          command: `${FIBER_BIN} session resume --id ${sessionId}`,
          stderrPath: exactStderrPath,
        },
        {
          command: `${FIBER_BIN} session resume last`,
          stderrPath: lastStderrPath,
        },
      ];
      for (const resumeCase of cases) {
        active = await TmuxSession.create({
          cmd: resumeCase.command,
          cwd: realpathSync(workspace),
          env: seededFakeCodexEnv(home, resumeGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          stderrPath: resumeCase.stderrPath,
          width: 100,
          height: 30,
          startupWaitMs: 0,
        });
        const resumed = await waitForScrollbackMarkers(
          active,
          [`● Session resumed: ${title}`, marker],
          TIMEOUT,
        );
        expect(resumed).toContain(marker);
        expect(active.isPaneAlive()).toBe(true);
        expect(readFileSync(resumeCase.stderrPath, "utf8")).toBe("");
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd(TIMEOUT)).toBe(true);
        await active.kill();
        active = null;
      }

      expect(seedGateway.requests).toHaveLength(1);
      expect(resumeGateway.requests).toHaveLength(0);
      expect(readFileSync(seedStderrPath, "utf8")).toBe("");
    } finally {
      if (active) await active.kill();
      seedGateway.stop();
      resumeGateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

function expectAltExitToPreserveNormalViewport(tapePath: string): void {
  const tape = readFileSync(tapePath);
  const leaveAlternate = Buffer.from("\x1b[?1049l");
  const leaveOffset = tape.lastIndexOf(leaveAlternate);
  expect(leaveOffset).toBeGreaterThanOrEqual(0);

  const bytesAfterExit = tape.subarray(leaveOffset + leaveAlternate.length);
  const synchronizedEnd = Buffer.from("\x1b[?2026l");
  const firstFrameEnd = bytesAfterExit.indexOf(synchronizedEnd);
  const firstNormalFrame = firstFrameEnd >= 0
    ? bytesAfterExit.subarray(0, firstFrameEnd + synchronizedEnd.length)
    : bytesAfterExit;
  expect(firstNormalFrame.includes(Buffer.from("\x1b[1;1H\x1b[2K"))).toBe(false);
}

test.skipIf(!tmuxAvailable())(
  "approved-shell command output normalizes controls in Ctrl-O and resume views",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-command-output-terminal-safety-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const resumedStderrPath = join(root, "resumed-stderr.log");
    const tracePath = join(root, "trace.log");
    const tapePath = join(root, "command-output-terminal-safety.fibertape");
    const scriptPath = join(workspace, "command-output-controls.sh");
    const ansiMarker = "ANSI_RED_TOKEN";
    const crMarker = "CR_DONE";
    const splitMarker = "éSPLIT_UTF8_DONE";
    const trailingMarker = "BOUNDARY_TRAILING";
    const literalClose = "LITERAL_CLOSE_</stdout>";
    const doneMarker = "CONTROL_OUTPUT_DONE";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");
    writeFileSync(resumedStderrPath, "");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
printf '\\033[31m${ansiMarker}\\033[0m\\n'
printf 'CR_STAGE_01\\r${crMarker}\\n'
printf 'TAB\\tSTOP\\n'
printf 'NUL:\\000:END\\n'
printf 'INVALID:\\377:END\\n'
printf '  BOUNDARY_LEADING  \\n'
printf '\\n'
printf '${literalClose}\\n'
awk 'BEGIN { for (i = 0; i < 4095; i++) printf "x" }'
printf '\\303'
sleep 0.2
printf '\\251SPLIT_UTF8_DONE\\n'
printf '${trailingMarker}   '
`,
    );
    chmodSync(scriptPath, 0o755);

    const gateway = startCodexQueue([
      fakeShellRun("terminal-safety-command", "./command-output-controls.sh"),
      codexFinalText(doneMarker),
    ]);
    let active: TmuxSession | null = null;
    let resumedGateway: ReturnType<typeof startCodexQueue> | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,core,tool,render,transcript,command_output,session",
        },
        stderrPath,
        width: 72,
        height: 24,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared command.");
      const compact = await waitForScrollback(active, doneMarker);
      expect(compact).toContain("● 1 tool call · 1 command");
      expect(compact).toContain("└ Ran ./command-output-controls.sh");
      expect(compact).not.toContain(`│ ${ansiMarker}`);
      expect(compact).not.toContain(`│ ${crMarker}`);
      expect(compact).not.toContain("│ TAB");
      expect(compact).not.toContain("│ NUL:\\x00:END");
      expect(compact).not.toContain("│ INVALID:\\xff:END");
      expect(compact).not.toContain("CR_STAGE_01");
      expect(compact).not.toContain("\\x0d");
      expect(compact).not.toContain("\\x1b[31m");
      expect(compact).not.toContain("BOUNDARY_LEADING");
      expect(compact).not.toContain(splitMarker);
      expect(compact).not.toContain(trailingMarker);
      expect(compact).not.toContain("lines more (ctrl o to view)");
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
      expect(readFileSync(tracePath, "utf8")).toContain("route=approved_shell");

      await active.waitForPane(
        (pane) => pane.includes(doneMarker) && !pane.includes("Streaming ("),
        TIMEOUT,
      );
      const compactGrid = await active.capturePaneGrid();
      await active.resizeWindow(48, 24);
      const narrow = await active.waitForText(doneMarker, TIMEOUT);
      expect(narrow).not.toContain(`│ ${ansiMarker}`);
      expect(narrow).not.toContain(trailingMarker);
      await active.resizeWindow(72, 24);
      await active.waitForText(doneMarker, TIMEOUT);
      expect(normalizeVolatileStatusRows(
        await active.waitForStableGrid(compactGrid, normalizeVolatileStatusRows, TIMEOUT),
      )).toEqual(
        normalizeVolatileStatusRows(compactGrid),
      );

      const tape = readFileSync(tapePath);
      expect(tape.includes(Buffer.from(`│ ${ansiMarker}`))).toBe(false);
      expect(tape.includes(Buffer.from(`\x1b[31m${ansiMarker}`))).toBe(false);
      expect(tape.includes(Buffer.from(`NUL:\x00:END`))).toBe(false);
      expect(tape.includes(Buffer.from([0x49, 0x4e, 0x56, 0x41, 0x4c, 0x49, 0x44, 0x3a, 0xff])))
        .toBe(false);

      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendHexBytes(
        Array.from({ length: 80 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.waitForText(trailingMarker, TIMEOUT);
      const fullTail = await active.capturePane();
      expect(fullTail).toContain(splitMarker);
      expect(fullTail).toContain(trailingMarker);
      expect(fullTail).not.toContain("lines more (ctrl o");
      // The Config notice for the seeded `sandbox` key adds startup rows above
      // the retained output, pushing the output head below the top viewport
      // fold: page to the top, then step back down until both head markers
      // are visible. The wheel-down event is the same row step the viewport
      // walk below uses, so fullHead lands where that walk expects it.
      await active.sendHexBytes(
        Array.from({ length: 120 }, () => ["1b", "5b", "35", "7e"]).flat(),
      );
      for (let step = 0; step < 10; step += 1) {
        const viewport = await active.capturePane();
        if (viewport.includes(ansiMarker) && viewport.includes(crMarker)) break;
        await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
        await active.waitForPane((pane) => pane !== viewport, TIMEOUT);
      }
      await active.waitForText(ansiMarker, TIMEOUT);
      const fullHead = await active.capturePane();
      expect(fullHead).toContain("Config: 1 configuration issue");
      expect(fullHead).toContain(ansiMarker);
      expect(fullHead).toContain(crMarker);
      expect(fullHead).not.toContain("CR_STAGE_01");
      expect(fullHead).not.toContain("\\x1b[31m");
      await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      const invalidViewport = await active.waitForPane(
        (pane) => pane !== fullHead && pane.includes("INVALID:\\xff:END"),
        TIMEOUT,
      );
      expect(invalidViewport).toContain("NUL:\\x00:END");
      expect(invalidViewport).not.toContain("\\x1b[31m");
      await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      const boundaryViewport = await active.waitForPane(
        (pane) => pane !== invalidViewport && pane.includes("BOUNDARY_LEADING"),
        TIMEOUT,
      );
      expect(boundaryViewport).toContain("BOUNDARY_LEADING");
      await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      const literalViewport = await active.waitForPane(
        (pane) => pane !== boundaryViewport && pane.includes(literalClose),
        TIMEOUT,
      );
      expect(literalViewport.match(/<\/stdout>/g)).toHaveLength(1);
      expect(literalViewport).not.toContain("<stdout>");
      await active.sendKeys("C-o");
      await active.waitForText(doneMarker, TIMEOUT);
      expect(normalizeVolatileStatusRows(
        await active.waitForStableGrid(compactGrid, normalizeVolatileStatusRows, TIMEOUT),
      )).toEqual(
        normalizeVolatileStatusRows(compactGrid),
      );

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd(TIMEOUT)).toBe(true);
      await active.kill();
      active = null;

      resumedGateway = startCodexQueue([]);
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: resumedStderrPath,
        width: 72,
        height: 24,
        startupWaitMs: 0,
      });
      await active.waitForText(doneMarker, TIMEOUT);
      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendHexBytes(
        Array.from({ length: 80 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.waitForText(trailingMarker, TIMEOUT);
      const resumedTail = await active.capturePane();
      expect(resumedTail).toContain(splitMarker);
      expect(resumedTail).toContain(trailingMarker);
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");

      const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      expect(replay.stdout).toContain(ansiMarker);
      expect(replay.stdout).toContain("NUL:\\x00:END");
      expect(replay.stdout).toContain("INVALID:\\xff:END");
      expect(replay.stdout).toContain(splitMarker);
      expect(replay.stdout).toContain(trailingMarker);
      expect(replay.stdout).toContain(doneMarker);
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      resumedGateway?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O opens full retained command output and restores grouped compact output",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o.fibertape");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const tailMarker = "FULL_CTRL_O_LINE_0100";
    const commandArgumentTail = "FULL_CTRL_O_COMMAND_ARGUMENT_TAIL";
    const command =
      "awk 'BEGIN { for (i = 1; i <= 100; i++) printf \"FULL_CTRL_O_LINE_%04d\\n\", i }'" +
      ` # ${"argument-padding-".repeat(8)}${commandArgumentTail}`;
    const gateway = startCodexQueue([
      fakeShellRun("ctrl-o-command", command),
      codexFinalText("FULL_CTRL_O_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: tapePath },
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared command.");
      const compact = await waitForScrollback(active, "FULL_CTRL_O_DONE");
      expect(compact).toContain("● 1 tool call · 1 command");
      expect(compact).not.toContain("lines more (ctrl o to view)");
      expect(compact).not.toContain(tailMarker);
      await active.waitForPane(
        (pane) => pane.includes("FULL_CTRL_O_DONE") && !pane.includes("Streaming ("),
        TIMEOUT,
      );
      const compactGrid = await active.capturePaneGrid();

      await active.sendKeys("C-o");
      await active.waitForText("Full detail · ctrl o close · PgUp/PgDn scroll · Esc close", TIMEOUT);
      const expandedAtTail = await active.waitForText(tailMarker, TIMEOUT);
      expect(expandedAtTail).toContain(tailMarker);
      expect(expandedAtTail).not.toContain("FULL_CTRL_O_LINE_0001");

      for (let page = 0; page < 20; page += 1) {
        const before = await active.capturePane();
        if (
          before.includes("FULL_CTRL_O_LINE_0001") &&
          /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC · Tool/.test(before)
        ) break;
        await active.sendKeys("PPage");
        await active.waitForPane((pane) => pane !== before, TIMEOUT);
      }
      const expandedAtHead = await active.waitForText("command: awk", TIMEOUT);
      expect(expandedAtHead).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC · Tool/);
      expect(expandedAtHead).toContain(commandArgumentTail);
      expect(expandedAtHead).toContain("FULL_CTRL_O_LINE_0001");
      expect(expandedAtHead).not.toContain(tailMarker);

      for (let page = 0; page < 20; page += 1) {
        const before = await active.capturePane();
        if (before.includes(tailMarker)) break;
        await active.sendKeys("NPage");
        await active.waitForPane((pane) => pane !== before, TIMEOUT);
      }
      await active.waitForText(tailMarker, TIMEOUT);
      const full = await active.capturePane();
      expect(full).toContain(tailMarker);
      expect(full).not.toContain("lines more (ctrl o");
      expect(full).toContain("Full detail · ctrl o close · PgUp/PgDn scroll · Esc close");

      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      const afterPageUp = await active.waitForPane(
        (pane) =>
          pane !== full &&
          !pane.includes(tailMarker) &&
          /FULL_CTRL_O_LINE_\d{4}/.test(pane),
        TIMEOUT,
      );
      await active.sendHexBytes(["1b", "5b", "36", "7e"]);
      const tailAfterPageDown = await active.waitForText(tailMarker, TIMEOUT);

      for (let i = 0; i < 12; i += 1) {
        await active.sendHexBytes(["1b", "5b", "3c", "36", "34", "3b", "31", "3b", "31", "4d"]);
      }
      await active.waitForPane(
        (pane) =>
          pane !== tailAfterPageDown &&
          !pane.includes(tailMarker) &&
          /FULL_CTRL_O_LINE_\d{4}/.test(pane),
        TIMEOUT,
      );
      for (let i = 0; i < 12; i += 1) {
        await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      }
      await active.waitForText(tailMarker, TIMEOUT);

      await active.sendKeys("C-o");
      await active.waitForText("● 1 tool call · 1 command", TIMEOUT);
      // Settle fence before the absence asserts: the overlay close is
      // async, so wait for the grid to return to the compact snapshot.
      // A slow close must time out here, not slip past the negatives on a
      // torn frame.
      await active.waitForStableGrid(
        compactGrid,
        normalizeVolatileStatusRows,
        TIMEOUT,
      );
      const restored = await active.capturePane();
      const restoredScrollback = await active.captureFullScrollback();
      expect(restored).not.toContain("lines more (ctrl o to view)");
      expect(restored).not.toContain(tailMarker);
      expect(normalizeVolatileStatusRows(await active.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(compactGrid),
      );
      expect(countOccurrences(restoredScrollback, "FULL_CTRL_O_DONE")).toBe(1);
      expectAltExitToPreserveNormalViewport(tapePath);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  // Covers the added settle fence on top of the existing waits.
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "cap-crossing command output stays durable while grouped compact returns to input",
  async () => {
    const timeout = 120_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-command-output-cap-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    const tapePath = join(root, "command-output-cap.fibertape");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const lineCount = 12_000;
    const padding = "X".repeat(96);
    const tailIndex = String(lineCount).padStart(5, "0");
    const stdoutTail = `CAP_STDOUT_${tailIndex}_${padding}`;
    const stderrTail = `CAP_STDERR_${tailIndex}_${padding}`;
    const command =
      `awk 'BEGIN { pad="${padding}"; for (i = 1; i < ${lineCount}; i++) { ` +
      `printf "CAP_STDOUT_%05d_%s\\n", i, pad; ` +
      `printf "CAP_STDERR_%05d_%s\\n", i, pad > "/dev/stderr" } }'; ` +
      `printf '${stdoutTail}\\n'; sleep 0.05; printf '${stderrTail}\\n' >&2`;
    const finalMarker = "CAP_CROSSING_DONE";
    const gateway = startCodexQueue([
      fakeShellRun("cap-crossing-command", command),
      codexFinalText(finalMarker),
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,tool,worker,render,transcript,command_output",
        },
        stderrPath,
        width: 160,
        height: 200,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared cap-crossing command.");
      const compact = await waitForScrollback(active, finalMarker, timeout);
      expect(compact).toContain("● 1 tool call · 1 command");
      expect(compact).not.toContain("lines more (ctrl o to view)");
      expect(compact).not.toContain(stdoutTail);
      expect(compact).not.toContain(stderrTail);

      await active.sendText("/status");
      // Assert full row shapes: /model|permission_mode/ also matches error
      // text that merely mentions "model" (e.g. the missing-auth help),
      // so require the Status block's key=value rows.
      const status = await active.waitForPane(
        (pane) =>
          /Status: model=\S+/.test(pane) &&
          /^\s+permission_mode=\S+/m.test(pane),
        TIMEOUT,
        { description: "full /status rows" },
      );
      expect(status).toMatch(/Status: model=\S+/);
      expect(status).toMatch(/^\s+permission_mode=\S+/m);
      expect(active.paneStatus()).toEqual({ dead: false, status: null });
      const sessionId = sessionIdFromHome(home);

      const commandDir = join(home, ".fiber", "sessions", sessionId, "logs", "commands");
      const artifactFiles = readdirSync(commandDir);
      const replayFiles = artifactFiles.filter((name) => name.endsWith(".bin"));
      expect(replayFiles).toHaveLength(1);
      const replayBytes = await waitForQuiescentReplay(join(commandDir, replayFiles[0]!));
      expect(replayBytes.byteLength).toBeGreaterThan(1024 * 1024);
      expect(replayBytes.includes(Buffer.from(stdoutTail))).toBe(true);
      expect(replayBytes.includes(Buffer.from(stderrTail))).toBe(true);

      const replay = await runFx(["debug", "replay", tapePath, "--json"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      const replayJson = parseReplayData(replay.stdout);
      expect(replayJson.frame_count).toBeGreaterThan(0);
      expect(replayJson.stdout_bytes).toBeGreaterThan(0);
      expect(readFileSync(tracePath, "utf8")).toContain(
        "command output retention cap reached",
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(gateway.requests).toHaveLength(2);
      passed = true;
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained cap-crossing artifacts at ${root}`);
      }
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "active command overflow marks Ctrl-O incomplete until terminal replay attaches",
  async () => {
    const timeout = 120_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-command-output-active-overflow-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    const scriptPath = join(workspace, "active-overflow.sh");
    const readyPath = join(workspace, ".active-overflow-ready");
    const continuePath = join(workspace, ".active-overflow-continue");
    const continuedReadyPath = join(workspace, ".active-overflow-continued-ready");
    const releasePath = join(workspace, ".active-overflow-release");
    const historicalSentinel = "ACTIVE_OVERFLOW_HISTORICAL_SENTINEL";
    const historyTailMarker = "ACTIVE_OVERFLOW_HISTORY_080";
    const stableMarker = "ACTIVE_OVERFLOW_STABLE_HEAD";
    const unstableMarker = "ACTIVE_OPEN_000000";
    const continuedMarker = "ACTIVE_OVERFLOW_LIVE_CONTINUATION";
    const tailMarker = "ACTIVE_OVERFLOW_TAIL";
    const doneMarker = "ACTIVE_OVERFLOW_DONE";
    const futureMarker = "│ … full output available when command finishes";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
printf '${stableMarker}\\n'
awk 'BEGIN { for (i = 0; i < 60000; i++) printf "ACTIVE_OPEN_%06d ", i }'
: > .active-overflow-ready
while [ ! -f .active-overflow-continue ]; do sleep 0.02; done
printf '\\n${continuedMarker}\\n'
sleep 0.2
: > .active-overflow-continued-ready
while [ ! -f .active-overflow-release ]; do sleep 0.02; done
printf '${tailMarker}\\n'
`,
    );
    chmodSync(scriptPath, 0o755);

    const historicalRows = Array.from({ length: 80 }, (_, index) =>
      index === 4
        ? historicalSentinel
        : `ACTIVE_OVERFLOW_HISTORY_${String(index + 1).padStart(3, "0")}`
    );
    const gateway = startCodexQueue([
      codexFinalText(historicalRows.join("\n")),
      fakeShellRun("active-overflow-command", "./active-overflow.sh"),
      codexFinalText(doneMarker),
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES:
            "agent,core,tool,worker,render,transcript,command_output,transcript_retention,session",
        },
        stderrPath,
        width: 80,
        height: 28,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Seed the prepared historical transcript.");
      await active.waitForText(historyTailMarker, timeout);
      await active.sendText("Run the prepared active overflow command.");
      await waitForCondition(
        () => existsSync(readyPath),
        "the active overflow command readiness file",
        timeout,
      );
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("command output retention cap reached"),
        "the active command structured-retention overflow",
        timeout,
      );
      const activeCompact = await active.waitForPane(
        (pane) =>
          pane.includes("Running ./active-overflow.sh") &&
          !pane.includes(stableMarker),
        timeout,
      );
      const compactOutputRows = activeCompact.split("\n").filter((line) =>
        line.trimStart().startsWith("│ ") && !line.includes("ctrl o to view")
      );
      expect(compactOutputRows).toHaveLength(0);
      expect(activeCompact).not.toContain(tailMarker);
      expect(activeCompact.match(/Running \.\/active-overflow\.sh/g)).toHaveLength(1);

      await active.sendKeys("C-o");
      await active.waitForText(futureMarker, timeout);
      const partialFull = await active.capturePane();
      expect(partialFull).toContain(stableMarker);
      expect(partialFull).toContain(futureMarker);
      expect(partialFull).not.toContain(unstableMarker);
      expect(partialFull).not.toContain(tailMarker);

      await active.sendHexBytes(
        Array.from({ length: 8 }, () => ["1b", "5b", "35", "7e"]).flat(),
      );
      await active.waitForText(historicalSentinel, timeout);
      const scrolledHistory = (await active.capturePaneGrid()).filter((row) =>
        row.includes("ACTIVE_OVERFLOW_HISTORY_") || row.includes(historicalSentinel)
      );
      expect(scrolledHistory.length).toBeGreaterThan(5);

      writeFileSync(continuePath, "continue\n");
      await waitForCondition(
        () => existsSync(continuedReadyPath),
        "more active output while Ctrl-O is scrolled",
        timeout,
      );
      await active.waitForText(historicalSentinel, timeout);
      const historyAfterMoreOutput = (await active.capturePaneGrid()).filter((row) =>
        row.includes("ACTIVE_OVERFLOW_HISTORY_") || row.includes(historicalSentinel)
      );
      expect(historyAfterMoreOutput).toEqual(scrolledHistory);

      await active.sendHexBytes(
        Array.from({ length: 8 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.waitForText(futureMarker, timeout);
      await active.sendKeys("Escape");
      await active.waitForPane(
        (pane) =>
          pane.includes("Running ./active-overflow.sh") &&
          !pane.includes(stableMarker) &&
          !pane.includes(futureMarker),
        timeout,
      );
      writeFileSync(releasePath, "release\n");
      await active.waitForText(doneMarker, timeout);
      await waitForCondition(
        () => gateway.requests.length === 3,
        "the post-command Gateway continuation",
        timeout,
      );

      const terminalCompact = await active.capturePane();
      expect(terminalCompact).toContain("Ran ./active-overflow.sh");
      expect(terminalCompact).not.toContain(stableMarker);
      expect(terminalCompact).not.toContain("lines more (ctrl o");
      expect(terminalCompact).not.toContain(tailMarker);
      expect(terminalCompact).not.toContain(futureMarker);
      const sessionId = sessionIdFromHome(home);
      const commandDir = join(home, ".fiber", "sessions", sessionId, "logs", "commands");
      const replayFiles = readdirSync(commandDir).filter((name) =>
        name.endsWith(".bin")
      );
      expect(replayFiles).toHaveLength(1);
      const replayBytes = await waitForQuiescentReplay(join(commandDir, replayFiles[0]!));
      expect(replayBytes.byteLength).toBeGreaterThan(1024 * 1024);
      expect(replayBytes.includes(Buffer.from(stableMarker))).toBe(true);
      expect(replayBytes.includes(Buffer.from("ACTIVE_OPEN_059999"))).toBe(true);
      expect(replayBytes.includes(Buffer.from(continuedMarker))).toBe(true);
      expect(replayBytes.includes(Buffer.from(tailMarker))).toBe(true);

      expect(readFileSync(stderrPath, "utf8")).toBe("");
      passed = true;
    } finally {
      if (active) {
        if (passed) {
          try {
            await active.sendText("/quit");
          } catch {}
        }
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained active-overflow artifacts at ${root}`);
      }
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "cancelled cap-crossing command keeps grouped rows stable and Ctrl-O opens its artifact",
  async () => {
    const timeout = 60_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cancelled-command-cap-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    const tapePath = join(root, "cancelled-command-cap.fibertape");
    const beforePath = join(root, "scrollback-before.txt");
    const beforeAnsiPath = join(root, "scrollback-before.ansi.txt");
    const afterPath = join(root, "scrollback-after.txt");
    const afterAnsiPath = join(root, "scrollback-after.ansi.txt");
    const ctrlOPath = join(root, "ctrl-o.txt");
    const rowPrefix = "CANCEL_CAP_ROW_";
    const tailMarker = "CANCEL_CAP_TERM_TAIL_ONLY";
    const nextMarker = "CANCEL_CAP_UNRELATED_TURN_DONE";
    const callId = "cancelled-cap-command";
    const readyPath = join(workspace, ".cancel-cap-ready");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");
    writeFileSync(join(workspace, ".cancel-cap-row-prefix"), rowPrefix);
    writeFileSync(join(workspace, ".cancel-cap-tail-marker"), tailMarker);
    const scriptPath = join(workspace, "cancel-cap.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
row_prefix=$(cat .cancel-cap-row-prefix)
tail_marker=$(cat .cancel-cap-tail-marker)
trap 'printf "%s\\n" "$tail_marker"; exit 0' TERM
i=1
while [ "$i" -le 24 ]; do
  printf "%s%02d\\n" "$row_prefix" "$i"
  i=$((i + 1))
done
awk 'BEGIN { for (i = 1; i <= 600; i++) printf "CAP_FILL_%04d_%02000d\\n", i, 0 }'
: > .cancel-cap-ready
while :; do :; done
`,
    );
    chmodSync(scriptPath, 0o755);

    const expectedRows = Array.from(
      { length: 24 },
      (_, index) => `${rowPrefix}${String(index + 1).padStart(2, "0")}`,
    );
    const historicalLines = (text: string): string[] =>
      text.split("\n").filter((line) => line.includes(rowPrefix));
    let releaseNextResponse: (() => void) | null = null;
    const nextResponse = new Promise<Response>((resolve) => {
      releaseNextResponse = () => resolve(
        codexFinalText(`${nextMarker}\n${"N".repeat(8 * 1024)}`),
      );
    });
    const gateway = startCodexQueue([
      fakeShellRun(callId, "./cancel-cap.sh"),
      () => nextResponse,
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES:
            "core,agent,tool,worker,interrupt,command_output,transcript,transcript_retention,render",
        },
        stderrPath,
        width: 120,
        height: 36,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared cancellable cap-crossing command.");
      await waitForCondition(
        () => existsSync(readyPath),
        "the cap-crossing command readiness file",
        timeout,
      );
      await waitForCondition(
        () => existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("command output retention cap reached"),
        "the structured command-output retention cap",
        timeout,
      );

      await active.sendKeys("Escape");
      await waitForScrollback(active, "Cancelled", timeout);
      await waitForCondition(
        () => readFileSync(tracePath, "utf8").includes("event=interrupt_persisted"),
        "interrupted command finalization",
        timeout,
      );
      expect(gateway.requests).toHaveLength(1);

      const before = await active.captureFullScrollback();
      const beforeAnsi = await active.captureFullScrollbackEscapes();
      writeFileSync(beforePath, before);
      writeFileSync(beforeAnsiPath, beforeAnsi);
      const beforePlain = stripAnsi(before);
      for (const row of expectedRows) {
        expect(countOccurrences(beforePlain, row)).toBe(0);
      }
      expect(historicalLines(before)).toHaveLength(0);
      expect(beforePlain).not.toContain(tailMarker);

      const sessionId = sessionIdFromHome(home);
      const commandDir = join(home, ".fiber", "sessions", sessionId, "logs", "commands");
      const replayNames = readdirSync(commandDir).filter((name) =>
        name.endsWith(".bin")
      );
      expect(replayNames).toHaveLength(1);
      const replayName = replayNames[0]!;
      const replayPath = join(commandDir, replayName);
      const replayBytes = await waitForQuiescentReplay(replayPath);
      expect(replayBytes.byteLength).toBeGreaterThan(1024 * 1024);

      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", timeout);
      await active.waitForText(tailMarker, timeout);
      writeFileSync(ctrlOPath, await active.capturePane());
      await active.sendKeys("C-o");
      await active.waitForPane(
        (pane) =>
          pane.includes("Cancelled") &&
          !pane.includes(tailMarker),
        timeout,
      );
      expect(historicalLines(await active.captureFullScrollback()).map(stripAnsi)).toEqual(
        historicalLines(before).map(stripAnsi),
      );

      await active.sendText("Reply with the unrelated turn marker.");
      await waitForCondition(
        () => gateway.requests.length === 2,
        "the unrelated follow-up request",
        timeout,
      );
      const retentionMarker = "[transcript_retention] pruned command output line";
      const retentionBeforeAssistant = countOccurrences(
        readFileSync(tracePath, "utf8"),
        retentionMarker,
      );
      releaseNextResponse();
      releaseNextResponse = null;
      await waitForScrollback(active, nextMarker, timeout);
      expect(gateway.requests).toHaveLength(2);
      const after = await active.captureFullScrollback();
      const afterAnsi = await active.captureFullScrollbackEscapes();
      writeFileSync(afterPath, after);
      writeFileSync(afterAnsiPath, afterAnsi);
      expect(after).toContain(nextMarker);
      expect(historicalLines(after)).toEqual(historicalLines(before));
      expect(historicalLines(afterAnsi)).toEqual(historicalLines(beforeAnsi));
      await waitForCondition(
        () => countOccurrences(readFileSync(tracePath, "utf8"), retentionMarker) >
          retentionBeforeAssistant,
        "the recorded assistant-stream retention pass",
        timeout,
      );

      const followRequest = JSON.parse(gateway.requests[1]!.body) as {
        input: Array<Record<string, unknown>>;
      };
      const calls = followRequest.input.filter((part) =>
        part.type === "function_call" &&
        part.call_id === callId &&
        part.name === "shell"
      );
      const results = followRequest.input.filter((part) =>
        part.type === "function_call_output" &&
        part.call_id === callId
      );
      expect(calls).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0])).toContain("aborted by user");
      expect(gateway.requests[1]!.body).toContain("<turn_aborted>");
      expect(gateway.requests[1]!.body).not.toContain(rowPrefix);
      expect(gateway.requests[1]!.body).not.toContain("CAP_FILL_0600_");
      expect(gateway.requests[1]!.body).not.toContain(tailMarker);
      expect(gateway.requests[1]!.body).toContain(replayName);
      expect(gateway.requests[1]!.body).not.toContain(replayPath);
      expect(readFileSync(replayPath)).toEqual(replayBytes);
      expect(active.isPaneAlive()).toBe(true);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const replayFrames = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
        timeoutMs: timeout,
      });
      expect(replayFrames.code).toBe(0);
      expect(replayFrames.stderr).toBe("");
      expect(replayFrames.stdout).toContain(tailMarker);
      const replayJson = await runFx(["debug", "replay", tapePath, "--json"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
        timeoutMs: timeout,
      });
      expect(replayJson.code).toBe(0);
      expect(replayJson.stderr).toBe("");
      expect(parseReplayData(replayJson.stdout).frame_count).toBeGreaterThan(0);
 
      const trace = readFileSync(tracePath, "utf8");
      const interruptIndex = trace.indexOf("event=interrupt_persisted");
      expect(trace).toContain("route=approved_shell");
      expect(trace).toContain("command output retention cap reached");
      expect(interruptIndex).toBeGreaterThanOrEqual(0);
      expect(trace).not.toContain("dropping buffered command output");
      expect(trace).not.toContain(
        "cancelled worker event dropped kind=command_output_complete",
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      passed = true;
    } finally {
      releaseNextResponse?.();
      if (active) {
        if (!passed) {
          try {
            writeFileSync(join(root, "failure-scrollback.txt"), await active.captureFullScrollback());
            writeFileSync(
              join(root, "failure-scrollback.ansi.txt"),
              await active.captureFullScrollbackEscapes(),
            );
          } catch {}
        } else {
          try {
            await active.sendText("/quit");
          } catch {}
        }
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained cancelled cap-crossing artifacts at ${root}`);
      }
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "cancelled below-cap command exposes its TERM tail only through Ctrl-O",
  async () => {
    const timeout = 60_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cancelled-command-below-cap-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    const tapePath = join(root, "cancelled-command-below-cap.fibertape");
    const headMarker = "CANCEL_BELOW_CAP_HEAD";
    const tailMarker = "CANCEL_BELOW_CAP_TERM_TAIL_ONLY";
    const readyPath = join(workspace, ".cancel-below-ready");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");
    writeFileSync(join(workspace, ".cancel-below-head"), headMarker);
    writeFileSync(join(workspace, ".cancel-below-tail"), tailMarker);
    const scriptPath = join(workspace, "cancel-below.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
head_marker=$(cat .cancel-below-head)
tail_marker=$(cat .cancel-below-tail)
trap 'printf "%s\\n" "$tail_marker"; exit 0' TERM
printf "%s\\n" "$head_marker"
: > .cancel-below-ready
while :; do :; done
`,
    );
    chmodSync(scriptPath, 0o755);

    const gateway = startCodexQueue([
      fakeShellRun("cancelled-below-cap-command", "./cancel-below.sh"),
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES:
            "core,agent,tool,worker,interrupt,command_output,transcript,render",
        },
        stderrPath,
        width: 120,
        height: 36,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared cancellable below-cap command.");
      await waitForCondition(
        () => existsSync(readyPath),
        "the below-cap command readiness file",
        timeout,
      );
      await active.sendKeys("Escape");
      await waitForScrollback(active, "Cancelled", timeout);
      await waitForCondition(
        () => existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=interrupt_persisted"),
        "below-cap interrupted command finalization",
        timeout,
      );

      expect(gateway.requests).toHaveLength(1);
      const compact = await active.captureFullScrollback();
      expect(countOccurrences(compact, headMarker)).toBe(0);
      expect(compact).not.toContain(tailMarker);
      const sessionId = sessionIdFromHome(home);
      const commandDir = join(home, ".fiber", "sessions", sessionId, "logs", "commands");
      const replayFiles = readdirSync(commandDir).filter((name) =>
        name.endsWith(".bin")
      );
      expect(replayFiles).toHaveLength(1);
      expect(statSync(join(commandDir, replayFiles[0]!)).size).toBeGreaterThan(0);

      await active.sendKeys("C-o");
      await active.waitForText(tailMarker, timeout);
      expect(await active.capturePane()).toContain(tailMarker);
      await active.sendKeys("Escape");
      await active.waitForPane(
        (pane) => pane.includes("Cancelled") && !pane.includes(tailMarker),
        timeout,
      );
      expect(await active.captureFullScrollback()).not.toContain(tailMarker);
      expect(active.isPaneAlive()).toBe(true);

      const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
        timeoutMs: timeout,
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      expect(replay.stdout).toContain(headMarker);
      expect(replay.stdout).toContain(tailMarker);
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain("route=approved_shell");
      expect(trace).not.toContain("command output retention cap reached");
      expect(trace).not.toContain("dropping buffered command output");
      expect(trace).not.toContain(
        "cancelled worker event dropped kind=command_output_complete",
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      passed = true;
    } finally {
      if (active) {
        if (!passed) {
          try {
            writeFileSync(join(root, "failure-scrollback.txt"), await active.captureFullScrollback());
          } catch {}
        } else {
          try {
            await active.sendText("/quit");
          } catch {}
        }
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained cancelled below-cap artifacts at ${root}`);
      }
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "grouped command status stays compact while Ctrl-O keeps detail",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-command-output-status-order-")));
    const home = join(root, "home");
    const workspaceDir = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    const tapePath = join(root, "command-output-status-order.fibertape");
    const inlineScrollbackPath = join(root, "inline-scrollback.txt");
    const inlineAnsiPath = join(root, "inline-scrollback.ansi.txt");
    const ctrlOScrollbackPath = join(root, "ctrl-o-scrollback.txt");
    const ctrlOAnsiPath = join(root, "ctrl-o-scrollback.ansi.txt");
    const replayJsonPath = join(root, "replay.json");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspaceDir);
    const workspace = realpathSync(workspaceDir);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const finalMarker = "ORDER_REPRO_DONE";
    const prompt =
      "Use the shell tool to run exactly pwd and no other commands. Then reply with the completion marker.";
    const statusLine = "└ Ran pwd";
    const outputLine = workspace;
    const reviewOutputPrefix = workspace.slice(0, 56);
    const visibleLinearText = (text: string): string =>
      stripAnsi(text).replaceAll("\n│ ", "").replaceAll("\n", "");
    const captureFullScrollbackArtifacts = async (
      session: TmuxSession,
      plainPath: string,
      ansiPath: string,
    ): Promise<string> => {
      const plain = await session.captureFullScrollback();
      const ansi = await session.captureFullScrollbackEscapes();
      writeFileSync(plainPath, plain);
      writeFileSync(ansiPath, ansi);
      return visibleLinearText(ansi);
    };
    const expectInlineOrder = (scrollback: string): void => {
      expect(countOccurrences(scrollback, statusLine)).toBe(1);

      const statusIndex = scrollback.indexOf(statusLine);
      const doneIndex = scrollback.lastIndexOf(finalMarker);
      expect(statusIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeGreaterThan(statusIndex);
      const transcriptRegion = scrollback.slice(statusIndex, doneIndex);
      expect(countOccurrences(transcriptRegion, outputLine)).toBe(0);
    };
    const gateway = startCodexQueue([
      fakeShellRun("order-repro-pwd", "pwd"),
      codexFinalText(finalMarker),
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspace,
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,tool,render,transcript,gateway",
        },
        stderrPath,
        width: 100,
        height: 28,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText(prompt);
      await waitForScrollback(active, finalMarker);

      const inlineVisible = await captureFullScrollbackArtifacts(
        active,
        inlineScrollbackPath,
        inlineAnsiPath,
      );
      expect(gateway.requests).toHaveLength(2);
      expectInlineOrder(inlineVisible);

      await active.sendKeys("C-o");
      await active.waitForPane((pane) => {
        const visible = visibleLinearText(pane);
        return visible.includes("Ran pwd") && visible.includes(reviewOutputPrefix);
      }, TIMEOUT);
      const ctrlOVisible = await captureFullScrollbackArtifacts(
        active,
        ctrlOScrollbackPath,
        ctrlOAnsiPath,
      );
      expect(ctrlOVisible).toContain("Ran pwd");
      expect(ctrlOVisible).toContain(reviewOutputPrefix);
      expect(ctrlOVisible).not.toContain("\"command\":\"pwd\"");
      expect(ctrlOVisible).not.toContain("<stdout>");
      expect(ctrlOVisible).not.toContain("</stdout>");

      const replay = await runFx(["debug", "replay", tapePath, "--json"], {
        cwd: workspace,
        env: { HOME: home },
      });
      writeFileSync(replayJsonPath, replay.stdout);
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      const replayJson = parseReplayData(replay.stdout);
      expect(replayJson.frame_count).toBeGreaterThan(0);
      expect(replayJson.stdout_bytes).toBeGreaterThan(0);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
      passed = true;
    } finally {
      if (active) {
        if (!passed) {
          try {
            writeFileSync(join(root, "failure-inline-scrollback.txt"), await active.captureFullScrollback());
            writeFileSync(join(root, "failure-inline-scrollback.ansi.txt"), await active.captureFullScrollbackEscapes());
          } catch {}
        }
        try {
          await active.sendKeys("Escape");
        } catch {}
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained command-output status-order artifacts at ${root}`);
      }
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "streamed document append preserves native scrollback without ONLCR",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-document-append-newlines-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const markers = Array.from(
      { length: 14 },
      (_, index) => `WIRE_LINE_${String(index + 1).padStart(2, "0")}`,
    );
    const response = [
      "```ts",
      ...markers.map((marker, index) => `const ${marker} = ${index + 1};`),
      "```",
      "WIRE_APPEND_DONE",
    ].join("\r\n");
    const terminalModes = ["stty opost onlcr", "stty opost -onlcr", "stty -opost"];

    try {
      for (const stty of terminalModes) {
        writeFileSync(stderrPath, "");
        const gateway = startCodexQueue([
          () => streamedTextResponse(response),
        ]);
        const launch = `${stty}; exec ${shellQuote(FIBER_BIN)}`;
        let active: TmuxSession | null = null;
        try {
          active = await TmuxSession.create({
            cmd: `zsh -lc ${shellQuote(launch)}`,
            cwd: realpathSync(workspace),
            env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
            stderrPath,
            width: 48,
            height: 12,
            startupWaitMs: 0,
          });
          await active.waitForComposer(TIMEOUT);
          await active.sendText("Return the prepared TypeScript block.");
          const scrollback = await waitForScrollback(active, "WIRE_APPEND_DONE");
          const markerRows = scrollback.split("\n").filter((line) =>
            line.includes("WIRE_LINE_")
          );

          expect(markerRows).toHaveLength(markers.length);
          for (const marker of markers) {
            expect(countOccurrences(scrollback, marker)).toBe(1);
          }
          const markerColumns = markerRows.map((line) => line.indexOf("WIRE_LINE_"));
          expect(new Set(markerColumns).size).toBe(1);
          const rows = scrollback.split("\n");
          const firstMarkerRow = rows.findIndex((line) => line.includes(markers[0]!));
          expect(markerRows).toEqual(rows.slice(firstMarkerRow, firstMarkerRow + markers.length));
          expect(scrollback.indexOf(markers.at(-1)!)).toBeLessThan(
            scrollback.indexOf("WIRE_APPEND_DONE"),
          );
          expect(readFileSync(stderrPath, "utf8")).toBe("");
        } finally {
          if (active) await active.kill();
          gateway.stop();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 3,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-C closes the Ctrl-O viewer without clearing the unsent draft",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-draft-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o-draft.fibertape");
    const sentinel = "CTRL_O_DRAFT_SCROLLBACK_SENTINEL";
    const draft = "CTRL_O_UNSENT_DRAFT";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(stderrPath, "");

    const cmd = `zsh -lc 'for i in {1..14}; do printf "${sentinel}_%02d: pre-fiber shell scrollback\\n" "$i"; done; exec ${FIBER_BIN}'`;
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd,
        cwd: realpathSync(workspace),
        env: {
          HOME: home,
          AI_GATEWAY_API_KEY: undefined,
          VERCEL_OIDC_TOKEN: undefined,
          FIBER_RECORD: tapePath,
          NO_COLOR: "1",
        },
        stderrPath,
        width: 100,
        height: 30,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      const before = await active.captureFullScrollback();
      for (const index of [9, 10, 11]) {
        expect(before).toContain(`${sentinel}_${index.toString().padStart(2, "0")}: pre-fiber shell scrollback`);
      }

      await active.sendLiteralText(draft);
      await active.waitForText(draft, TIMEOUT);
      await active.sendKeys("C-o");
      await Bun.sleep(150);
      const entered = readFileSync(tapePath);
      const enterAlternate = Buffer.from("\x1b[?1049h");
      const enterOffset = entered.lastIndexOf(enterAlternate);
      expect(enterOffset).toBeGreaterThanOrEqual(0);

      await active.sendKeys("C-c");
      await active.waitForText(draft, TIMEOUT);

      const restored = await active.captureFullScrollback();
      for (const index of [9, 10, 11]) {
        expect(restored).toContain(`${sentinel}_${index.toString().padStart(2, "0")}: pre-fiber shell scrollback`);
      }
      expect(restored).toContain(`┃ ${draft}`);
      expect(restored).not.toContain("press ctrl+c again to exit");

      const tape = readFileSync(tapePath);
      const leaveAlternate = Buffer.from("\x1b[?1049l");
      const leaveOffset = tape.lastIndexOf(leaveAlternate);
      expect(leaveOffset).toBeGreaterThan(enterOffset);
      expectAltExitToPreserveNormalViewport(tapePath);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Cmd+R refuses session switching over a draft and opens after explicit clear",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-session-picker-draft-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const saved = "CMD_R_SAVED_SESSION";
    const draft = "CMD_R_UNSENT_DRAFT";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(stderrPath, "");

    const gateway = startCodexQueue([codexFinalText(saved)]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 30,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save a session before testing Cmd+R.");
      await active.waitForText(saved, TIMEOUT);
      await active.sendLiteralText(draft);
      await active.waitForText(draft, TIMEOUT);

      await active.sendHexBytes(["1b", "5b", "31", "31", "34", "3b", "39", "75"]);
      await active.waitForText(
        "submit or clear the draft before switching sessions",
        TIMEOUT,
      );
      const refused = stripAnsi(await active.capturePane());
      expect(refused).toContain(draft);
      expect(refused).not.toContain("Sessions");
      expect(gateway.requests).toHaveLength(1);

      await active.sendKeys("C-u");
      await active.waitForPane(
        (pane) => hasEmptyComposer(stripAnsi(pane)),
        TIMEOUT,
      );
      await active.sendHexBytes(["1b", "5b", "31", "31", "34", "3b", "39", "75"]);
      await active.waitForPane(
        (pane) => stripAnsi(pane).includes("Sessions"),
        TIMEOUT,
      );
      await active.sendKeys("Escape");
      await waitForSessionPickerClosed(active);

      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O viewer preserves hidden composer input while Ctrl-X stays inert",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-input-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const firstDone = "CTRL_O_INPUT_FIRST_DONE";
    const followUpDone = "CTRL_O_INPUT_FOLLOW_UP_DONE";
    const fullViewDraft = "CTRL_O_FULL_VIEW_COMPOSER_DRAFT";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const gateway = startCodexQueue([
      codexFinalText(firstDone),
      codexFinalText(followUpDone),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Start the prepared Ctrl-O input check.");
      await active.waitForText(firstDone, TIMEOUT);
      await active.waitForComposer(TIMEOUT);

      await active.sendKeys("C-o");
      await Bun.sleep(250);
      await active.sendHexBytes(["18"]);
      await active.sendHexBytes(["1b", "5b", "31", "32", "30", "3b", "35", "75"]);
      await active.sendLiteralText(fullViewDraft);
      await Bun.sleep(150);
      const fullView = await active.capturePane();
      expect(fullView).toContain(firstDone);
      expect(fullView).not.toContain(fullViewDraft);
      expect(fullView).toContain("┃ Full detail · ctrl o close");
      await active.sendKeys("Escape");
      await active.waitForText(fullViewDraft, TIMEOUT);
      await active.sendKeys("Enter");
      await active.waitForText(followUpDone, TIMEOUT);
      const followUpBody = gateway.requests[1]?.body ?? "";
      const messages = JSON.parse(followUpBody).input as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
      const finalUser = messages.filter((message) => message.role === "user").at(-1);
      expect(finalUser?.role).toBe("user");
      expect(finalUser?.content[0]?.text).toBe(fullViewDraft);
      const afterSubmit = await active.capturePane();
      expect(afterSubmit).toContain(firstDone);
      expect(afterSubmit).toContain(followUpDone);
      await Bun.sleep(250);
      const settledGrid = await active.capturePaneGrid();
      expect(
        settledGrid.filter((line) => line.trimStart().startsWith("auto · ")),
      ).toHaveLength(1);
      await active.waitForComposer(TIMEOUT);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-C leaves Ctrl-O before cancelling a streaming command",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-cancel-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o-cancel.fibertape");
    const streamMarker = "CTRL_O_CANCEL_STREAM";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const command = `sh -c 'while :; do printf "${streamMarker}\\n"; sleep 0.1; done'`;
    const gateway = startCodexQueue([
      fakeShellRun("ctrl-o-cancel-command", command),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: tapePath },
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared Ctrl-O cancellation check.");
      await active.waitForText(streamMarker, TIMEOUT);

      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      const enterAlternate = Buffer.from("\x1b[?1049h");
      const leaveAlternate = Buffer.from("\x1b[?1049l");
      const tapeBeforeCancel = readFileSync(tapePath);
      const enterOffset = tapeBeforeCancel.lastIndexOf(enterAlternate);
      expect(enterOffset).toBeGreaterThanOrEqual(0);

      await active.sendKeys("C-c");
      await Bun.sleep(250);

      const tape = readFileSync(tapePath);
      expect(tape.indexOf(leaveAlternate, enterOffset + enterAlternate.length)).toBeGreaterThan(
        enterOffset,
      );
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O keeps command output live while the alternate buffer is open",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-live-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const firstMarker = "CTRL_O_LIVE_HEAD";
    const tailMarker = "CTRL_O_LIVE_TAIL";
    const command = "sh -c 'printf \"CTRL_O_LIVE_HEAD\\n\"; sleep 1; printf \"CTRL_O_LIVE_TAIL\\n\"'";
    const gateway = startCodexQueue([
      fakeShellRun("ctrl-o-live-command", command),
      codexFinalText("CTRL_O_LIVE_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared command.");
      await active.waitForText("Running sh -c", TIMEOUT);

      await active.sendKeys("C-o");
      await active.waitForText(tailMarker, TIMEOUT);
      const full = await active.capturePane();
      expect(full).toContain(firstMarker);
      expect(full).toContain(tailMarker);

      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);
      await active.waitForText("CTRL_O_LIVE_DONE", TIMEOUT);
      const restored = await active.capturePane();
      expect(restored).not.toContain("\ninput\n");
      expect(restored).not.toContain("\nresult\n");
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "streaming scroll stays inline while Ctrl-O preserves native selection and ignores horizontal arrows",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-stream-scroll-inline-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "stream-scroll.fibertape");
    const tracePath = join(root, "trace.log");
    const phaseTwoComplete = join(workspace, "phase-two.complete");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const lineMarker = "STREAM_SCROLL_INLINE";
    const doneMarker = "STREAM_SCROLL_INLINE_DONE";
    const command = `zsh -lc 'for i in {1..80}; do printf "${lineMarker} %03d\\n" "$i"; done; sleep 2; for i in {81..160}; do printf "${lineMarker} %03d\\n" "$i"; done; : > ${shellQuote(phaseTwoComplete)}'`;
    const gateway = startCodexQueue([
      fakeShellRun("stream-scroll-handoff", command),
      codexFinalText(doneMarker),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "full_transcript,full_transcript_cache,input,scroll,frame_diff,frame_commit",
        },
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared streaming command.");
      await active.waitForPane(
        (pane) =>
          pane.includes("Running zsh -lc") &&
          !pane.includes(`${lineMarker} 001`),
        TIMEOUT,
      );
      const scrollActions = [
        ["1b", "5b", "3c", "36", "34", "3b", "31", "3b", "31", "4d"],
        ["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"],
        ["1b", "5b", "35", "7e"],
        ["1b", "5b", "36", "7e"],
      ];
      const stressBytes: string[] = [];
      for (let cycle = 0; cycle < 25; cycle += 1) {
        for (const action of scrollActions) stressBytes.push(...action);
      }
      await active.sendHexBytes(stressBytes);
      await Bun.sleep(250);
      const inlineAfterWheel = (await active.capturePaneGrid()).join("\n");
      expect(inlineAfterWheel).not.toContain("Full detail · ctrl o close");
      expect(readFileSync(tapePath)).not.toContain(Buffer.from("\x1b[?1000h\x1b[?1006h"));
      expect(readFileSync(tracePath, "utf8")).not.toContain(
        "depth_transition from=inline to=full",
      );

      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendKeys("Left");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendKeys("Right");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      expect(readFileSync(tapePath)).not.toContain(Buffer.from("\x1b[?1000h\x1b[?1006h"));
      const alternateScrollTraceStart = statSync(tracePath).size;
      await active.sendHexBytes(["1b", "5b", "41"]);
      await active.sendHexBytes(["1b", "5b", "42"]);
      await waitForCondition(
        () => {
          const appended = readFileSync(tracePath)
            .subarray(alternateScrollTraceStart)
            .toString("utf8");
          return appended.includes("direction=up unit=wheel") &&
            appended.includes("direction=down unit=wheel");
        },
        "viewer alternate-scroll trace",
      );
      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      await waitForCondition(
        () => readFileSync(tracePath, "utf8").includes("unit=page"),
        "viewer page trace",
      );
      const readingBefore = await active.capturePaneGrid();
      expect(readingBefore.join("\n")).toContain("Full detail · ctrl o close");
      expect(readingBefore.join("\n")).toMatch(
        new RegExp(`│ ${lineMarker} \\d{3}`),
      );
      expect(readingBefore.join("\n")).not.toContain("ctrl o to view");

      await waitForCondition(() => existsSync(phaseTwoComplete), "second output phase");
      await waitForCondition(() => gateway.requests.length >= 2, "post-command gateway request");
      const readingAfter = await active.capturePaneGrid();
      const normalizeLiveMetadata = (grid: string[]) => grid.map((row) => {
        if (/^└ (?:Running|Ran) /.test(row)) return "<command status>";
        if (/^│  \d+ output lines$/.test(row)) return "<output count>";
        if (/^│  \d+ more lines · → to expand$/.test(row)) return "<fold count>";
        if (row.includes("enter queue ·")) return "<status line>";
        // The idle status line once the turn ends between the two readings.
        if (row === `auto · ${FAKE_CODEX_DEFAULT_MODEL}`) return "<status line>";
        return row;
      });
      const normalizedBefore = normalizeLiveMetadata(readingBefore);
      const normalizedAfter = normalizeLiveMetadata(readingAfter);
      for (const [rowIndex, row] of normalizedBefore.entries()) {
        if (row !== "") expect(normalizedAfter[rowIndex]).toBe(row);
      }
      const visibleOutputRows = readingBefore.filter((row) =>
        row.includes(`│ ${lineMarker} `)
      );
      expect(visibleOutputRows.length).toBeGreaterThan(0);
      for (const marker of visibleOutputRows.slice(0, 3)) {
        expect(readingAfter.indexOf(marker)).toBe(readingBefore.indexOf(marker));
      }

      await active.sendKeys("Escape");
      await active.waitForPane(
        (pane) => pane.includes(doneMarker) && !pane.includes("┃ Full detail · ctrl o close"),
        TIMEOUT,
      );
      const scrollback = await waitForScrollback(active, doneMarker);
      expect(scrollback).not.toContain(`│ ${lineMarker} 001`);
      expect(countOccurrences(scrollback, `│ ${lineMarker} 001`)).toBe(0);
      expect(scrollback).not.toContain("lines more (ctrl o to view)");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd(TIMEOUT)).toBe(true);
      active = null;

      const stdout = Buffer.concat(
        readTapeFrames(tapePath)
          .filter((frame) => frame.kind === 1)
          .map((frame) => frame.payload),
      ).toString("binary");
      expect(countOccurrences(stdout, "\x1b[?1000h")).toBe(0);
      expect(countOccurrences(stdout, "\x1b[?1006h")).toBe(0);
      expect(countOccurrences(stdout, "\x1b[?1000l")).toBe(1);
      expect(countOccurrences(stdout, "\x1b[?1006l")).toBe(1);
      expect(stdout).toContain("\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1004l\x1b[?1006l");
      expect(countOccurrences(stdout, "\x1b[?1049h")).toBe(1);
      expect(countOccurrences(stdout, "\x1b[?1049l")).toBe(1);

      const replay = await runFx(["debug", "replay", tapePath, "--json"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O navigation during shell streaming preserves grouped compact rows",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-navigation-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const lineCount = 200;
    const commandMarker = "CTRL_O_NAV_REPEAT";
    const doneMarker = "CTRL_O_NAVIGATION_DONE";
    const gateway = startCodexQueue([
      fakeShellRun(
        "ctrl-o-navigation-command",
        `zsh -lc 'for i in {1..100}; do printf "${commandMarker} %05d\\n" "$i"; done; sleep 2; for i in {101..${lineCount}}; do printf "${commandMarker} %05d\\n" "$i"; done'`,
      ),
      codexFinalText(doneMarker),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared streaming command.");
      await active.waitForPane(
        (pane) =>
          pane.includes("Running zsh -lc") &&
          !pane.includes(`${commandMarker} 00005`),
        TIMEOUT,
      );

      await active.sendKeys("C-o");
      await active.sendHexBytes(
        Array.from({ length: 4 }, () => ["1b", "5b", "35", "7e"]).flat(),
      );
      await active.sendHexBytes(
        Array.from({ length: 4 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.sendKeys("Escape");

      const scrollback = await waitForScrollback(active, doneMarker);
      for (let index = 1; index <= 5; index += 1) {
        const line = `│ ${commandMarker} ${String(index).padStart(5, "0")}`;
        expect(countOccurrences(scrollback, line)).toBe(0);
      }
      expect(scrollback).not.toContain(`│ ${commandMarker} 00006`);
      expect(scrollback).not.toContain(
        `│ ${commandMarker} ${String(lineCount).padStart(5, "0")}`,
      );
      expect(scrollback).not.toContain("lines more (ctrl o to view)");
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "an ask-user prompt takes over Ctrl-O and accepts its choice inline",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-question-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o-question.fibertape");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const commandMarker = "CTRL_O_QUESTION_COMMAND_RUNNING";
    const questionMarker = "CTRL_O_QUESTION_PROMPT";
    const doneMarker = "CTRL_O_QUESTION_DONE";
    const gateway = startCodexQueue([
      fakeShellRun(
        "ctrl-o-question-command",
        `sh -c 'printf "${commandMarker}\\n"; sleep 1'`,
      ),
      codexToolCall("ctrl-o-question", "ask_user_question", {
        questions: [
          {
            question: questionMarker,
            options: [
              { label: "A", description: "Select A." },
              { label: "B", description: "Select B." },
            ],
          },
        ],
      }),
      codexFinalText(doneMarker),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: tapePath },
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared command and ask the prepared question.");
      await active.waitForText(commandMarker, TIMEOUT);
      await active.sendKeys("C-o");
      await active.waitForText(questionMarker, TIMEOUT);

      const tape = readFileSync(tapePath);
      const questionOffset = tape.lastIndexOf(Buffer.from(questionMarker));
      expect(questionOffset).toBeGreaterThanOrEqual(0);
      expect(tape.lastIndexOf(Buffer.from("\x1b[?1049l"), questionOffset)).toBeGreaterThanOrEqual(0);

      await active.sendLiteralText("1");
      await active.sendKeys("Enter");
      await active.waitForText(doneMarker, TIMEOUT);
      const inline = await active.capturePane();
      expect(inline).toContain(doneMarker);
      expect(inline).toContain(`\n  1) ${questionMarker}`);
      expect(inline).not.toContain("Use numbers, Up/Down, or tab to choose");
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O preserves inline block spacing while expanding tool detail",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-spacing-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const beforeMarker = "CTRL_O_SPACING_BEFORE";
    const outputMarker = "CTRL_O_SPACING_OUTPUT";
    const afterMarker = "CTRL_O_SPACING_AFTER";
    const command = `printf '${outputMarker}\\n'`;
    const gateway = startCodexQueue([
      codexSerializedToolCall(
        "ctrl-o-spacing-command",
        "shell",
        JSON.stringify({
          request: {
            action: "run",
            command,
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
          },
        }),
        beforeMarker,
      ),
      codexFinalText(afterMarker),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 40,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared command.");
      await waitForScrollback(active, afterMarker);
      await active.waitForComposer(TIMEOUT);
      const compactGrid = await active.capturePaneGrid();
      const compactTool = compactGrid.findIndex((line) => line.includes("Ran "));
      if (compactTool < 0) {
        throw new Error(`missing compact tool rows:\n${compactGrid.join("\n")}`);
      }

      await active.sendKeys("C-o");
      const fullTranscript = await active.waitForPane(
        (pane) =>
          pane.includes(beforeMarker) &&
          pane.includes("1 tool call") &&
          pane.includes("Ran ") &&
          pane.includes(outputMarker) &&
          pane.includes(afterMarker),
        TIMEOUT,
      );
      const grid = fullTranscript.replace(/\n$/, "").split("\n");
      const before = grid.findIndex((line) => line.includes(beforeMarker));
      const toolTimestamp = grid.findIndex(
        (line, index) => index > before && line.includes("UTC · Tool"),
      );
      const header = grid.findIndex((line) => line.includes("1 tool call"));
      const tool = grid.findIndex((line) => line.includes("Ran "));
      const output = grid.findIndex((line) => line.trimStart().startsWith(`│ ${outputMarker}`));
      const afterTimestamp = grid.findIndex(
        (line, index) => index > output && line.includes("UTC · Response"),
      );
      const after = grid.findIndex((line) => line.includes(afterMarker));
      if (
        before < 0 || toolTimestamp < 0 || header < 0 || tool < 0 ||
        output < 0 || afterTimestamp < 0 || after < 0
      ) {
        throw new Error(`missing full transcript rows:\n${grid.join("\n")}`);
      }
      expect(fullTranscript).not.toContain(
        "Permissions: Auto agent approved this request",
      );
      expect(grid[before + 1]).toBe("");
      expect(toolTimestamp).toBe(before + 2);
      expect(header).toBe(toolTimestamp + 1);
      expect(tool).toBe(header + 1);
      expect(grid[tool + 1]).toContain("action: run");
      expect(grid[tool + 2]).toContain("yield_time_ms: 30000");
      expect(grid[tool + 3]).toContain("timeout_ms: 600000");
      expect(output).toBe(tool + 4);
      expect(grid[output + 1]).toBe("");
      expect(afterTimestamp).toBe(output + 2);
      expect(after).toBe(afterTimestamp + 1);

      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);
      const restoredGrid = await active.waitForStableGrid(
        compactGrid,
        normalizeVolatileStatusRows,
        TIMEOUT,
      );
      expect(normalizeVolatileStatusRows(restoredGrid)).toEqual(
        normalizeVolatileStatusRows(compactGrid),
      );
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O restores a long Markdown transcript without replaying it into scrollback",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-markdown-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const doneMarker = "CTRL_O_STATIC_MARKDOWN_DONE";
    const markdown = [
      "# Ctrl-O Markdown",
      "",
      ...Array.from(
        { length: 6 },
        (_, index) => `Paragraph ${index + 1} contains enough text to force an inline transcript scroll while preserving Markdown rendering and the active footer rows.`,
      ),
      "",
      doneMarker,
    ].join("\n\n");
    const gateway = startCodexQueue([codexFinalText(markdown)]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 12,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Return the prepared Markdown response.");
      await waitForScrollback(active, doneMarker);

      await active.sendKeys("C-o");
      await Bun.sleep(250);
      for (let index = 0; index < 12; index += 1) {
        await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      }
      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);

      const restoredScrollback = await active.captureFullScrollback();
      expect(countOccurrences(restoredScrollback, doneMarker)).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O renders read_file results as readable content",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-read-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(
      join(workspace, "README.md"),
      "READ_RESULT_MARKER\n",
    );
    writeFileSync(stderrPath, "");

    const gateway = startCodexQueue([
      codexToolCall("ctrl-o-read", "read_file", { path: "README.md" }),
      codexFinalText("CTRL_O_READ_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Read the prepared file.");
      await waitForScrollback(active, "CTRL_O_READ_DONE");

      await active.sendKeys("C-o");
      await active.waitForText("READ_RESULT_MARKER", TIMEOUT);
      const full = await active.capturePane();
      expect(full).toContain("Full detail · ctrl o close · PgUp/PgDn scroll · Esc close");
      expect(full).toContain("READ_RESULT_MARKER");
      expect(full).not.toContain("<path>");
      expect(full).not.toContain("<content>");
      expect(full).not.toContain("\\x0a");
      expect(full).not.toMatch(/^\s*input\s*$/m);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O expands each parallel read-only tool detail",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-parallel-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(join(workspace, "README.md"), "READ_FULL_DETAIL_MARKER\n");
    writeFileSync(join(workspace, "LIST_FULL_DETAIL_MARKER"), "");
    writeFileSync(stderrPath, "");

    const gateway = startCodexQueue([
      codexSse([
        { type: "tool-call", toolCallId: "parallel-glob", toolName: "glob_files", input: { pattern: "*" } },
        { type: "tool-call", toolCallId: "parallel-read", toolName: "read_file", input: { path: "README.md" } },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      codexFinalText("PARALLEL_DETAIL_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared read-only tools.");
      await waitForScrollback(active, "PARALLEL_DETAIL_DONE");

      await active.sendKeys("C-o");
      await active.waitForText("LIST_FULL_DETAIL_MARKER", TIMEOUT);
      const firstDetail = await active.capturePane();
      expect(firstDetail).toContain("LIST_FULL_DETAIL_MARKER");
      expect(firstDetail).toContain("Full detail · ctrl o close · PgUp/PgDn scroll · Esc close");
      expect(firstDetail).not.toMatch(/^\s*input\s*$/m);

      await active.waitForText("READ_FULL_DETAIL_MARKER", TIMEOUT);
      const full = await active.capturePane();
      expect(full).toContain("READ_FULL_DETAIL_MARKER");
      expect(full).not.toMatch(/^\s*input\s*$/m);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "a file approval takes over Ctrl-O and resolves back to the inline transcript",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-approval-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o-file-approval.fibertape");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({
        sandbox: "none",
        permission_mode: "ask",
        permission: {},
      }),
    );
    writeFileSync(stderrPath, "");

    const priorSummary = "CTRL_O_FILE_PRIOR_SUMMARY";
    const priorCommand = "zsh -lc 'for i in {1..650}; do printf \"CTRL_O_FILE_FOLD_%04d: preserve full scrollback semantics\\n\" \"$i\"; done'";
    const fileContent = Array.from(
      { length: 80 },
      (_, index) => `handoff scrollback line ${String(index + 1).padStart(3, "0")}`,
    ).join("\\n");
    const finalReply = `${Array.from(
      { length: 80 },
      () => "The denied write remains visible while this streamed assistant response advances the compact transcript window.",
    ).join(" ")} CTRL_O_HANDOFF_DONE`;
    const gateway = startCodexQueue([
      fakeShellRun("ctrl-o-handoff-prior", priorCommand),
      codexFinalText(priorSummary),
      codexSse([
        {
          type: "tool-call",
          toolCallId: "ctrl-o-handoff-command",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command: "sh -c 'sleep 5; printf \"CTRL_O_HANDOFF_READY\\n\"'",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        {
          type: "tool-call",
          toolCallId: "ctrl-o-handoff-write",
          toolName: "write_file",
          input: {
            path: "ctrl-o-handoff.txt",
            content: fileContent,
          },
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      codexFinalText(finalReply),
    ]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: tapePath },
        stderrPath,
        width: 100,
        height: 30,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared folded output command.");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      const beforeHandoff = await waitForScrollback(active, priorSummary);
      expect(beforeHandoff).not.toContain("lines more (ctrl o to view)");
      expect(countOccurrences(beforeHandoff, priorSummary)).toBe(1);
      const compactOutputRows = beforeHandoff.match(/CTRL_O_FILE_FOLD_\d{4}/g) ?? [];
      expect(compactOutputRows).toHaveLength(0);
      expect(beforeHandoff).not.toContain("CTRL_O_FILE_FOLD_0006");
      expect(beforeHandoff).not.toContain("CTRL_O_FILE_FOLD_0650");
      for (const line of compactOutputRows) {
        expect(countOccurrences(beforeHandoff, line)).toBe(1);
      }

      await active.sendText("Run the prepared command and then write the file.");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      await active.waitForText("Running", TIMEOUT);
      await active.sendKeys("C-o");
      await Bun.sleep(150);
      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      await active.waitForText("Apply this change?", TIMEOUT);

      await active.sendKeys("3");
      await active.sendKeys("Enter");
      await active.waitForText("CTRL_O_HANDOFF_DONE", TIMEOUT);
      const scrollback = await active.waitForStableScrollback(
        (value) =>
          value.includes("CTRL_O_HANDOFF_DONE") &&
          countOccurrences(value, priorSummary) === 1,
        TIMEOUT,
      );
      const inline = await active.capturePane();
      expect(inline).toContain("CTRL_O_HANDOFF_DONE");
      expect(inline).not.toContain("Apply this change?");
      expect(countOccurrences(scrollback, priorSummary)).toBe(1);
      for (const line of compactOutputRows) {
        const occurrences = countOccurrences(scrollback, line);
        expect(occurrences).toBeGreaterThanOrEqual(1);
        expect(occurrences).toBeLessThanOrEqual(2);
      }
      const tape = readFileSync(tapePath).toString("latin1");
      expect(countOccurrences(tape, "\x1b[?1049h")).toBe(1);
      expect(countOccurrences(tape, "\x1b[?1049l")).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
      passed = true;
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained Ctrl-O file-approval artifacts at ${root}`);
      }
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "a shell approval takes over Ctrl-O and accepts its choice inline",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-shell-approval-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "ask", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const gateway = startCodexQueue([
      async () => {
        await Bun.sleep(300);
        return fakeShellRun(
          "ctrl-o-shell-approval",
          "sh -c 'printf \"CTRL_O_SHELL_APPROVAL_RAN\\n\"'",
        );
      },
      codexFinalText("CTRL_O_SHELL_APPROVAL_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared shell command.");
      await active.sendKeys("C-o");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);

      await active.sendKeys("1");
      await active.sendKeys("Enter");
      await active.waitForText("CTRL_O_SHELL_APPROVAL_DONE", TIMEOUT);
      const inline = await active.capturePane();
      expect(inline).toContain("CTRL_O_SHELL_APPROVAL_DONE");
      expect(inline).not.toContain("Would you like to run the following command?");
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

test.skipIf(!tmuxAvailable())(
  "a shell approval handoff does not duplicate a long Ctrl-O transcript in scrollback",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-handoff-scrollback-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const actionTimeout = 8_000;
    const transcriptTimeout = 90_000;
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "ask", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const bulletMarker = "CTRL_O_SCROLLBACK_BULLET_120";
    const codeMarker = "const CTRL_O_SCROLLBACK_FINAL_ZIG = true;";
    const markdownLines = ["# Ctrl-O scrollback handoff", ""];
    for (let index = 1; index <= 120; index += 1) {
      markdownLines.push(
        `- CTRL_O_SCROLLBACK_BULLET_${String(index).padStart(3, "0")} has enough prose to wrap across the terminal width and exercise the rendered Markdown tail.`,
      );
      if (index % 40 === 0) {
        markdownLines.push(
          "",
          "```zig",
          "const transcript = @import(\"transcript\");",
          "const renderer = @import(\"renderer\");",
          "const layout = @import(\"layout\");",
          "const writer = @import(\"writer\");",
          "const rows = 120;",
          "const stable = true;",
          "const active = false;",
          index === 120 ? codeMarker : `const CTRL_O_SCROLLBACK_CODE_${index} = true;`,
          "_ = transcript;",
          "_ = renderer;",
          "_ = layout;",
          "_ = writer;",
          "_ = rows;",
          "_ = stable;",
          "_ = active;",
          "```",
          "",
        );
      }
    }
    const markdown = markdownLines.join("\n");
    const streamedMarkdown = () => {
      const encoder = new TextEncoder();
      const chunks = Array.from(
        { length: Math.ceil(markdown.length / 240) },
        (_, index) => markdown.slice(index * 240, (index + 1) * 240),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const ctx = createCodexStreamCtx();
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(codexEventLines({ type: "text-delta", delta: chunk }, ctx)[0]!));
              await Bun.sleep(10);
            }
            controller.enqueue(encoder.encode(codexEventLines({
              type: "finish",
              usage: { inputTokens: { total: 3 }, outputTokens: { total: 5 } },
            }, ctx)[0]!));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const gateway = startCodexQueue([
      streamedMarkdown,
      codexSse([
        {
          type: "tool-call",
          toolCallId: "ctrl-o-handoff-first",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command: "sh -c 'touch ctrl-o-handoff-first; printf \"CTRL_O_HANDOFF_FIRST_RUNNING\\n\"; sleep 1; printf \"CTRL_O_HANDOFF_FIRST_DONE\\n\"'",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        {
          type: "tool-call",
          toolCallId: "ctrl-o-handoff-second",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command: "touch ctrl-o-handoff-second && printf 'CTRL_O_HANDOFF_SECOND_DONE\\n'",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      codexFinalText("CTRL_O_HANDOFF_SCROLLBACK_DONE"),
    ]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 30,
        startupWaitMs: 0,
      });
      await active.waitForComposer(actionTimeout);
      await active.sendText("Return the prepared Markdown response.");
      await waitForScrollback(active, "CTRL_O_SCROLLBACK_BULLET_004");

      await active.sendKeys("C-o");
      await Bun.sleep(150);
      await active.waitForText("┃ Full detail · ctrl o close", actionTimeout);
      await active.sendHexBytes(
        Array.from({ length: 20 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.waitForText(bulletMarker, transcriptTimeout);

      await active.sendText("Run the prepared two commands.");
      await active.waitForText("Would you like to run the following command?", actionTimeout);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      await active.waitForText("CTRL_O_HANDOFF_FIRST_RUNNING", actionTimeout);
      const beforeHandoff = await active.captureFullScrollback();
      expect(countOccurrences(beforeHandoff, bulletMarker)).toBe(1);
      expect(countOccurrences(beforeHandoff, codeMarker)).toBe(1);

      await active.sendKeys("C-o");
      await Bun.sleep(150);
      await active.waitForText("Would you like to run the following command?", actionTimeout);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      await waitForScrollback(active, "CTRL_O_HANDOFF_SCROLLBACK_DONE");
      await active.waitForPane(
        (pane) =>
          pane.includes("CTRL_O_HANDOFF_SCROLLBACK_DONE") &&
          !pane.includes("Streaming ("),
        actionTimeout,
      );
      const scrollback = await active.captureFullScrollback();

      expect(countOccurrences(scrollback, bulletMarker)).toBe(1);
      expect(countOccurrences(scrollback, codeMarker)).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd(5_000)).toBe(true);
      active = null;
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "Ctrl-O pressure preserves transcript and modal ownership under deterministic load",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-full-transcript-pressure-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tapePath = join(root, "ctrl-o-pressure.fibertape");
    const seedPath = join(root, "seed.txt");
    const scrollbackPath = join(root, "scrollback.txt");
    const ansiScrollbackPath = join(root, "scrollback.ansi.txt");
    const releasePath = join(workspace, ".ctrl-o-pressure-release");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "ask", permission: {} }),
    );
    writeFileSync(stderrPath, "");
    writeFileSync(seedPath, "9767\n");

    const setupSentinel = "CTRL_O_PRESSURE_SETUP_DONE";
    const finalSentinel = "CTRL_O_PRESSURE_FINAL_DONE";
    const assistantHead = "CTRL_O_PRESSURE_ASSISTANT_001";
    const assistantTail = "CTRL_O_PRESSURE_ASSISTANT_048";
    const setupCompactLine = "CTRL_O_PRESSURE_SETUP_OUTPUT_005";
    const setupFullLine = "CTRL_O_PRESSURE_SETUP_OUTPUT_070";
    const activeStart = "CTRL_O_PRESSURE_ACTIVE_START";
    const streamPrefix = "CTRL_O_PRESSURE_STREAM_";
    const streamGate = "CTRL_O_PRESSURE_STREAM_GATE";
    const activeDone = "CTRL_O_PRESSURE_ACTIVE_DONE";
    const questionMarker = "CTRL_O_PRESSURE_QUESTION";
    const questionAnswerInstruction = "Enter Answer";
    const questionCancelInstruction = "Esc Cancel";
    const composerProbe = "CTRL_O_PRESSURE_COMPOSER_READY";
    const setupCommand =
      "awk 'BEGIN { for (i = 1; i <= 72; i++) printf \"CTRL_O_PRESSURE_SETUP_OUTPUT_%03d: retained command history\\n\", i }'";
    const assistantHistory = Array.from(
      { length: 48 },
      (_, index) =>
        `CTRL_O_PRESSURE_ASSISTANT_${String(index + 1).padStart(3, "0")}: retained assistant history`,
    ).join("\n");
    const activeCommand = [
      "sh -c '",
      `printf \"${activeStart}\\n\"; `,
      `i=1; while [ \"$i\" -le 6 ]; do printf \"${streamPrefix}%03d\\n\" \"$i\"; i=$((i + 1)); done; `,
      `printf \"${streamGate}\\n\"; `,
      "while [ ! -f .ctrl-o-pressure-release ]; do sleep 0.02; done; ",
      `while [ \"$i\" -le 18 ]; do printf \"${streamPrefix}%03d\\n\" \"$i\"; i=$((i + 1)); done; `,
      `printf \"${activeDone}\\n\"'`,
    ].join("");
    const fileContent = Array.from(
      { length: 96 },
      (_, index) =>
        `CTRL_O_PRESSURE_FILE_${String(index + 1).padStart(3, "0")}: pending review content`,
    ).join("\n");

    let releaseQuestion!: () => void;
    const questionGate = new Promise<void>((resolve) => {
      releaseQuestion = resolve;
    });
    const gatedQuestion = async () => {
      await questionGate;
      return codexToolCall("ctrl-o-pressure-question", "ask_user_question", {
        questions: [
          {
            question: questionMarker,
            options: [
              { label: "Continue", description: "Finish the deterministic pressure flow." },
              { label: "Stop", description: "Stop the deterministic pressure flow." },
            ],
          },
        ],
      });
    };
    const gateway = startCodexQueue([
      fakeShellRun("ctrl-o-pressure-setup", setupCommand),
      codexFinalText(`${assistantHistory}\n${setupSentinel}`),
      codexSse([
        {
          type: "tool-call",
          toolCallId: "ctrl-o-pressure-command",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command: activeCommand,
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        {
          type: "tool-call",
          toolCallId: "ctrl-o-pressure-write",
          toolName: "write_file",
          input: { path: "ctrl-o-pressure.txt", content: fileContent },
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      gatedQuestion,
      codexFinalText(finalSentinel),
    ]);

    const tapeText = () => existsSync(tapePath) ? readFileSync(tapePath).toString("latin1") : "";
    const alternateDepthAt = (tape: string, end = tape.length): number => {
      let depth = 0;
      for (const transition of tape.slice(0, end).matchAll(/\x1b\[\?1049([hl])/g)) {
        depth += transition[1] === "h" ? 1 : -1;
      }
      return depth;
    };
    const pressureRows = (scrollback: string): string[] =>
      scrollback.split("\n").filter((line) =>
        line.includes("CTRL_O_PRESSURE_ASSISTANT_") ||
        line.includes(setupSentinel)
      ).map((line) => line.trimEnd());

    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
        },
        stderrPath,
        width: 104,
        height: 28,
        remainOnExit: true,
        startupWaitMs: 0,
      });
      await active.waitForComposer(TIMEOUT);

      await active.sendText("Build the prepared pressure history.");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      const setupScrollback = await waitForScrollbackMarkers(active, [
        assistantHead,
        assistantTail,
        setupSentinel,
      ]);
      expect(setupScrollback).toContain(assistantHead);
      expect(setupScrollback).toContain(assistantTail);
      expect(setupScrollback).not.toContain(setupCompactLine);
      expect(setupScrollback).not.toContain(setupFullLine);
      expect(setupScrollback).not.toContain("lines more (ctrl o to view)");

      await active.sendText("Run the prepared streaming command and file review.");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      await active.waitForPane(
        (pane) =>
          pane.includes("Running sh -c") &&
          !pane.includes(`${streamPrefix}004`),
        TIMEOUT,
      );
      const compactRowsBeforeNavigation = pressureRows(await active.captureFullScrollback());

      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 1,
        "Ctrl-O to enter the alternate screen",
      );
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendHexBytes(["1b", "5b", "36", "7e"]);
      const tailViewport = await active.waitForText(streamGate, TIMEOUT);
      expect(tailViewport).toContain(streamGate);

      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      const pageUpViewport = await active.waitForPane(
        (pane) => pane !== tailViewport && pane.includes("CTRL_O_PRESSURE_ASSISTANT_"),
        TIMEOUT,
      );
      expect(pageUpViewport).not.toEqual(tailViewport);

      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      await active.sendHexBytes(["1b", "5b", "35", "7e"]);
      const priorCommandViewport = await active.waitForPane(
        (pane) =>
          pane !== pageUpViewport &&
          pane.includes("CTRL_O_PRESSURE_SETUP_OUTPUT_055"),
        TIMEOUT,
      );
      expect(priorCommandViewport).not.toEqual(pageUpViewport);

      for (let index = 0; index < 2; index += 1) {
        await active.sendHexBytes(["1b", "5b", "3c", "36", "35", "3b", "31", "3b", "31", "4d"]);
      }
      await active.waitForPane(
        (pane) => pane !== priorCommandViewport && pane.includes(setupFullLine),
        TIMEOUT,
      );
      for (let index = 0; index < 6; index += 1) {
        await active.sendHexBytes(["1b", "5b", "36", "7e"]);
      }
      const pageDownViewport = await active.waitForPane(
        (pane) => pane !== priorCommandViewport && pane.includes(streamGate),
        TIMEOUT,
      );
      expect(pageDownViewport).not.toEqual(priorCommandViewport);

      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 0,
        "Ctrl-O to restore compact history",
      );
      expect(pressureRows(await active.captureFullScrollback())).toEqual(
        compactRowsBeforeNavigation,
      );

      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 1,
        "the repeated Ctrl-O entry",
      );
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 0,
        "the repeated Ctrl-O exit",
      );
      expect(pressureRows(await active.captureFullScrollback())).toEqual(
        compactRowsBeforeNavigation,
      );

      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 1,
        "Ctrl-O to reopen before the file handoff",
      );
      writeFileSync(releasePath, "release\n");
      await waitForCondition(
        () => tapeText().includes(activeDone),
        "the gated command stream to finish",
      );
      await active.waitForText("Apply this change?", TIMEOUT);
      const fileApprovalTape = tapeText();
      const fileApprovalOffset = fileApprovalTape.lastIndexOf("Apply this change?");
      expect(fileApprovalOffset).toBeGreaterThanOrEqual(0);
      expect(alternateDepthAt(fileApprovalTape, fileApprovalOffset)).toBe(1);

      await active.sendKeys("3");
      await active.sendKeys("Enter");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 0,
        "file approval rejection to restore inline ownership",
      );
      const afterFileRejection = await active.waitForPane(
        (pane) =>
          pane.includes("Ran sh -c") &&
          !pane.includes("Apply this change?"),
        TIMEOUT,
      );
      expect(afterFileRejection).not.toContain(questionMarker);
      expect(existsSync(join(workspace, "ctrl-o-pressure.txt"))).toBe(false);

      await active.sendKeys("C-o");
      await waitForCondition(
        () => alternateDepthAt(tapeText()) === 1,
        "Ctrl-O to reopen before the question handoff",
      );
      releaseQuestion();
      await active.waitForText(questionMarker, TIMEOUT);
      const questionTape = tapeText();
      const questionOffset = questionTape.lastIndexOf(questionMarker);
      expect(questionOffset).toBeGreaterThanOrEqual(0);
      expect(alternateDepthAt(questionTape, questionOffset)).toBe(0);
      const questionPane = await active.capturePane();
      expect(questionPane).toContain(questionAnswerInstruction);
      expect(questionPane).toContain(questionCancelInstruction);
      expect(questionPane).not.toContain("Apply this change?");

      await active.sendLiteralText("1");
      await active.sendKeys("Enter");
      const finalScrollback = await waitForScrollback(active, finalSentinel);
      const finalPane = await active.capturePane();
      expect(finalScrollback).toContain(assistantHead);
      expect(finalScrollback).toContain(assistantTail);
      expect(finalScrollback).not.toContain(setupCompactLine);
      expect(finalScrollback).not.toContain(setupFullLine);
      expect(finalScrollback).toContain(`\n  1) ${questionMarker}`);
      expect(countOccurrences(finalScrollback, setupSentinel)).toBe(1);
      expect(countOccurrences(finalScrollback, finalSentinel)).toBe(1);
      for (let index = 1; index <= 4; index += 1) {
        const outputRow = `│ ${streamPrefix}${String(index).padStart(3, "0")}`;
        expect(countOccurrences(finalScrollback, outputRow)).toBe(0);
      }
      for (let index = 5; index <= 18; index += 1) {
        const outputRow = `│ ${streamPrefix}${String(index).padStart(3, "0")}`;
        expect(countOccurrences(finalScrollback, outputRow)).toBe(0);
      }
      expect(countOccurrences(finalScrollback, `│ ${activeStart}`)).toBe(0);
      expect(countOccurrences(finalScrollback, `│ ${streamGate}`)).toBe(0);
      expect(countOccurrences(finalScrollback, `│ ${activeDone}`)).toBe(0);
      expect(finalScrollback).not.toContain("lines more (ctrl o to view)");
      expect(finalPane).not.toContain("Apply this change?");
      expect(finalPane).not.toContain(questionAnswerInstruction);
      expect(finalPane).not.toContain(questionCancelInstruction);
      expect(gateway.requests).toHaveLength(5);

      await active.sendLiteralText(composerProbe);
      await active.waitForText(composerProbe, TIMEOUT);
      await active.sendKeys("C-u");
      const clearedComposer = await active.waitForPane(
        (pane) =>
          pane.includes(finalSentinel) &&
          hasEmptyComposer(pane) &&
          !pane.includes(composerProbe),
        TIMEOUT,
      );
      expect(clearedComposer).not.toContain("Apply this change?");
      expect(clearedComposer).not.toContain(questionAnswerInstruction);
      expect(clearedComposer).not.toContain(questionCancelInstruction);

      const finalTape = tapeText();
      let alternateDepth = 0;
      let maximumAlternateDepth = 0;
      let alternateEnters = 0;
      let alternateLeaves = 0;
      for (const transition of finalTape.matchAll(/\x1b\[\?1049([hl])/g)) {
        if (transition[1] === "h") {
          alternateDepth += 1;
          alternateEnters += 1;
          maximumAlternateDepth = Math.max(maximumAlternateDepth, alternateDepth);
        } else {
          alternateDepth -= 1;
          alternateLeaves += 1;
        }
        expect(alternateDepth).toBeGreaterThanOrEqual(0);
      }
      expect(maximumAlternateDepth).toBe(1);
      expect(alternateEnters).toBeGreaterThanOrEqual(4);
      expect(alternateLeaves).toBe(alternateEnters);
      expect(alternateDepth).toBe(0);

      await active.sendText("/quit");
      await waitForCondition(
        () => active?.paneStatus().dead === true,
        "fiber to exit after /quit",
      );
      expect(paneExitMatches(active.paneStatus(), 0)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(tapePath)).toBe(true);
      expect(statSync(tapePath).size).toBeGreaterThan(0);

      const replayFrames = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replayFrames.code).toBe(0);
      expect(replayFrames.stderr).toBe("");
      expect(replayFrames.stdout).toContain(setupSentinel);
      expect(replayFrames.stdout).toContain(finalSentinel);
      expect(replayFrames.stdout).toContain(composerProbe);

      const replayFinalGrid = await runFx(["debug", "replay", tapePath], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replayFinalGrid.code).toBe(0);
      expect(replayFinalGrid.stderr).toBe("");
      expect(replayFinalGrid.stdout).toContain(finalSentinel);
      expect(replayFinalGrid.stdout).not.toContain("Apply this change?");
      expect(replayFinalGrid.stdout).not.toContain(questionAnswerInstruction);
      expect(replayFinalGrid.stdout).not.toContain(questionCancelInstruction);
      passed = true;
    } finally {
      releaseQuestion();
      if (active) {
        try {
          writeFileSync(scrollbackPath, await active.captureFullScrollback());
          writeFileSync(ansiScrollbackPath, await active.captureFullScrollbackEscapes());
        } catch {}
        await active.kill();
      }
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained Ctrl-O pressure artifacts at ${root}`);
      }
    }
  },
  TIMEOUT * 2,
);
