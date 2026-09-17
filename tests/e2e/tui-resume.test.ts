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
  HoldState,
  SEMANTIC_TABLE_ROWS,
  SemanticObservation,
  TAG_FLAG_SYMBOL,
  TIMEOUT,
  UPGRADE_TIMEOUT,
  codexSse,
  countOccurrences,
  expectAlignedSemanticCards,
  expectAlignedSemanticTable,
  expectSemanticTableRows,
  fakeShellRun,
  findPaginatedSemanticFieldLines,
  hasSemanticSymbol,
  heldCodexResponse,
  semanticColumnsMatch,
  sessionIdFromHome,
  shellQuote,
  startCodexQueue,
  startUpgradeServer,
  stripAnsi,
  visibleSessionPickerEntries,
  waitForCommittedSessionMarker,
  waitForCondition,
  waitForPersistedSessionMarker,
  waitForScrollback,
  waitForSessionPicker,
  waitForSessionPickerClosed,
  normalizeVolatileStatusRows,
} from "./tui-resume-helpers";

test("Linux tmux fallbacks preserve exact ASCII and replay alignment", () => {
  const keycap = SEMANTIC_TABLE_ROWS.find((row) => row.type === "Keycap")!;
  const tag = SEMANTIC_TABLE_ROWS.find((row) => row.type === "Tag")!;
  const zwj = SEMANTIC_TABLE_ROWS.find((row) => row.type === "ZWJ")!;
  const cjk = SEMANTIC_TABLE_ROWS.find((row) => row.type === "CJK")!;
  const ascii = SEMANTIC_TABLE_ROWS.find((row) => row.type === "ASCII")!;
  const partialTagFlag = "\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc65\udb40\udc6e";
  expect(hasSemanticSymbol("#\ufe0f", keycap, "tmux", "linux")).toBe(true);
  expect(hasSemanticSymbol("#\ufe0f", keycap, "replay", "linux")).toBe(false);
  expect(hasSemanticSymbol(partialTagFlag, tag, "tmux", "linux")).toBe(true);
  expect(hasSemanticSymbol("\ud83d\udc69", zwj, "tmux", "linux")).toBe(true);
  expect(hasSemanticSymbol("", tag, "tmux", "linux")).toBe(false);
  expect(hasSemanticSymbol("", zwj, "tmux", "linux")).toBe(false);
  expect(hasSemanticSymbol(partialTagFlag, tag, "replay", "linux")).toBe(false);
  expect(hasSemanticSymbol("\ud83d\udc69", zwj, "replay", "linux")).toBe(false);
  expect(hasSemanticSymbol(TAG_FLAG_SYMBOL, tag, "replay", "linux")).toBe(true);

  const aligned = [2, 14, 23, 48];
  const linuxPlaceholder = [2, 14, 20, 45];
  const linuxWrappedPlaceholder = [2, 14];
  const linuxShiftedPlaceholder = [2, 11, 20, 45];
  const linuxBorderlessPlaceholder: number[] = [];
  expect(semanticColumnsMatch(
    keycap,
    aligned,
    linuxPlaceholder,
    "tmux",
    "linux",
  )).toBe(true);
  expect(semanticColumnsMatch(
    tag,
    aligned,
    linuxWrappedPlaceholder,
    "tmux",
    "linux",
  )).toBe(true);
  expect(semanticColumnsMatch(
    zwj,
    aligned,
    linuxShiftedPlaceholder,
    "tmux",
    "linux",
  )).toBe(true);
  expect(semanticColumnsMatch(
    cjk,
    aligned,
    linuxPlaceholder,
    "tmux",
    "linux",
  )).toBe(true);
  expect(semanticColumnsMatch(
    cjk,
    aligned,
    linuxWrappedPlaceholder,
    "tmux",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    cjk,
    aligned,
    [2, 8, 14, 20, 45],
    "tmux",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    cjk,
    aligned,
    linuxPlaceholder,
    "replay",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    zwj,
    aligned,
    linuxBorderlessPlaceholder,
    "tmux",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    zwj,
    aligned,
    [3, 14],
    "tmux",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    keycap,
    aligned,
    linuxPlaceholder,
    "replay",
    "linux",
  )).toBe(false);
  expect(semanticColumnsMatch(
    ascii,
    aligned,
    linuxPlaceholder,
    "tmux",
    "linux",
  )).toBe(false);
});

test("paginated semantic field lookup matches values across split cards", () => {
  const tag = SEMANTIC_TABLE_ROWS.find((row) => row.type === "Tag")!;
  const lines = [
    "│Type: Previous",
    "│Symbol: WRONG",
    "│Description: RGI tag flag",
    "│Type: Tag",
    `│Symbol: ${TAG_FLAG_SYMBOL}`,
    "│wrapped detail one",
    "│wrapped detail two",
    "│wrapped detail three",
    "│Description: Previous row",
  ];
  expect(findPaginatedSemanticFieldLines(lines, tag, "tmux")).toEqual({
    symbolLine: `│Symbol: ${TAG_FLAG_SYMBOL}`,
    descriptionLine: "│Description: RGI tag flag",
  });
});

async function waitForChangedPane(
  session: TmuxSession,
  previous: string,
  timeout = 10_000,
): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pane = await session.capturePane();
    if (pane !== previous) return pane;
    await Bun.sleep(25);
  }
  return null;
}

async function collectFullTranscriptPages(
  session: TmuxSession,
  maxPages = 16,
): Promise<string> {
  const first = await session.capturePane();
  const pages = [first];
  let previous = first;
  for (let index = 1; index < maxPages; index += 1) {
    await session.sendHexBytes(["1b", "5b", "35", "7e"]);
    const pane = await waitForChangedPane(session, previous);
    if (pane === null) {
      console.log(
        `waitForChangedPane expired after collecting ${pages.length} of ${maxPages} pages; stopping pagination`,
      );
      break;
    }
    pages.push(pane);
    previous = pane;
  }
  return pages.join("\n");
}

function expectRenderedMarkdown(
  scrollback: string,
  observation: SemanticObservation,
): void {
  expect(scrollback).toContain("Resume Markdown Probe");
  expect(scrollback).toContain("RESUME_MARKDOWN_TOP_MARKER");
  expect(scrollback).toContain("✓ RESUME_MARKDOWN_TASK_MARKER");
  expect(scrollback).toContain("REPRO_TABLE_01");
  expect(scrollback).toContain("REPRO_TABLE_08");
  expect(scrollback).toContain("REPRO_TABLE_14");
  expect(scrollback).toContain("┌");
  expect(scrollback).toContain("const CODE_LINE_01 = 1;");
  expect(scrollback).toContain("const CODE_FINAL_MARKER = 18;");
  expect(scrollback).not.toContain("## Resume Markdown Probe");
  expect(scrollback).not.toContain("- [x] RESUME_MARKDOWN_TASK_MARKER");
  expect(scrollback).not.toContain("| Row | Value |");
  expect(scrollback).not.toContain("| --- | --- |");
  expect(scrollback).not.toContain("```zig");
  expect(scrollback).not.toContain("18;❯");
  expectSemanticTableRows(scrollback, observation);
}

function expectInferredTypeScriptCodeBlock(scrollback: string): void {
  expect(scrollback).toContain("─ ts ─");
  expect(scrollback).toContain("inferredHook = await");
  expect(scrollback).toContain("{ cleanup: true } as");
  expect(scrollback).toContain("nupSignal)");
}

function expectInferredTypeScriptColors(scrollback: string): void {
  expect(scrollback).toContain("\x1b[38;5;252mconst\x1b[39m");
  expect(scrollback).toContain("\x1b[38;5;252mawait\x1b[39m");
}

function expectExpandedCodeProfiles(scrollback: string): void {
  expect(scrollback).toContain("─ json ─");
  expect(scrollback).toContain('"json_ready"');
  expect(scrollback).toContain("─ python ─");
  expect(scrollback).toContain("def render_ready");
}

function expectExpandedCodeColors(scrollback: string): void {
  expect(scrollback).toContain("\x1b[38;5;252mdef\x1b[39m");
  expect(scrollback).toContain("\x1b[38;5;250m\"json_ready\"\x1b[39m");
}

function expectNoRawToolReplay(scrollback: string): void {
  expect(scrollback).not.toContain("Previous tool execution");
  expect(scrollback).not.toContain("[system] Previous tool execution");
}

test("volatile status rows normalize before stable-grid comparison", () => {
  expect(normalizeVolatileStatusRows(["• Streaming (↑6 ↓5)"])).toEqual(["<status>"]);
  expect(normalizeVolatileStatusRows(["  (↑6 ↓5)"])).toEqual(["<status>"]);
  expect(normalizeVolatileStatusRows(["  0s (↑6 ↓5)"])).toEqual(["<status>"]);
});
test.skipIf(!tmuxAvailable())(
  "contended startup resume stays non-interactive and recovers after release",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-contended-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const ownerStderrPath = join(root, "owner-stderr.log");
    const contenderStderrPath = join(root, "contender-stderr.log");
    const retryStderrPath = join(root, "retry-stderr.log");
    const contenderTapePath = join(root, "contender.fibertape");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const savedMarker = "CONTENDED_RESUME_SAVED_MARKER";
    const ownerGateway = startCodexQueue([codexFinalText(savedMarker)]);
    const retryGateway = startCodexQueue([]);
    let owner: TmuxSession | null = null;
    let contender: TmuxSession | null = null;
    let retry: TmuxSession | null = null;
    let passed = false;

    try {
      writeFileSync(ownerStderrPath, "");
      owner = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, ownerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: ownerStderrPath,
      });
      await owner.waitForComposer(TIMEOUT);
      await owner.sendText("Save the contended resume fixture.");
      await owner.waitForText(savedMarker, TIMEOUT);
      expect(owner.isPaneAlive()).toBe(true);

      writeFileSync(contenderStderrPath, "");
      contender = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: workspaceRoot,
        env: {
          ...seededFakeCodexEnv(home, ownerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: contenderTapePath,
          FIBER_RECORD_INPUT: "1",
        },
        stderrPath: contenderStderrPath,
        remainOnExit: true,
      });
      await contender.sendLiteralText("/");
      await contender.sendLiteralText("/");
      await waitForCondition(
        () => contender?.paneStatus().dead === true,
        "contended resume to exit",
      );

      expect(paneExitMatches(contender.paneStatus(), 1)).toBe(true);
      expect(readFileSync(contenderStderrPath, "utf8")).toBe(
        "fiber: another fiber process may be using this session (running or suspended); check other terminals or run jobs, then use fg or quit that process\n",
      );
      expect(owner.isPaneAlive()).toBe(true);
      const contenderScrollback = await contender.captureFullScrollback();
      expect(contenderScrollback).not.toContain("❯");
      expect(contenderScrollback).not.toContain("┃");
      expect(contenderScrollback).not.toContain("show available slash commands");
      const contenderReplay = await runFx(["debug", "replay", contenderTapePath, "--frames"], {
        cwd: workspaceRoot,
        env: { HOME: home },
      });
      expect(contenderReplay.code).toBe(0);
      expect(contenderReplay.stderr).toBe("");
      expect(contenderReplay.stdout).not.toContain("❯");
      expect(contenderReplay.stdout).not.toContain("┃");
      expect(contenderReplay.stdout).not.toContain("show available slash commands");
      const contenderFrames = readTapeFrames(contenderTapePath);
      const contenderStdout = Buffer.concat(
        contenderFrames.filter((frame) => frame.kind === 1).map((frame) => frame.payload),
      ).toString("binary");
      expect(contenderStdout).not.toContain("\x1b[?2026h");
      expect(contenderFrames.filter((frame) => frame.kind === 2)).toHaveLength(0);

      await owner.sendText("/quit");
      expect(await owner.waitForSessionEnd()).toBe(true);
      await owner.kill();
      owner = null;

      writeFileSync(retryStderrPath, "");
      retry = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, retryGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: retryStderrPath,
      });
      await retry.waitForComposer(TIMEOUT);
      const resumedScrollback = await waitForScrollback(retry, savedMarker);
      expect(resumedScrollback).toContain(savedMarker);
      const composerRows = (await retry.capturePaneGrid()).filter(isEmptyComposerLine);
      expect(composerRows).toHaveLength(1);

      await retry.sendLiteralText("/");
      await retry.waitForText("show available slash commands", TIMEOUT);
      await retry.sendLiteralText("/");
      await retry.waitForPane(
        (pane) =>
          pane.split("\n").some((row) => /^┃ \/\/$/.test(row)) &&
          !pane.includes("show available slash commands"),
        TIMEOUT,
      );
      expect(retry.isPaneAlive()).toBe(true);
      await retry.sendKeys("C-u");
      await retry.sendText("/quit");
      expect(await retry.waitForSessionEnd()).toBe(true);
      expect(readFileSync(retryStderrPath, "utf8")).toBe("");
      await retry.kill();
      retry = null;
      passed = true;
    } finally {
      if (owner) await owner.kill();
      if (contender) await contender.kill();
      if (retry) await retry.kill();
      ownerGateway.stop();
      retryGateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained contended resume artifacts at ${root}`);
      }
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "interactive resume shows session contention and retries the preserved selection",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-interactive-contention-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const ownerStderrPath = join(root, "owner-stderr.log");
    const contenderStderrPath = join(root, "contender-stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const savedMarker = "INTERACTIVE_CONTENTION_SAVED_MARKER";
    const savedTitle = "Save the interactive contention fixture.";
    const ownerGateway = startCodexQueue([codexFinalText(savedMarker)]);
    const contenderGateway = startCodexQueue([]);
    let owner: TmuxSession | null = null;
    let contender: TmuxSession | null = null;

    try {
      writeFileSync(ownerStderrPath, "");
      owner = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, ownerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: ownerStderrPath,
        width: 100,
        height: 30,
      });
      await owner.waitForComposer(TIMEOUT);
      await owner.sendText(savedTitle);
      await owner.waitForText(savedMarker, TIMEOUT);

      writeFileSync(contenderStderrPath, "");
      contender = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, contenderGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: contenderStderrPath,
        width: 100,
        height: 30,
      });
      await contender.waitForComposer(TIMEOUT);
      await contender.sendText("/resume");
      await waitForSessionPicker(contender);
      await contender.waitForText(savedTitle, TIMEOUT);
      const contentionStartedAt = Date.now();
      await contender.sendKeys("Enter");
      await contender.waitForPane(
        (pane) => stripAnsi(pane).includes(
          "This session is open in another fiber. Close it there, then press Enter to retry.",
        ),
        1_000,
      );
      expect(Date.now() - contentionStartedAt).toBeLessThan(1_000);

      const contendedPicker = stripAnsi(await contender.capturePane());
      expect(contendedPicker).toContain(savedTitle);
      expect(contendedPicker).toContain(
        "This session is open in another fiber. Close it there, then press Enter to retry.",
      );
      expect(contendedPicker).not.toContain("SessionBusy");
      const contendedEntries = visibleSessionPickerEntries(
        await contender.capturePaneEscapes(),
      );
      expect(contendedEntries).toHaveLength(1);
      expect(contendedEntries[0]!.selected).toBe(true);
      expect(owner.isPaneAlive()).toBe(true);
      expect(contender.isPaneAlive()).toBe(true);
      expect(readFileSync(ownerStderrPath, "utf8")).toBe("");
      expect(readFileSync(contenderStderrPath, "utf8")).toBe("");

      await owner.sendText("/quit");
      expect(await owner.waitForSessionEnd()).toBe(true);
      await owner.kill();
      owner = null;

      await contender.sendKeys("Enter");
      const resumed = await waitForScrollback(contender, savedMarker);
      expect(resumed).toContain(`● Session resumed: ${savedTitle}`);
      expect(resumed).toContain(savedMarker);
      expect(resumed).not.toContain("SessionBusy");
      await waitForSessionPickerClosed(contender);
      expect(contender.isPaneAlive()).toBe(true);
      expect(readFileSync(contenderStderrPath, "utf8")).toBe("");

      await contender.sendText("/quit");
      expect(await contender.waitForSessionEnd()).toBe(true);
      await contender.kill();
      contender = null;
    } finally {
      if (owner) await owner.kill();
      if (contender) await contender.kill();
      ownerGateway.stop();
      contenderGateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "context-deferred scoped tools remain deferred after resume",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-resume-deferred-tools-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const nested = join(workspace, "nested");
    const liveStderrPath = join(root, "live-stderr.log");
    const resumeStderrPath = join(root, "resume-stderr.log");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(join(workspace, "AGENTS.md"), "DEFERRED_TOOL_ROOT_SCOPE\n");
    writeFileSync(join(nested, "AGENTS.md"), "DEFERRED_TOOL_NESTED_SCOPE\n");
    writeFileSync(join(nested, "input.txt"), "deferred tool payload\n");
    writeFileSync(liveStderrPath, "");
    writeFileSync(resumeStderrPath, "");

    const workspaceRoot = realpathSync(workspace);
    const command = "printf 'effectful payload\\n' > output.txt";
    const failureCommand = "printf 'ordinary-failure-control\\n' >&2; exit 7";
    const finalMarker = "DEFERRED_TOOL_RESUME_COMPLETE";
    const gateway = startCodexQueue([
      codexSse([
        { type: "tool-input-start", id: "deferred-read", toolName: "read_file" },
        {
          type: "tool-input-delta",
          id: "deferred-read",
          delta: JSON.stringify({ path: "nested/input.txt" }),
        },
        { type: "tool-input-end", id: "deferred-read" },
        { type: "tool-input-start", id: "deferred-command", toolName: "shell" },
        {
          type: "tool-input-delta",
          id: "deferred-command",
          delta: JSON.stringify({
            request: {
              action: "run",
              command,
              cwd: "nested",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          }),
        },
        { type: "tool-input-end", id: "deferred-command" },
        {
          type: "tool-call",
          toolCallId: "deferred-read",
          toolName: "read_file",
          input: { path: "nested/input.txt" },
        },
        {
          type: "tool-call",
          toolCallId: "deferred-command",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command,
              cwd: "nested",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      codexSse([
        {
          type: "tool-call",
          toolCallId: "reissued-read",
          toolName: "read_file",
          input: { path: "nested/input.txt" },
        },
        {
          type: "tool-call",
          toolCallId: "reissued-command",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command,
              cwd: "nested",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        {
          type: "tool-call",
          toolCallId: "ordinary-failure",
          toolName: "shell",
          input: {
            request: {
              action: "run",
              command: failureCommand,
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
            },
          },
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } },
      ]),
      codexFinalText(finalMarker),
    ]);
    const resumeGateway = startCodexQueue([]);
    let active: TmuxSession | null = null;

    function expectDeferredPresentation(scrollback: string): void {
      expect(scrollback).toContain("1 failed");
      expect(scrollback).toContain("1 deferred");
      expect(scrollback).toContain(`Context updated ${command}`);
      expect(scrollback).not.toContain("Not executed");
      expect(scrollback).not.toContain("├ terminal");
      expect(scrollback).not.toContain("└ terminal");
      expect(scrollback).not.toContain("├ read_file");
      expect(scrollback).not.toContain("└ read_file");
      expect(scrollback).not.toContain("● Failed nested/input.txt");
      expect(scrollback).not.toContain(`● Failed ${command}`);
      expect(scrollback).toContain("Read nested/input.txt");
      expect(scrollback).toContain(`Ran ${command}`);
      expect(scrollback).toContain(`Exited 7 ${failureCommand}`);
      expect(scrollback).not.toContain("│ exit code 7");
    }

    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: liveStderrPath,
        width: 120,
        height: 60,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText(
        "Read nested/input.txt, write nested/output.txt from that directory, and exercise the failure control.",
      );
      await waitForScrollback(active, finalMarker);
      await waitForCondition(
        () => gateway.requests.length === 3,
        "three scoped-tool completion requests",
      );
      const liveScrollback = await active.captureFullScrollback();
      expectDeferredPresentation(liveScrollback);
      expect(liveScrollback).not.toContain("│ ordinary-failure-control");
      expect(readFileSync(liveStderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, resumeGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: resumeStderrPath,
        width: 120,
        height: 60,
      });
      await waitForScrollback(active, finalMarker);
      expectDeferredPresentation(await active.captureFullScrollback());

      await active.sendKeys("C-o");
      const detail = await active.waitForPane(
        (pane) =>
          pane.includes(`Context updated ${command}`) &&
          pane.includes("ordinary-failure-control"),
        TIMEOUT,
      );
      expect(countOccurrences(detail, "Context updated")).toBe(1);
      expect(detail).not.toContain("Not executed");
      expect(detail).not.toContain('{"path":"nested/input.txt"}');
      expect(detail).not.toContain(JSON.stringify({ command, cwd: "nested" }));
      expect(detail).toContain(failureCommand);
      expect(detail).toContain("1 deferred");
      expect(detail).toContain("1 failed");
      expect(readFileSync(resumeStderrPath, "utf8")).toBe("");

      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      gateway.stop();
      resumeGateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "new and resumed sessions drop kill-ring and large-paste backing state",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-input-reset-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(stderrPath, "");
    const gateway = startCodexQueue([
      codexFinalText("SESSION_INPUT_RESET_SAVED"),
      codexFinalText("SESSION_INPUT_RESET_NEW_OK"),
      codexFinalText("SESSION_INPUT_RESET_RESUME_OK"),
    ]);
    let active: TmuxSession | null = null;

    async function seedTransientDraft(marker: string): Promise<void> {
      if (!active) throw new Error("session is not active");
      await active.pasteText(`${marker}_${"x".repeat(1200)}`);
      await active.waitForPane((pane) => pane.includes("[Pasted text #1"), TIMEOUT);
      await active.sendKeys("C-u");
      await active.waitForPane((pane) => hasEmptyComposer(stripAnsi(pane)), TIMEOUT);
    }

    async function proveReset(responseMarker: string, requestIndex: number): Promise<void> {
      if (!active) throw new Error("session is not active");
      await active.sendKeys("C-y");
      await Bun.sleep(100);
      expect(stripAnsi(await active.capturePane())).not.toContain("[Pasted text #1");

      const literalPlaceholder = "[Pasted text #1, 1 line]";
      await active.sendText(literalPlaceholder);
      await active.waitForText(responseMarker, TIMEOUT);
      expect(gateway.requests[requestIndex]?.body).toContain(literalPlaceholder);
      expect(gateway.requests[requestIndex]?.body).not.toContain("STALE_SESSION_DRAFT");
    }

    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 30,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save a session for transient input reset.");
      await active.waitForText("SESSION_INPUT_RESET_SAVED", TIMEOUT);

      await seedTransientDraft("STALE_SESSION_DRAFT_NEW");
      await active.sendText("/new");
      await active.waitForPane((pane) => hasEmptyComposer(stripAnsi(pane)), TIMEOUT);
      await proveReset("SESSION_INPUT_RESET_NEW_OK", 1);

      await seedTransientDraft("STALE_SESSION_DRAFT_RESUME");
      await active.sendText("/resume");
      await waitForSessionPicker(active);
      await active.sendKeys("Enter");
      await waitForSessionPickerClosed(active);
      await proveReset("SESSION_INPUT_RESET_RESUME_OK", 2);

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
  TIMEOUT * 2,
);

function exitHandoffEvidence(
  active: TmuxSession | null,
  home: string,
  stderrPaths: readonly string[],
  tapePath: string,
): string {
  const lines: string[] = [];
  try {
    const status = active?.paneStatus();
    lines.push(`paneDead=${status?.dead} exitStatus=${status?.status}`);
  } catch {
    lines.push("paneStatus=<unavailable>");
  }
  for (const stderrPath of stderrPaths) {
    let text = "<unreadable>";
    try {
      text = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").slice(-8000) : "<missing>";
    } catch {
      text = "<unreadable>";
    }
    lines.push(`stderr ${stderrPath}:\n${text}`);
  }
  let tape = "<missing>";
  try {
    tape = existsSync(tapePath) ? `${statSync(tapePath).size} bytes` : "<missing>";
  } catch {
    tape = "<unreadable>";
  }
  lines.push(`tape ${tapePath}: ${tape}`);
  let sessions = "<unreadable>";
  try {
    const dir = join(home, ".fiber", "sessions");
    sessions = existsSync(dir) ? readdirSync(dir).join(", ") : "<no sessions dir>";
  } catch {
    sessions = "<unreadable>";
  }
  lines.push(`sessions: ${sessions}`);
  return lines.join("\n");
}

test.skipIf(!tmuxAvailable())(
  "graceful exit prints an exact resume command",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-exit-handoff-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const binDir = join(root, "bin");
    const stderrPath = join(root, "stderr.log");
    const resumedStderrPath = join(root, "resumed-stderr.log");
    const tapePath = join(root, "session.fibertape");
    const marker = "EXIT_HANDOFF_SAVED_HISTORY";
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(binDir);
    symlinkSync(FIBER_BIN, join(binDir, "fiber"));
    writeFileSync(stderrPath, "");
    writeFileSync(resumedStderrPath, "");
    const initialGateway = startCodexQueue([codexFinalText(marker)]);
    const resumedGateway = startCodexQueue([]);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    let active: TmuxSession | null = null;
    let passed = false;

    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          PATH: path,
          FIBER_RECORD: tapePath,
          FIBER_THEME: "dark",
        },
        stderrPath,
        width: 120,
        height: 32,
        remainOnExit: true,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save this conversation for the exit handoff.");
      await active.waitForText(marker, TIMEOUT);
      const sessionId = sessionIdFromHome(home);
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{12}$/);

      await active.sendText("/quit");
      await waitForCondition(
        () => active?.paneStatus().dead === true,
        "the graceful exit pane to stop",
      );
      expect(paneExitMatches(active.paneStatus(), 0)).toBe(true);
      const scrollback = stripAnsi(await active.captureFullScrollback());
      const ansiScrollback = await active.captureFullScrollbackEscapes();
      const expected = `Continue session with: fiber resume ${sessionId}`;
      expect(scrollback).toContain(expected);
      expect(scrollback).not.toContain("To continue this session, run:");
      expect(ansiScrollback).toContain(`\x1b[38;5;245m${expected}\x1b[39m`);
      expect(countOccurrences(scrollback, expected)).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(readFileSync(tapePath).includes(Buffer.from(expected))).toBe(
        false,
      );
      const handoffLine = scrollback
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line === expected);
      const printedCommand = handoffLine?.slice("Continue session with: ".length);
      expect(printedCommand).toBe(`fiber resume ${sessionId}`);

      await active.kill();
      active = await TmuxSession.create({
        cmd: printedCommand!,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          PATH: path,
        },
        stderrPath: resumedStderrPath,
        width: 120,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      const resumed = stripAnsi(await waitForScrollback(active, marker));
      expect(resumed).toContain(marker);
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      passed = true;
    } catch (error) {
      throw new Error(
        `${error}\nexit-handoff evidence:\n${exitHandoffEvidence(active, home, [stderrPath, resumedStderrPath], tapePath)}`,
      );
    } finally {
      if (active) await active.kill();
      initialGateway.stop();
      resumedGateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained exit handoff artifacts at ${root}`);
      }
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "rapid Ctrl-C during active-turn exit preserves the resume handoff",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-exit-sigint-race-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const tracePath = join(root, "trace.log");
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(stderrPath, "");
    const hold: HoldState = { started: false, cancelled: false };
    const initialGateway = startCodexQueue([() => heldCodexResponse(hold)]);
    let active: TmuxSession | null = null;
    let passed = false;

    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspace,
        env: {
          ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "input,worker,gateway,session",
        },
        stderrPath,
        width: 120,
        height: 32,
        remainOnExit: true,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save and cancel this active session.");
      await waitForCondition(() => hold.started, "held gateway response");
      const sessionId = sessionIdFromHome(home);

      active.sendKeysImmediate(["C-c"]);
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes(
            "cancel requested processing=true",
          ),
        "active-turn Ctrl-C cancellation",
      );
      active.sendKeysImmediate(["C-c"]);
      active.sendKeysImmediate(["C-c"]);

      await waitForCondition(
        () => active?.paneStatus().dead === true,
        "the rapid Ctrl-C exit pane to stop",
      );
      const scrollback = stripAnsi(await active.captureFullScrollback());
      const expected = `Continue session with: fiber resume ${sessionId}`;
      expect(countOccurrences(scrollback, expected)).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.kill();
      active = null;
      passed = true;
    } finally {
      if (active) await active.kill();
      initialGateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained rapid exit artifacts at ${root}`);
      }
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "closing the /resume picker starts a writable fresh session",
  async () => {
    // There is no CLI startup picker alias (the old `-r`, ResumeTarget.pick);
    // bare `session resume` resumes last directly and exits with "fiber: no saved sessions for this workspace" when none exist
    // (verified live). The picker surface that survives is the in-TUI /resume
    // command, so this case pins Esc-close-to-fresh-writable through it.
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "fiber-tui-resume-picker-cancel-")),
    );
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const marker = "fresh session after closing the resume picker";
    const gateway = startCodexQueue([codexFinalText(marker)]);
    let active: TmuxSession | null = null;
    let passed = false;

    try {
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/resume");
      const picker = stripAnsi(
        await active.waitForPane(
          (pane) =>
            pane.includes("Sessions 0") && pane.includes("No sessions found."),
          TIMEOUT,
        ),
      );
      expect(picker).toContain("Esc Close");

      await active.sendKeys("Escape");
      await waitForSessionPickerClosed(active);
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Start a fresh session after closing the picker.");
      await active.waitForText(marker, TIMEOUT);
      await waitForPersistedSessionMarker(home, marker);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.kill();
      active = null;
      passed = true;
    } finally {
      if (active) await active.kill();
      gateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained picker cancel artifacts at ${root}`);
      }
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "interactive resume aliases restore history and return to a live composer",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    let active: TmuxSession | null = null;
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];

    try {
      const initialMarker = "distinctive saved resume history";
      const initialGateway = startCodexQueue([
        codexFinalText(initialMarker),
      ]);
      gateways.push(initialGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save a turn for resume.");
      await active.waitForText(initialMarker, TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(stderrPath, "utf8")).not.toContain("AnsiBandOverflow");

      const sessionId = sessionIdFromHome(home);
      const resumeViewPath = join(
        home,
        ".fiber",
        "sessions",
        sessionId,
        "resume-view.bin",
      );
      expect(existsSync(resumeViewPath)).toBe(true);
      const initialResumeView = readFileSync(resumeViewPath);

      // The fork-point picker leg used the removed `-r` alias
      // (ResumeTarget.pick). Bare `session resume` resumes last directly, and picker-Enter resume is pinned by the question-card and
      // command-folding cases via the in-TUI /resume command. The alias
      // coverage below is the surviving surface for this case.
      writeFileSync(resumeViewPath, initialResumeView);

      const invocations = [
        ["session resume last"],
        [`session resume --id ${sessionId}`],
      ];
      for (const [index, args] of invocations.entries()) {
        const restoredMarker =
          index === 0 ? initialMarker : `resume follow-up ${index - 1}`;
        const followUp = `resume follow-up ${index}`;
        const tapePath = join(root, `startup-resume-${index}.fibertape`);
        const tracePath = join(root, `startup-resume-${index}.trace.log`);
        const gateway = startCodexQueue([codexFinalText(followUp)]);
        gateways.push(gateway);
        writeFileSync(stderrPath, "");
        active = await TmuxSession.create({
          cmd: `${FIBER_BIN} ${args.join(" ")}`,
          cwd: workspaceRoot,
          env: {
            ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
            FIBER_RECORD: tapePath,
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "session",
          },
          stderrPath,
          width: args[0] === `session resume --id ${sessionId}` ? 42 : 100,
          height: args[0] === `session resume --id ${sessionId}` ? 16 : 32,
        });
        await active.waitForComposer(TIMEOUT);
        const scrollback = await waitForScrollback(active, restoredMarker);
        expect(scrollback).toContain(restoredMarker);
        await active.sendText(`Continue session ${index}.`);
        await active.waitForText(followUp, TIMEOUT);
        expect(sessionIdFromHome(home)).toBe(sessionId);
        expect(active.isPaneAlive()).toBe(true);
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd()).toBe(true);
        await active.kill();
        active = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
        const resumeTrace = readFileSync(tracePath, "utf8");
        expect(resumeTrace).toMatch(
          /event=resume_view_cache (?:outcome=painted freshness=exact|outcome=skipped freshness=(?:exact|older))/,
        );
        const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
          cwd: workspaceRoot,
          env: { HOME: home },
        });
        expect(replay.code).toBe(0);
        expect(replay.stderr).toBe("");
        expect(replay.stdout).not.toMatch(/Run \/help for commands/i);
        const firstApplicationFrame = replay.stdout
          .split(/(?=--- frame \d+)/)
          .find((frame) =>
            /Recording:|Session:|Run \/help for commands|auto ·/.test(frame),
          );
        expect(firstApplicationFrame).toContain(restoredMarker);
        if (index === 0) {
          writeFileSync(resumeViewPath, initialResumeView);
        }
      }

      const markdownHome = join(root, "markdown-home");
      const markdownWorkspace = join(root, "markdown-workspace");
      const markdownStderrPath = join(root, "markdown-stderr.log");
      const markdownTapePath = join(root, "markdown-live.fibertape");
      const resumedMarkdownTapePath = join(root, "markdown-resumed.fibertape");
      mkdirSync(markdownHome);
      mkdirSync(markdownWorkspace);
      const markdown = [
        "## Resume Markdown Probe",
        "",
        "RESUME_MARKDOWN_TOP_MARKER with **BOLD_MARKER** and `INLINE_MARKER`.",
        "",
        "- [x] RESUME_MARKDOWN_TASK_MARKER",
        "",
        "| Row | Value |",
        "| --- | --- |",
        ...Array.from(
          { length: 14 },
          (_, index) => `| REPRO_TABLE_${String(index + 1).padStart(2, "0")} | ${index + 1} |`,
        ),
        "",
        "| Type | Symbol | Description |",
        "| --- | --- | --- |",
        ...SEMANTIC_TABLE_ROWS.map((row) =>
          `| ${row.type} | ${row.symbol} | ${row.description} |`
        ),
        "",
        "```zig",
        ...Array.from(
          { length: 18 },
          (_, index) =>
            `const ${index === 17 ? "CODE_FINAL_MARKER" : `CODE_LINE_${String(index + 1).padStart(2, "0")}`} = ${index + 1};`,
        ),
        "```",
        "",
        "```",
        "const inferredHook = await resumeHook(token, { cleanup: true } as CleanupSignal);",
        "```",
        "",
        "```",
        '{"json_ready": true}',
        "```",
        "",
        "```python",
        "def render_ready():",
        "    return True",
        "```",
      ].join("\n");
      const markdownGateway = startCodexQueue([codexFinalText(markdown)]);
      gateways.push(markdownGateway);
      writeFileSync(markdownStderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(markdownWorkspace),
        env: { ...seededFakeCodexEnv(markdownHome, markdownGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: markdownTapePath },
        stderrPath: markdownStderrPath,
        width: 72,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save Markdown for resume.");
      const liveMarkdown = await waitForScrollback(active, "render_ready");
      expectRenderedMarkdown(liveMarkdown, "tmux");
      expectInferredTypeScriptCodeBlock(liveMarkdown);
      expectExpandedCodeProfiles(liveMarkdown);
      expectAlignedSemanticTable(liveMarkdown, "tmux");
      expectInferredTypeScriptColors(await active.captureFullScrollbackEscapes());
      expectExpandedCodeColors(await active.captureFullScrollbackEscapes());
      await active.resizeWindow(42, 32);
      await active.sendKeys("C-o");
      await Bun.sleep(250);
      const narrowFullTranscript = await collectFullTranscriptPages(active);
      expectSemanticTableRows(narrowFullTranscript, "tmux");
      expectAlignedSemanticCards(narrowFullTranscript, "tmux");
      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(markdownStderrPath, "utf8")).not.toContain("AnsiBandOverflow");
      const liveReplay = await runFx(["debug", "replay", markdownTapePath, "--frames"], {
        cwd: realpathSync(markdownWorkspace),
        env: { HOME: markdownHome },
      });
      expect(liveReplay.code).toBe(0);
      expect(liveReplay.stderr).toBe("");
      expect(liveReplay.stdout).toContain("json_ready");
      expect(liveReplay.stdout).toContain("render_ready");
      expectSemanticTableRows(liveReplay.stdout, "replay");
      expectAlignedSemanticCards(liveReplay.stdout, "replay");

      const resumedMarkdownGateway = startCodexQueue([]);
      gateways.push(resumedMarkdownGateway);
      writeFileSync(markdownStderrPath, "");
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: realpathSync(markdownWorkspace),
        env: { ...seededFakeCodexEnv(markdownHome, resumedMarkdownGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: resumedMarkdownTapePath },
        stderrPath: markdownStderrPath,
        width: 42,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      const resumedMarkdown = await waitForScrollback(active, "render_ready");
      expect(resumedMarkdown).toContain("render_ready");
      expectInferredTypeScriptCodeBlock(resumedMarkdown);
      expectExpandedCodeProfiles(resumedMarkdown);
      expectInferredTypeScriptColors(await active.captureFullScrollbackEscapes());
      expectExpandedCodeColors(await active.captureFullScrollbackEscapes());
      await active.sendKeys("C-o");
      await Bun.sleep(250);
      const resumedFullTranscript = await collectFullTranscriptPages(active);
      expectRenderedMarkdown(resumedFullTranscript, "tmux");
      expectInferredTypeScriptCodeBlock(resumedFullTranscript);
      expectExpandedCodeProfiles(resumedFullTranscript);
      expectSemanticTableRows(resumedFullTranscript, "tmux");
      expectAlignedSemanticCards(resumedFullTranscript, "tmux");
      await active.sendKeys("Escape");
      await active.waitForComposer(TIMEOUT);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(markdownStderrPath, "utf8")).not.toContain("AnsiBandOverflow");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      const resumedReplay = await runFx(["debug", "replay", resumedMarkdownTapePath, "--frames"], {
        cwd: realpathSync(markdownWorkspace),
        env: { HOME: markdownHome },
      });
      expect(resumedReplay.code).toBe(0);
      expect(resumedReplay.stderr).toBe("");
      expect(resumedReplay.stdout).toContain("json_ready");
      expect(resumedReplay.stdout).toContain("render_ready");
      expectSemanticTableRows(resumedReplay.stdout, "replay");
      expectAlignedSemanticCards(resumedReplay.stdout, "replay");

      const toolHome = join(root, "tool-home");
      const toolWorkspace = join(root, "tool-workspace");
      const toolStderrPath = join(root, "tool-stderr.log");
      const toolWorkspaceMarker = "tool-workspace";
      mkdirSync(join(toolHome, ".fiber"), { recursive: true });
      mkdirSync(toolWorkspace);
      writeFileSync(
        join(toolHome, ".fiber", "settings.json"),
        JSON.stringify({}),
      );
      const toolWorkspaceRoot = realpathSync(toolWorkspace);
      const toolReply = "TOOL_RESUME_FINAL_REPLY";
      const toolGateway = startCodexQueue([
        fakeShellRun("resume_pwd", "pwd"),
        codexFinalText(toolReply),
      ]);
      gateways.push(toolGateway);
      writeFileSync(toolStderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: toolWorkspaceRoot,
        env: seededFakeCodexEnv(toolHome, toolGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: toolStderrPath,
        width: 80,
        height: 24,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run pwd once for resume.");
      const liveToolScrollback = await waitForScrollback(active, toolReply);
      expect(liveToolScrollback).toContain("Ran pwd");
      expect(liveToolScrollback).not.toContain(toolWorkspaceMarker);
      expectNoRawToolReplay(liveToolScrollback);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(toolStderrPath, "utf8")).not.toContain("AnsiBandOverflow");

      const toolSessionId = sessionIdFromHome(toolHome);
      const toolInvocations = [
        // There is no `--resume` flag; `resume last` is the top-level alias
        // for the same resume-last behavior.
        ["resume", "last"],
        ["continue"],
        [`session resume --id ${toolSessionId}`],
      ];
      for (const [index, args] of toolInvocations.entries()) {
        const followUp = `tool resume follow-up ${index}`;
        const gateway = startCodexQueue([codexFinalText(followUp)]);
        gateways.push(gateway);
        writeFileSync(toolStderrPath, "");
        active = await TmuxSession.create({
          cmd: `${FIBER_BIN} ${args.join(" ")}`,
          cwd: toolWorkspaceRoot,
          env: seededFakeCodexEnv(toolHome, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          stderrPath: toolStderrPath,
          width: 80,
          height: 24,
        });
        await active.waitForComposer(TIMEOUT);
        const resumedToolScrollback = await waitForScrollback(active, toolReply);
        expect(resumedToolScrollback).toContain("Ran pwd");
        expect(resumedToolScrollback).not.toContain(toolWorkspaceMarker);
        expect(resumedToolScrollback).toContain(toolReply);
        expectNoRawToolReplay(resumedToolScrollback);
        if (index === 0) {
          await active.sendKeys("C-o");
          await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
          await active.waitForText(toolWorkspaceMarker, TIMEOUT);
          const full = await active.capturePane();
          expect(full).toContain("Ran pwd");
          expect(full).toContain(toolWorkspaceMarker);
          await active.sendKeys("C-o");
          await active.waitForComposer(TIMEOUT);
        }
        await active.sendText(`Continue the tool session ${index}.`);
        await active.waitForText(followUp, TIMEOUT);
        expect(active.isPaneAlive()).toBe(true);
        expect(readFileSync(toolStderrPath, "utf8")).not.toContain("AnsiBandOverflow");
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd()).toBe(true);
        await active.kill();
        active = null;
      }
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 5,
);

test.skipIf(!tmuxAvailable())(
  "upgrade ctrl-g reports auto-upgrade is disabled and stays writable",
  async () => {
    // There is no auto-upgrade producer: the background loop and the
    // App.startAutoUpgrade call site were removed, so nothing ever
    // sets AutoUpgrade.state = .ready. Automatic upgrade also now defaults off,
    // so ctrl+g stops at the earlier branch and answers "auto-upgrade is
    // disabled" rather than "no installed upgrade is ready". The ctrl+g
    // machinery is retained either way, and this case pins what matters: the
    // notice is neutral and the session stays writable.
    // Live-probed against zig-out/bin/fiber.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-upgrade-ctrl-g-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);

    let active: TmuxSession | null = null;
    const gateway = startCodexQueue([
      codexFinalText("UPGRADE_CTRL_G_INITIAL_DONE"),
      codexFinalText("UPGRADE_CTRL_G_FOLLOWUP_DONE"),
    ]);

    try {
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 110,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save a turn before upgrade handoff.");
      await active.waitForText("UPGRADE_CTRL_G_INITIAL_DONE", TIMEOUT);
      await active.waitForComposer(TIMEOUT);

      await active.sendHexBytes(["07"]);
      await active.waitForText(
        "● Upgrade: auto-upgrade is disabled",
        TIMEOUT,
      );
      const pane = stripAnsi(await active.capturePane());
      expect(pane).not.toContain("update ready: ctrl+g to reload");

      await active.sendText("Continue after upgrade handoff.");
      await active.waitForText("UPGRADE_CTRL_G_FOLLOWUP_DONE", TIMEOUT);
      const stderr = readFileSync(stderrPath, "utf8");
      expect(stderr).not.toContain("relaunch failed");
      expect(stderr).not.toContain("AnsiBandOverflow");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
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
  TIMEOUT * 2,
);

// Gated skip with evidence: the exact corrupt-boundary repair this case
// pinned happens only during the upgrade relaunch resume
// (applyReadyUpgrade -> prepareResumeHandoff -> `resume --upgrade-relaunch`).
// The only producer that ever set AutoUpgrade.state = .ready — the CDN
// background loop in auto_upgrade.zig (runLoop/runOnce/start) and the
// App.startAutoUpgrade decl — was removed, so the relaunch-resume path is
// retained but unreached until update support lands (#46). No E2E equivalent
// exists: without a relaunch there is no boundary to repair (live probe: a
// corrupted commit watermark makes the ordinary follow-up turn fail
// InvalidSessionFormat). The retained machinery is unit-covered in
// app_session_runtime.zig (corruptActiveWatermark + prepareResumeHandoff
// tests). Restore when update support lands an upgrade producer.
const upgradeRelaunchProducerRemoved = true;

test.skipIf(!tmuxAvailable() || upgradeRelaunchProducerRemoved)(
  "upgrade ctrl-g repairs an exact corrupt boundary and resumes",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-upgrade-corrupt-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const installDir = join(root, "install");
    const stderrPath = join(root, "stderr.log");
    const argvLogPath = join(root, "upgrade-argv.log");
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(installDir);
    const workspaceRoot = realpathSync(workspace);
    const installedFx = join(installDir, "fx");
    copyFileSync(FIBER_BIN, installedFx);
    chmodSync(installedFx, 0o755);

    let active: TmuxSession | null = null;
    const gateway = startCodexQueue([
      codexFinalText("UPGRADE_CORRUPT_INITIAL_DONE"),
      codexFinalText("UPGRADE_CORRUPT_FOLLOWUP_DONE"),
    ]);
    const release = startUpgradeServer(root, argvLogPath);

    try {
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: shellQuote(installedFx),
        cwd: workspaceRoot,
        env: {
          ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_E2E_UPGRADE_BASE_URL: release.baseUrl,
        },
        stderrPath,
        width: 110,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save this turn before the corrupt upgrade boundary.");
      await active.waitForText("UPGRADE_CORRUPT_INITIAL_DONE", TIMEOUT);
      await active.waitForComposer(TIMEOUT);
      await waitForCommittedSessionMarker(home, "UPGRADE_CORRUPT_INITIAL_DONE");
      const sessionId = sessionIdFromHome(home);
      await active.waitForText(
        "update ready: ctrl+g to reload",
        UPGRADE_TIMEOUT,
      );

      const sessionDir = join(home, ".fiber", "sessions", sessionId);
      const watermarkName = readdirSync(sessionDir).find(
        (name) => name.startsWith("commit.") && name.endsWith(".json"),
      )!;
      writeFileSync(join(sessionDir, watermarkName), "{}\n", { mode: 0o600 });
      const version = (await runFx(["--version"])).stdout.trim();
      await active.sendHexBytes(["07"]);

      await active.waitForText(`● fiber has been updated to v${version}`, TIMEOUT);
      const resumed = await waitForScrollback(
        active,
        "UPGRADE_CORRUPT_INITIAL_DONE",
      );
      expect(resumed).toContain("UPGRADE_CORRUPT_INITIAL_DONE");
      expect(active.isPaneAlive()).toBe(true);
      const argvLines = readFileSync(argvLogPath, "utf8").trim().split("\n");
      expect(argvLines).toEqual([
        `${installedFx}\tresume\t${sessionId}\t--upgrade-relaunch`,
      ]);

      await active.sendText("Continue after repaired upgrade handoff.");
      await active.waitForText("UPGRADE_CORRUPT_FOLLOWUP_DONE", TIMEOUT);

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      release.stop();
      gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  UPGRADE_TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "answered question cards survive flag and picker resume",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-resume-question-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const questionMarker = "RESUME_QUESTION_VERIFICATION_DEPTH";
    const answer = "Thorough";
    const completion = "RESUME_QUESTION_COMPLETED";
    const flagFollowUp = "RESUME_QUESTION_FLAG_FOLLOW_UP";
    const pickerFollowUp = "RESUME_QUESTION_PICKER_FOLLOW_UP";
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    const expectCompactQuestion = (scrollback: string) => {
      expect(scrollback).toContain(`\n  1) ${questionMarker}`);
      expect(scrollback).toContain(`     ${answer}`);
      expect(scrollback).not.toContain("● Asked");
      expect(scrollback).not.toContain(`\"question\":\"${questionMarker}\"`);
    };

    const expectQuestionDetail = async (session: TmuxSession) => {
      await session.sendKeys("C-o");
      await session.waitForText(`\"answer\":\"${answer}\"`, TIMEOUT);
      const full = await session.capturePane();
      expect(full).toContain(questionMarker);
      expect(full).toContain(`\"question\":\"${questionMarker}\"`);
      expect(full).toContain(`\"answer\":\"${answer}\"`);
      expect(full).not.toMatch(/^\s*(?:input|result)\s*$/m);
      await session.sendKeys("Escape");
      await session.waitForComposer(TIMEOUT);
    };

    try {
      const initialGateway = startCodexQueue([
        codexToolCall("resume_question", "ask_user_question", {
          questions: [
            {
              question: questionMarker,
              options: [
                { label: answer, description: "Run every verification step." },
                { label: "Fast", description: "Run only the focused checks." },
              ],
            },
          ],
        }),
        codexFinalText(completion),
      ]);
      gateways.push(initialGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Ask the prepared verification question.");
      await active.waitForText(questionMarker, TIMEOUT);
      await active.sendLiteralText("1");
      await active.sendKeys("Enter");
      const live = await waitForScrollback(active, completion);
      expectCompactQuestion(live);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const flagGateway = startCodexQueue([codexFinalText(flagFollowUp)]);
      gateways.push(flagGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, flagGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      const flagResumed = await waitForScrollback(active, completion);
      expectCompactQuestion(flagResumed);
      await expectQuestionDetail(active);
      await active.sendText("Continue the resumed flag session.");
      await active.waitForText(flagFollowUp, TIMEOUT);
      expect(active.isPaneAlive()).toBe(true);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const pickerGateway = startCodexQueue([codexFinalText(pickerFollowUp)]);
      gateways.push(pickerGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, pickerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendHexBytes(["1b", "5b", "31", "31", "34", "3b", "39", "75"]);
      await waitForSessionPicker(active);
      await active.sendKeys("Enter");
      const pickerResumed = await waitForScrollback(active, flagFollowUp);
      expectCompactQuestion(pickerResumed);
      await expectQuestionDetail(active);
      await active.sendText("Continue the resumed picker session.");
      await active.waitForText(pickerFollowUp, TIMEOUT);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 4,
);

test.skipIf(!tmuxAvailable())(
  "recorded file diffs survive resume and retain their Ctrl-O detail",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-resume-file-diff-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const initialTapePath = join(root, "initial.fibertape");
    const resumedTapePath = join(root, "resumed.fibertape");
    const firstLines = Array.from(
      { length: 120 },
      (_, index) => `RESUMED_FIRST_FILE_LINE_${String(index + 1).padStart(3, "0")}`,
    );
    const secondLines = Array.from(
      { length: 60 },
      (_, index) => `RESUMED_SECOND_FILE_LINE_${String(index + 1).padStart(3, "0")}`,
    );
    const firstCompletion = "RESUMED_FIRST_FILE_COMPLETE";
    const secondCompletion = "RESUMED_SECOND_FILE_COMPLETE";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "ask", permission: {} }),
    );
    writeFileSync(stderrPath, "");

    const initialGateway = startCodexQueue([
      codexToolCall("resume_file_diff", "write_file", {
        path: "first-large.md",
        content: `${firstLines.join("\n")}\n`,
      }),
      codexFinalText(firstCompletion),
      codexToolCall("resume_second_file_diff", "write_file", {
        path: "second-large.md",
        content: `${secondLines.join("\n")}\n`,
      }),
      codexFinalText(secondCompletion),
    ]);
    const resumedGateway = startCodexQueue([]);
    let active: TmuxSession | null = null;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: initialTapePath },
        stderrPath,
        width: 120,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Create the first prepared resume file fixture.");
      await active.waitForText("Apply this change?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      const firstLive = await waitForScrollback(active, firstCompletion);
      expect(firstLive).toContain("Wrote first-large.md +120");
      expect(firstLive).not.toContain("RESUMED_FIRST_FILE_LINE_001");
      expect(readFileSync(join(workspace, "first-large.md"), "utf8")).toBe(
        `${firstLines.join("\n")}\n`,
      );

      await active.sendText("Create the second prepared resume file fixture.");
      await active.waitForText("Apply this change?", TIMEOUT);
      await active.sendKeys("1");
      await active.sendKeys("Enter");
      const live = await waitForScrollback(active, secondCompletion);
      expect(live).toContain("Wrote first-large.md +120");
      expect(live).toContain("Wrote second-large.md +60");
      expect(live).not.toContain("RESUMED_SECOND_FILE_LINE_001");
      expect(readFileSync(join(workspace, "second-large.md"), "utf8")).toBe(
        `${secondLines.join("\n")}\n`,
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const sessionId = sessionIdFromHome(home);
      const eventsJsonl = readFileSync(
        join(home, ".fiber", "sessions", sessionId, "events.jsonl"),
        "utf8",
      );
      expect(eventsJsonl).toContain("committed_file_presentation");
      expect(eventsJsonl).not.toContain("sk-abcdefghijklmnop");
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} session resume --id ${sessionId}`,
        cwd: realpathSync(workspace),
        env: { ...seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_RECORD: resumedTapePath },
        stderrPath,
        width: 120,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      const resumed = await waitForScrollback(active, secondCompletion);
      expect(resumed).toContain("Wrote first-large.md +120");
      expect(resumed).toContain("Wrote second-large.md +60");
      expect(resumed).not.toContain("RESUMED_SECOND_FILE_LINE_001");

      await active.sendKeys("C-o");
      await active.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      await active.sendHexBytes(
        Array.from({ length: 10 }, () => ["1b", "5b", "36", "7e"]).flat(),
      );
      await active.waitForText("RESUMED_SECOND_FILE_LINE_060", TIMEOUT);
      const secondFull = await active.capturePane();
      expect(secondFull).toContain("RESUMED_SECOND_FILE_LINE_060");
      expect(secondFull).not.toContain('"content":"RESUMED_SECOND_FILE_LINE');
      await active.sendHexBytes(
        Array.from({ length: 2 }, () => ["1b", "5b", "35", "7e"]).flat(),
      );
      await active.waitForText("RESUMED_FIRST_FILE_LINE_120", TIMEOUT);
      const firstFull = await active.capturePane();
      expect(firstFull).toContain("RESUMED_FIRST_FILE_LINE_120");
      expect(firstFull).not.toContain('"content":"RESUMED_FIRST_FILE_LINE');

      await active.sendKeys("C-o");
      await active.waitForComposer(TIMEOUT);

      await active.sendText("/undo");
      await active.waitForText("Nothing to undo.", TIMEOUT);
      expect(readFileSync(join(workspace, "first-large.md"), "utf8")).toBe(
        `${firstLines.join("\n")}\n`,
      );
      expect(readFileSync(join(workspace, "second-large.md"), "utf8")).toBe(
        `${secondLines.join("\n")}\n`,
      );
      const replay = await runFx(["debug", "replay", resumedTapePath, "--frames"], {
        cwd: realpathSync(workspace),
        env: { HOME: home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      expect(replay.stdout).toContain("RESUMED_FIRST_FILE_LINE_120");
      expect(replay.stdout).toContain("RESUMED_SECOND_FILE_LINE_060");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      if (active) {
        try {
          await active.sendText("/quit");
        } catch {}
        await active.kill();
      }
      initialGateway.stop();
      resumedGateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.skipIf(!tmuxAvailable())(
  "command output folding survives flag and picker resume",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-resume-command-output-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    mkdirSync(join(home, ".fiber"), { recursive: true });
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "ask", permission: {} }),
    );
    const lineCount = 40;
    const commandLine = "x".repeat(40);
    const stderrTail1 = "RESUME_COMMAND_STDERR_TAIL_1";
    const stdoutTail1 = "RESUME_COMMAND_STDOUT_TAIL_1";
    const stderrTail2 = "RESUME_COMMAND_STDERR_TAIL_2";
    const stdoutTail2 = "RESUME_COMMAND_STDOUT_TAIL_2";
    const scriptPath = join(workspace, "resume-command-output.sh");
    const fixtureCommand = "./resume-command-output.sh";
    writeFileSync(
      scriptPath,
      `#!/bin/sh
i=0
while [ "$i" -lt ${lineCount} ]; do
  printf 'RESUME_COMMAND_LINE_%03d: ${commandLine}\\n' "$i"
  i=$((i + 1))
done
printf '\\n'
printf 'RESUME_COMMAND_TAIL\\n'
printf '${stderrTail1}\\n' >&2
sleep 0.5
printf '${stdoutTail1}\\n'
sleep 0.5
printf '${stderrTail2}\\n' >&2
sleep 0.5
printf '${stdoutTail2}\\n'
`,
    );
    chmodSync(scriptPath, 0o755);
    const orderedTailMarkers = [stderrTail1, stdoutTail1, stderrTail2, stdoutTail2];
    for (const marker of orderedTailMarkers) expect(fixtureCommand).not.toContain(marker);
    const firstMarker = "RESUME_COMMAND_LINE_000";
    const completion = "RESUME_COMMAND_OUTPUT_COMPLETE";
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    function expectCompactCommandOutput(pane: string): void {
      expect(pane).toContain("● 1 tool call · 1 command");
      expect(pane).toContain("Ran ./resume-command-output.sh");
      expect(pane).not.toContain("lines more (ctrl o to view)");
      expect(pane).not.toContain(firstMarker);
      expect(pane).not.toContain("RESUME_COMMAND_TAIL");
    }

    async function expectRestoredViewerOutput(session: TmuxSession): Promise<void> {
      await session.sendKeys("C-o");
      await session.waitForText("┃ Full detail · ctrl o close", TIMEOUT);
      const tail = await session.capturePane();
      expect(tail).toContain(stdoutTail2);
      expect(tail).not.toContain(firstMarker);

      const pages = [tail];
      for (let page = 0; page < 8 && !pages.at(-1)!.includes(firstMarker); page += 1) {
        await session.sendHexBytes(["1b", "5b", "35", "7e"]);
        const next = await waitForChangedPane(session, pages.at(-1)!);
        if (next === null) break;
        pages.push(next);
      }
      const head = pages.at(-1)!;
      expect(head).toContain(`│ ${firstMarker}`);
      expect(countOccurrences(head, firstMarker)).toBe(1);
      const output = [...pages].reverse().join("\n").split("\n").filter((line) =>
        line.trimStart().startsWith("│ ") && !line.includes("command:")
      ).join("\n");
      for (const marker of orderedTailMarkers) {
        expect(output).toContain(marker);
      }
      expect(output.indexOf(stderrTail1)).toBeLessThan(
        output.indexOf(stdoutTail1),
      );
      expect(output.indexOf(stdoutTail1)).toBeLessThan(
        output.indexOf(stderrTail2),
      );
      expect(output.indexOf(stderrTail2)).toBeLessThan(
        output.indexOf(stdoutTail2),
      );
      expect(tail).not.toContain(firstMarker);
      expect(tail).not.toContain("<stdout>");
      expect(tail).not.toContain("</stdout>");
      expect(tail).not.toContain("<stderr>");
      expect(tail).not.toContain("</stderr>");
      await session.sendKeys("C-o");
      await session.waitForComposer(TIMEOUT);
    }

    try {
      const initialGateway = startCodexQueue([
        fakeShellRun("resume_long_command", fixtureCommand),
        codexFinalText(completion),
      ]);
      gateways.push(initialGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: { ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }), FIBER_PERMISSION_MODE: "ask" },
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the long command for resume.");
      await active.waitForText("Would you like to run the following command?", TIMEOUT);
      await active.sendKeys("Enter");
      await active.waitForText(completion, TIMEOUT);
      await active.waitForPane((pane) => pane.includes("Ran ./resume-command-output.sh"), TIMEOUT);
      const live = await active.capturePane();
      expectCompactCommandOutput(live);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const flagGateway = startCodexQueue([]);
      gateways.push(flagGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, flagGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.waitForPane((pane) => pane.includes("Ran ./resume-command-output.sh"), TIMEOUT);
      const flagResumed = await active.capturePane();
      expectCompactCommandOutput(flagResumed);
      expectNoRawToolReplay(flagResumed);
      await expectRestoredViewerOutput(active);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const pickerGateway = startCodexQueue([]);
      gateways.push(pickerGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, pickerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/resume");
      await waitForSessionPicker(active);
      await active.sendKeys("Enter");
      await active.waitForPane((pane) => pane.includes("Ran ./resume-command-output.sh"), TIMEOUT);
      const pickerResumed = await active.capturePane();
      expectCompactCommandOutput(pickerResumed);
      expectNoRawToolReplay(pickerResumed);
      await expectRestoredViewerOutput(active);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 4,
);

test.skipIf(!tmuxAvailable())(
  "interactive /resume opens a searchable scoped catalog and resumes the selection",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-picker-workspace-")));
    const home = join(root, "home");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const workspaceARoot = realpathSync(workspaceA);
    const workspaceBRoot = realpathSync(workspaceB);
    const workspaceAMarker = "SESSION_PICKER_WORKSPACE_A_ONLY";
    const workspaceBMarker = "SESSION_PICKER_WORKSPACE_B_FOREIGN";
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      const workspaceAGateway = startCodexQueue([codexFinalText(workspaceAMarker)]);
      gateways.push(workspaceAGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceARoot,
        env: seededFakeCodexEnv(home, workspaceAGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 30,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save the workspace A transcript.");
      await active.waitForText(workspaceAMarker, TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const workspaceBGateway = startCodexQueue([codexFinalText(workspaceBMarker)]);
      gateways.push(workspaceBGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceBRoot,
        env: seededFakeCodexEnv(home, workspaceBGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 30,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save the workspace B transcript.");
      await active.waitForText(workspaceBMarker, TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const pickerGateway = startCodexQueue([]);
      gateways.push(pickerGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceARoot,
        env: seededFakeCodexEnv(home, pickerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 160,
        height: 30,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/resume");
      await waitForSessionPicker(active);
      const currentPicker = stripAnsi(await active.capturePane());
      expect(currentPicker).toContain("Sessions 1");
      expect(currentPicker).toContain("[Current workspace]");
      expect(currentPicker).toContain("fiber");
      expect(currentPicker).toContain("Save the workspace A transcript.");
      expect(currentPicker).not.toContain("Save the workspace B transcript.");

      await active.sendKeys("Tab");
      await active.waitForPane((pane) => {
        const plain = stripAnsi(pane);
        return plain.includes("Sessions 2") &&
          plain.includes("[All workspaces]") &&
          plain.includes("Save the workspace B transcript.");
      }, TIMEOUT);
      const allPicker = stripAnsi(await active.capturePane());
      expect(allPicker).toContain("Save the workspace A transcript.");
      expect(allPicker).toContain("Save the workspace B transcript.");
      expect(allPicker).toContain("Tab Scope");

      await active.sendLiteralText("workspace B");
      await active.waitForPane((pane) => {
        const plain = stripAnsi(pane);
        return plain.includes("Sessions 1") &&
          plain.includes("Save the workspace B transcript.") &&
          !plain.includes("Save the workspace A transcript.");
      }, TIMEOUT);
      const filteredPicker = stripAnsi(await active.capturePane());
      expect(filteredPicker).toContain("workspace B");
      expect(filteredPicker).toContain("workspace-b");
      expect(filteredPicker).not.toContain("Preview:");
      const sessionIds = readdirSync(join(home, ".fiber", "sessions"), {
        withFileTypes: true,
      })
        .filter((entry) => entry.name !== "latest" && entry.isDirectory())
        .map((entry) => entry.name);
      for (const sessionId of sessionIds) {
        expect(filteredPicker).not.toContain(sessionId);
      }
      await active.sendKeys("Enter");
      const resumed = await waitForScrollback(active, workspaceBMarker);
      expect(resumed).toContain("● Session resumed: Save the workspace B transcript.");
      expect(resumed).toContain(workspaceBMarker);
      expect(resumed).not.toContain(workspaceAMarker);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "interactive /resume keeps shared-prefix titles distinguishable at narrow widths",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-picker-narrow-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const titles = ["alpha", "beta", "gamma"].map(
      (suffix) =>
        `Shared production composer regression investigation session ${suffix}`,
    );
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      const sessionGateway = startCodexQueue(
        titles.map((_, index) => codexFinalText(`SESSION_TITLE_${index}`)),
      );
      gateways.push(sessionGateway);
      for (let index = 0; index < titles.length; index += 1) {
        writeFileSync(stderrPath, "");
        active = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: workspaceRoot,
          env: seededFakeCodexEnv(home, sessionGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          stderrPath,
          width: 80,
          height: 24,
        });
        await active.waitForComposer(TIMEOUT);
        await active.sendText(titles[index]!);
        await active.waitForText(`SESSION_TITLE_${index}`, TIMEOUT);
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd()).toBe(true);
        await active.kill();
        active = null;
        expect(readFileSync(stderrPath, "utf8")).toBe("");
      }

      const pickerGateway = startCodexQueue([]);
      gateways.push(pickerGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, pickerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 40,
        height: 24,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("/resume");
      const pane = stripAnsi(await waitForSessionPicker(active));
      expect(pane).toContain("Sessions 3");
      for (const suffix of ["alpha", "beta", "gamma"]) {
        expect(pane).toContain(suffix);
      }
      const rows = pane
        .split("\n")
        .filter((line) => /(?:alpha|beta|gamma)\b/.test(line))
        .map((line) => line.trim());
      expect(new Set(rows).size).toBe(titles.length);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      if (active) await active.kill();
      for (const current of gateways) current.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 4,
);

test.skipIf(!tmuxAvailable())(
  "interactive /resume highlight reaches bottom before the list scrolls",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-picker-row-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    // 12 saved sessions exercise a first page that is taller than the viewport.
    const savedMarkers = Array.from(
      { length: 12 },
      (_, index) => `SESSION_PICKER_ROW_${index}`,
    );
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      for (const marker of savedMarkers) {
        const responseMarker = `${marker}_SAVED`;
        const gateway = startCodexQueue([codexFinalText(responseMarker)]);
        gateways.push(gateway);
        writeFileSync(stderrPath, "");
        active = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: workspaceRoot,
          env: {
            ...seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
            FIBER_THEME: "dark",
            NO_COLOR: undefined,
          },
          stderrPath,
          width: 100,
          height: 30,
        });
        await active.waitForComposer(TIMEOUT);
        await active.sendText(`Save ${marker}.`);
        await active.waitForText(responseMarker, TIMEOUT);
        await waitForPersistedSessionMarker(home, responseMarker);
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd()).toBe(true);
        await active.kill();
        active = null;
      }

      const pickerGateway = startCodexQueue([]);
      gateways.push(pickerGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: {
          ...seededFakeCodexEnv(home, pickerGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_THEME: "dark",
          NO_COLOR: undefined,
        },
        stderrPath,
        width: 100,
        height: 15,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendHexBytes(["1b", "5b", "31", "31", "34", "3b", "39", "75"]);
      await waitForSessionPicker(active);

      let sessionEntries = visibleSessionPickerEntries(await active.capturePaneEscapes());
      expect(sessionEntries).toHaveLength(2);
      expect(sessionEntries.findIndex((entry) => entry.selected)).toBe(0);
      const firstVisibleRow = sessionEntries[0]!.row;
      const firstVisibleTitle = sessionEntries[0]!.title;
      const visibleCount = sessionEntries.length;

      for (let index = 0; index < visibleCount - 1; index += 1) {
        await active.sendKeys("Down");
        sessionEntries = visibleSessionPickerEntries(await active.capturePaneEscapes());
        expect(sessionEntries).toHaveLength(visibleCount);
        expect(sessionEntries[0]!.row).toBe(firstVisibleRow);
        expect(sessionEntries.findIndex((entry) => entry.selected)).toBe(index + 1);
        expect(sessionEntries.find((entry) => entry.selected)!.row).toBe(firstVisibleRow + index + 1);
      }

      await active.sendKeys("Down");
      const scrolledEntries = visibleSessionPickerEntries(await active.capturePaneEscapes());
      expect(scrolledEntries).toHaveLength(visibleCount);
      expect(scrolledEntries[0]!.row).toBe(firstVisibleRow);
      expect(scrolledEntries[0]!.title).not.toBe(firstVisibleTitle);
      expect(scrolledEntries.findIndex((entry) => entry.selected)).toBe(visibleCount - 1);
      expect(scrolledEntries.find((entry) => entry.selected)!.row).toBe(firstVisibleRow + visibleCount - 1);

      await active.sendKeys("Up");

      const reversedEntries = visibleSessionPickerEntries(await active.capturePaneEscapes());
      expect(reversedEntries).toHaveLength(visibleCount);
      expect(reversedEntries[0]!.row).toBe(firstVisibleRow);
      expect(reversedEntries.findIndex((entry) => entry.selected)).toBe(visibleCount - 2);
      expect(reversedEntries.find((entry) => entry.selected)!.row).toBe(firstVisibleRow + visibleCount - 2);

      const atReversedSelection = (await active.capturePane()).split("\n");
      const headerRow = atReversedSelection.findIndex((line) => line.includes("Sessions 10"));
      const loadMoreRow = atReversedSelection.findIndex((line) => line.includes("↓ Load more"));
      const hintRow = atReversedSelection.findIndex((line) => line.includes("Tab Scope"));
      expect(headerRow).toBeGreaterThanOrEqual(0);
      expect(loadMoreRow).toBeGreaterThan(headerRow);
      expect(hintRow).toBeGreaterThan(loadMoreRow);
      const firstEntryRow = visibleSessionPickerEntries(await active.capturePaneEscapes())[0]!.row;

      for (let index = 0; index < 10 - visibleCount; index += 1) {
        await active.sendKeys("Down");
      }
      await active.waitForPane((pane) => {
        const plain = stripAnsi(pane);
        return /Sessions 1[12]\b/.test(plain) && !plain.includes("Load more");
      }, TIMEOUT);
      const afterFurtherScroll = (await active.capturePane()).split("\n");
      expect(afterFurtherScroll.findIndex((line) => /Sessions 1[12]\b/.test(line))).toBe(headerRow);
      expect(afterFurtherScroll.findIndex((line) => line.includes("↓ Load more"))).toBe(-1);
      expect(afterFurtherScroll.findIndex((line) => line.includes("Tab Scope"))).toBe(hintRow);
      expect(visibleSessionPickerEntries(await active.capturePaneEscapes())[0]!.row).toBe(firstEntryRow);

      expect(active.isAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendKeys("Escape");
      await waitForSessionPickerClosed(active);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);

test.skipIf(!tmuxAvailable())(
  "interactive /resume loads more sessions and dismisses cleanly",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-picker-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const savedMarkers = Array.from(
      { length: 11 },
      (_, index) => `SESSION_PICKER_HISTORY_${index}`,
    );
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      for (const marker of savedMarkers) {
        const responseMarker = `${marker}_SAVED`;
        const gateway = startCodexQueue([codexFinalText(responseMarker)]);
        gateways.push(gateway);
        writeFileSync(stderrPath, "");
        active = await TmuxSession.create({
          cmd: FIBER_BIN,
          cwd: workspaceRoot,
          env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          stderrPath,
          width: 100,
          height: 30,
        });
        await active.waitForComposer(TIMEOUT);
        await active.sendText(`Save ${marker}.`);
        await active.waitForText(responseMarker, TIMEOUT);
        await waitForPersistedSessionMarker(home, responseMarker);
        await active.sendText("/quit");
        expect(await active.waitForSessionEnd()).toBe(true);
        await active.kill();
        active = null;
      }

      const gateway = startCodexQueue([]);
      gateways.push(gateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, gateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
        width: 100,
        height: 15,
      });
      await active.waitForComposer(TIMEOUT);

      await active.sendText("/resume");
      await waitForSessionPicker(active);
      await active.waitForPane((pane) => {
        const plain = stripAnsi(pane);
        return plain.includes("Sessions 10") && plain.includes("Load more");
      }, TIMEOUT);
      for (let index = 0; index < 10; index += 1) {
        await active.sendKeys("Down");
      }
      await active.waitForPane((pane) => {
        const plain = stripAnsi(pane);
        return plain.includes("Sessions 11") &&
          plain.includes(`Save ${savedMarkers[0]}.`) &&
          !plain.includes("Load more");
      }, TIMEOUT);
      await active.sendLiteralText(savedMarkers[0]!);
      await active.waitForPane(
        (pane) => {
          const plain = stripAnsi(pane);
          return plain.includes("Sessions 1") &&
            plain.includes(`Save ${savedMarkers[0]!}.`);
        },
        TIMEOUT,
      );
      await active.sendKeys("Enter");
      const resumed = await waitForSessionPickerClosed(active);
      expect(resumed).toContain(`● Session resumed: Save ${savedMarkers[0]!}.`);
      expect(resumed).toContain(savedMarkers[0]!);

      await active.sendText("/resume");
      await waitForSessionPicker(active);
      await active.sendKeys("Escape");
      const afterEscape = await waitForSessionPickerClosed(active);
      expect(await active.captureFullScrollback()).toContain(
        `● Session resumed: Save ${savedMarkers[0]!}.`,
      );
      expect(afterEscape).toContain(savedMarkers[0]!);
      expect(afterEscape).not.toContain(`● Session resumed: Save ${savedMarkers[10]!}.`);
      expect(afterEscape).not.toContain(savedMarkers[10]!);

      await active.sendText("/resume");
      await waitForSessionPicker(active);
      await active.sendLiteralText(savedMarkers[10]!);
      await active.waitForPane(
        (pane) => {
          const plain = stripAnsi(pane);
          return plain.includes("Sessions 1") &&
            plain.includes(`Save ${savedMarkers[10]!}.`);
        },
        TIMEOUT,
      );
      await active.sendKeys("Enter");
      const secondResume = await waitForSessionPickerClosed(active);
      expect(secondResume).toContain(`● Session resumed: Save ${savedMarkers[10]!}.`);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 3,
);

test.skipIf(!tmuxAvailable())(
  "new and resumed sessions preserve native terminal scrollback while fx is active",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-direct-resume-scroll-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    const initialTapePath = join(root, "new-session-scroll.fibertape");
    const tapePath = join(root, "direct-resume-scroll.fibertape");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const earlyMarker = "SESSION_PICKER_SCROLLBACK_EARLY";
    const lateMarker = "SESSION_PICKER_SCROLLBACK_LATE";
    const lines = Array.from(
      { length: 80 },
      (_, index) => `SESSION_PICKER_SCROLLBACK_LINE_${String(index).padStart(3, "0")} has enough text to wrap in the terminal viewport.`,
    );
    lines.unshift(earlyMarker);
    lines.push(lateMarker);
    const transcript = lines.join("\n");
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      const initialGateway = startCodexQueue([codexFinalText(transcript)]);
      gateways.push(initialGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: {
          ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: initialTapePath,
        },
        stderrPath,
        width: 80,
        height: 24,
      });
      await active.waitForComposer(TIMEOUT);
      const initialTape = readFileSync(initialTapePath);
      expect(initialTape.includes(Buffer.from("\x1b[?1002h"))).toBe(false);
      expect(initialTape.includes(Buffer.from("\x1b[?1006h"))).toBe(false);
      expect(initialTape.includes(Buffer.from("\x1b[?1049h"))).toBe(false);
      await active.sendText("Save a long transcript for resume.");
      await waitForScrollback(active, lateMarker);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const sessionId = sessionIdFromHome(home);
      const resumedGateway = startCodexQueue([]);
      gateways.push(resumedGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume ${sessionId}`,
        cwd: workspaceRoot,
        env: {
          ...seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_RECORD: tapePath,
        },
        stderrPath,
        width: 80,
        height: 24,
      });
      await active.waitForComposer(TIMEOUT);

      const resumed = await waitForScrollback(active, earlyMarker);
      expect(resumed).toContain(earlyMarker);
      const tape = readFileSync(tapePath);
      expect(tape.includes(Buffer.from("\x1b[?1002h"))).toBe(false);
      expect(tape.includes(Buffer.from("\x1b[?1006h"))).toBe(false);
      expect(tape.includes(Buffer.from("\x1b[?1049h"))).toBe(false);
      expect(active.isPaneAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 3,
);

test.skipIf(!tmuxAvailable())(
  "interactive /resume refuses a live stream and preserves Escape cancellation",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-session-picker-stream-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const stderrPath = join(root, "stderr.log");
    mkdirSync(home);
    mkdirSync(workspace);
    const workspaceRoot = realpathSync(workspace);
    const gateways: Array<ReturnType<typeof startCodexQueue>> = [];
    let active: TmuxSession | null = null;

    try {
      const savedGateway = startCodexQueue([codexFinalText("saved session")]);
      gateways.push(savedGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, savedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Save a resumable turn.");
      await active.waitForText("saved session", TIMEOUT);
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;

      const hold: HoldState = { started: false, cancelled: false };
      const heldGateway = startCodexQueue([() => heldCodexResponse(hold)]);
      gateways.push(heldGateway);
      writeFileSync(stderrPath, "");
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: workspaceRoot,
        env: seededFakeCodexEnv(home, heldGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Keep this response active.");
      await waitForCondition(() => hold.started, "held gateway response");
      await active.waitForText("Generating", TIMEOUT);

      await active.sendText("/resume");
      await active.waitForText("resume is unavailable until the response finishes", TIMEOUT);
      const duringStream = await active.capturePane();
      expect(duringStream).not.toContain("updated");

      await active.sendKeys("Escape");
      await waitForCondition(() => hold.cancelled, "Escape to cancel the held response");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
    } finally {
      if (active) await active.kill();
      for (const gateway of gateways) gateway.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TIMEOUT * 2,
);
test.skipIf(!tmuxAvailable())(
  "cancelled command presentation survives a distinct-process resume",
  async () => {
    const timeout = 60_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-cancelled-command-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const initialStderrPath = join(root, "initial-stderr.log");
    const resumedStderrPath = join(root, "resumed-stderr.log");
    const tracePath = join(root, "trace.log");
    const readyPath = join(workspace, ".interrupt-ready");
    const scriptPath = join(workspace, "resume-cancel.sh");
    const assistantMarker = "PARTIAL_ASSISTANT_BEFORE_INTERRUPT";
    const outputMarker = "INTERRUPT_START";
    const bufferedTailMarker = "INTERRUPT_BUFFERED_TAIL";
    const artifactTailMarker = "INTERRUPT_TERM_TAIL";
    const followUpMarker = "INTERRUPT_FOLLOW_UP_DONE";
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(initialStderrPath, "");
    writeFileSync(resumedStderrPath, "");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
trap 'printf "${artifactTailMarker}\\n"; exit 0' TERM
printf '${outputMarker}\\n'
printf '${bufferedTailMarker}'
: > .interrupt-ready
while :; do sleep 1; done
`,
    );
    chmodSync(scriptPath, 0o755);

    const initialGateway = startCodexQueue([
      codexSerializedToolCall(
        "resume-cancelled-command",
        "shell",
        JSON.stringify({
          request: {
            action: "run",
            command: "./resume-cancel.sh",
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
          },
        }),
        assistantMarker,
      ),
      codexFinalText(followUpMarker),
    ]);
    const resumedGateway = startCodexQueue([]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "session,agent,tool,worker,interrupt,command_output,transcript",
        },
        stderrPath: initialStderrPath,
        width: 120,
        height: 40,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared interrupt command.");
      await waitForScrollback(active, "Running ./resume-cancel.sh", timeout);
      await waitForCondition(
        () => existsSync(readyPath),
        "the interrupt command readiness file",
        timeout,
      );
      await active.sendKeys("Escape");
      await waitForScrollback(active, "Cancelled", timeout);
      await waitForCondition(
        () => existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=interrupt_persisted"),
        "the interrupted command history event",
        timeout,
      );
      const liveCancelled = stripAnsi(await active.captureFullScrollback());
      expect(liveCancelled).not.toContain(outputMarker);
      expect(liveCancelled).not.toContain(bufferedTailMarker);
      expect(liveCancelled).not.toContain(artifactTailMarker);

      await active.sendText("Reply with the prepared follow-up marker.");
      await waitForScrollback(active, followUpMarker, timeout);
      expect(initialGateway.requests).toHaveLength(2);
      const followUpBody = initialGateway.requests[1]!.body;
      expect(followUpBody).toContain("<turn_aborted>");
      expect(followUpBody).not.toContain(outputMarker);
      expect(followUpBody).not.toContain(bufferedTailMarker);
      expect(followUpBody).not.toContain(artifactTailMarker);
      expect(followUpBody).not.toContain("cancelled_command");
      expect(followUpBody).not.toContain("output_replay");
      expect(followUpBody).not.toContain("command_artifact_handle");
      expect(followUpBody).not.toContain(".command_artifacts");

      const sessionId = sessionIdFromHome(home);
      const commandDir = join(home, ".fiber", "sessions", sessionId, "logs", "commands");
      const replayNames = readdirSync(commandDir).filter((name) =>
        name.endsWith(".bin")
      );
      expect(replayNames).toHaveLength(1);
      const replayName = replayNames[0]!;
      const replayPath = join(commandDir, replayName);
      expect(statSync(replayPath).size).toBeGreaterThan(0);
      expect(followUpBody).toContain(replayName);
      expect(followUpBody).not.toContain(replayPath);

      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(initialStderrPath, "utf8")).toBe("");

      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: resumedStderrPath,
        width: 120,
        height: 40,
      });
      await active.waitForComposer(TIMEOUT);
      const resumed = stripAnsi(await waitForScrollback(active, followUpMarker, timeout));
      const assistantIndex = resumed.indexOf(assistantMarker);
      const cancelledIndex = resumed.indexOf("Cancelled");
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(cancelledIndex).toBeGreaterThan(assistantIndex);
      expect(resumed).not.toContain(outputMarker);
      expect(resumed).not.toContain("Interrupted by user after completing");
      expect(resumed).not.toContain("<turn_aborted>");
      expect(resumed).not.toContain(bufferedTailMarker);
      expect(resumed).not.toContain(artifactTailMarker);

      await active.sendKeys("C-o");
      await active.waitForText(artifactTailMarker, timeout);
      const detail = stripAnsi(await active.capturePane()).replaceAll("\n", "");
      expect(detail).toContain(outputMarker);
      expect(detail).toContain(bufferedTailMarker);
      expect(detail).toContain(artifactTailMarker);
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
      passed = true;
    } finally {
      if (active) {
        if (!passed) {
          try {
            writeFileSync(join(root, "failure-scrollback.txt"), await active.captureFullScrollback());
          } catch {}
        } else {
          try {
            await active.sendKeys("C-o");
            await active.sendText("/quit");
          } catch {}
        }
        await active.kill();
      }
      initialGateway.stop();
      resumedGateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained cancelled command resume artifacts at ${root}`);
      }
    }
  },
  120_000,
);

test.skipIf(!tmuxAvailable())(
  "zero-output cancelled command restores its row without an output block",
  async () => {
    const timeout = 60_000;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-zero-output-cancel-resume-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const initialStderrPath = join(root, "initial-stderr.log");
    const resumedStderrPath = join(root, "resumed-stderr.log");
    const tracePath = join(root, "trace.log");
    const readyPath = join(workspace, ".zero-ready");
    const scriptPath = join(workspace, "z.sh");
    mkdirSync(join(home, ".fiber"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(home, ".fiber", "settings.json"),
      JSON.stringify({ sandbox: "none", permission_mode: "auto", permission: {} }),
    );
    writeFileSync(initialStderrPath, "");
    writeFileSync(resumedStderrPath, "");
    writeFileSync(
      scriptPath,
      "#!/bin/sh\ntrap 'exit 0' TERM\n: > .zero-ready\nwhile :; do sleep 1; done\n",
    );
    chmodSync(scriptPath, 0o755);

    const initialGateway = startCodexQueue([
      fakeShellRun("resume-zero-output-command", "./z.sh"),
    ]);
    const resumedGateway = startCodexQueue([]);
    let active: TmuxSession | null = null;
    let passed = false;
    try {
      active = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: realpathSync(workspace),
        env: {
          ...seededFakeCodexEnv(home, initialGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "session,agent,tool,worker,interrupt,command_output,transcript",
        },
        stderrPath: initialStderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      await active.sendText("Run the prepared silent command.");
      await waitForCondition(
        () => existsSync(readyPath),
        "the zero-output command readiness file",
        timeout,
      );
      await active.sendKeys("Escape");
      await waitForScrollback(active, "Cancelled", timeout);
      await waitForCondition(
        () => existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=interrupt_persisted"),
        "the zero-output interrupted history event",
        timeout,
      );
      await active.sendText("/quit");
      expect(await active.waitForSessionEnd()).toBe(true);
      await active.kill();
      active = null;
      expect(readFileSync(initialStderrPath, "utf8")).toBe("");

      active = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: realpathSync(workspace),
        env: seededFakeCodexEnv(home, resumedGateway, { FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL, NO_COLOR: "1" }),
        stderrPath: resumedStderrPath,
        width: 100,
        height: 32,
      });
      await active.waitForComposer(TIMEOUT);
      const resumed = stripAnsi(await waitForScrollback(active, "● System: cancelled", timeout));
      const cancelledIndex = resumed.indexOf("Cancelled");
      const cancellationNoticeIndex = resumed.indexOf("● System: cancelled");
      expect(cancelledIndex).toBeGreaterThanOrEqual(0);
      expect(cancellationNoticeIndex).toBeGreaterThan(cancelledIndex);
      // The rendered notice may repeat across resume repaints, so require
      // at-least-once here and pin exact-once on the trace event: one
      // Escape produced exactly one persisted interrupt.
      expect(countOccurrences(resumed, "● System: cancelled")).toBeGreaterThanOrEqual(1);
      expect(countOccurrences(readFileSync(tracePath, "utf8"), "event=interrupt_persisted")).toBe(1);
      expect(resumed).not.toContain("Interrupted by user after completing");
      expect(resumed).not.toContain("<turn_aborted>");
      const restoredPresentation = resumed.slice(cancelledIndex, cancellationNoticeIndex);
      expect(
        restoredPresentation.split("\n").some((line) => line.trimStart().startsWith("│")),
      ).toBe(false);
      expect(restoredPresentation).not.toContain("command lines folded");
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
      await active.sendKeys("C-o");
      await Bun.sleep(300);
      const fullTranscript = stripAnsi(await active.capturePane());
      expect(fullTranscript).toContain("Cancelled ./z.sh");
      expect(fullTranscript).not.toContain('"command":"./z.sh"');
      expect(fullTranscript).not.toMatch(/^\s*(?:input|result)\s*$/m);
      await active.sendKeys("Escape");
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
      initialGateway.stop();
      resumedGateway.stop();
      if (passed) {
        rmSync(root, { recursive: true, force: true });
      } else {
        console.error(`retained zero-output cancelled command resume artifacts at ${root}`);
      }
    }
  },
  120_000,
);
