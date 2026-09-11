import { afterEach, describe, expect, test } from "bun:test";
import {
  execFileSync,
  spawn as nodeSpawn,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, runFx } from "../evals/eval-helpers";
import {
  codexFinalText,
  codexInputItems,
  codexSerializedToolCall,
  codexToolCall,
  FAKE_CODEX_DEFAULT_MODEL,
  isVolatileTokenStatusRow,
  seededFakeCodexEnv,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const COMMAND_APPROVAL_PROMPT = "Would you like to run the following command?";
const MANAGE_SUBAGENT_PROGRESS = "Managing subagent\n";

type IsolatedRoot = {
  root: string;
  home: string;
  workspace: string;
  hostileBin: string;
  profileMarker: string;
  commandMarkers: Record<string, string>;
};

type TerminalFixtureState = {
  pid: number;
  pgid: number;
  sid: number;
  tty_opened: boolean;
  tty_errno: number | null;
  tcsetpgrp_attempted: boolean;
  tcsetpgrp_succeeded: boolean;
};

type TerminalProcessRow = {
  pid: number;
  pgid: number;
  tpgid: number;
  stat: string;
  command: string;
};

const roots: string[] = [];
const codexes: Array<{ stop(): void }> = [];
let activeSession: TmuxSession | null = null;

afterEach(async () => {
  if (activeSession) {
    await activeSession.kill();
    activeSession = null;
  }
  for (const codex of codexes.splice(0)) codex.stop();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function toolCall(
  command: string,
  options: Record<string, unknown> = {},
  toolCallId = "command_1",
) {
  return codexToolCall(toolCallId, "shell", {
    action: "run",
    yield_time_ms: 30_000,
    timeout_ms: 600_000,
    command,
    ...options,
  });
}

function reviewDecision(
  decision: "clear" | "caution",
  id: string,
  rationale = "deterministic test decision",
): string {
  return codexToolCall(id, "permission_decision", {
    risk: decision === "caution" ? "high" : "low",
    decision,
    rationale,
  });
}

function toolCalls(command: string, callIds: string[]) {
  return codexBatchToolCalls(
    callIds.map((toolCallId) => [toolCallId, "shell", {
      action: "run",
      command,
      yield_time_ms: 30_000,
      timeout_ms: 600_000,
    }] as [string, string, object]),
  );
}

function twoEffectfulCommandBatch(first: string, second: string) {
  return codexBatchToolCalls([
    ["history_feedback_first", "shell", {
      action: "run",
      command: first,
      yield_time_ms: 30_000,
      timeout_ms: 600_000,
    }],
    ["history_feedback_second", "shell", {
      action: "run",
      command: second,
      yield_time_ms: 30_000,
      timeout_ms: 600_000,
    }],
  ]);
}

// One model turn may carry several tool calls; each needs its own output_index.
function codexBatchToolCalls(calls: Array<[string, string, object]>): string {
  let out = "";
  calls.forEach(([id, name, args], index) => {
    out += `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "function_call", call_id: id, name },
    })}\n\n`;
    out += `data: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      output_index: index,
      arguments: JSON.stringify(args),
    })}\n\n`;
  });
  out +=
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
  return out;
}

function sessionIdFromHome(root: IsolatedRoot): string {
  const sessions = join(root.home, ".fiber", "sessions");
  const ids = readdirSync(sessions, { withFileTypes: true })
    .filter((entry) => entry.name !== "latest" && entry.isDirectory())
    .map((entry) => entry.name);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

function latestTraceReportPath(root: IsolatedRoot): string {
  const reports = readdirSync(root.root)
    .filter((entry) => entry.startsWith("fiber-trace-") && entry.endsWith(".md"))
    .map((entry) => {
      const path = join(root.root, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  expect(reports.length).toBeGreaterThan(0);
  return reports[0]!.path;
}

function expectGroupedContinuationRequest(
  body: string,
  feedback: string,
) {
  const first = body.indexOf("first command completed");
  const second = body.indexOf("second command completed");
  const amendment = body.indexOf(feedback);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(amendment).toBeGreaterThan(second);
}

function expectOrdinaryToolResults(body: string, callIds: string[]) {
  const results = codexInputItems(body).filter(
    (item) => item.type === "function_call_output",
  );

  expect(results).toHaveLength(callIds.length);
  expect(results.map((part) => part.call_id).sort()).toEqual([...callIds].sort());
  for (const result of results) {
    expect(typeof result.output).toBe("string");
    expect(JSON.parse(result.output as string)).toMatchObject({
      state: "completed",
      exit_code: 0,
      error: null,
    });
  }
  expect(body).not.toContain("Repeated identical tool call blocked");
}

// Tool results ride the Responses input as function_call_output items; the
// output string is the shell snapshot JSON or the review-held echo JSON.
function toolResultText(body: string, toolCallId: string): string {
  const result = codexInputItems(body).find(
    (item) =>
      item.type === "function_call_output" && item.call_id === toolCallId,
  );
  expect(result).toBeDefined();
  expect(typeof result!.output).toBe("string");
  return result!.output as string;
}

function completedToolCallIds(body: string): string[] {
  return codexInputItems(body)
    .filter((item) => item.type === "function_call_output")
    .map((item) => item.call_id as string);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).join("");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return [
      contentText(object.text),
      contentText(object.value),
      contentText(object.content),
      contentText(object.output),
    ].join("");
  }
  return "";
}

function promptText(body: string): string {
  return codexInputItems(body).map((item) => contentText(item)).join("\n");
}

function latestPromptText(body: string): string {
  return contentText(codexInputItems(body).at(-1));
}

function currentUserText(body: string): string {
  return contentText(
    codexInputItems(body).findLast((item) => item.role === "user"),
  );
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForTraceSlice(
  tracePath: string,
  offset: number,
  label: string,
  predicate: (trace: string) => boolean,
  timeoutMs = TIMEOUT,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let trace = "";
  while (Date.now() < deadline) {
    if (existsSync(tracePath)) {
      trace = readFileSync(tracePath, "utf8").slice(offset);
    }
    if (predicate(trace)) return trace;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\nTrace:\n${trace}`);
}

function finalText(text: string) {
  return codexFinalText(text);
}

type CodexResponse = string | ((body: string) => string | Promise<string>);

type CodexQueue = ReturnType<typeof startFakeCodex>;

// The Codex helper serves one callback instead of a finite queue, so scripted
// multi-step turns pop responses in order, awaiting async fixture steps.
// Unresolved actions pause for a permission review round-trip; review requests
// carry <permission_review> and answer from a separate decision queue without
// consuming the scripted turn queue, and stay out of `requests` so turn
// indices match the codex era.
function startCodexQueue(
  responses: CodexResponse[],
  reviewResponses: CodexResponse[] = [],
): CodexQueue & { reviewRequests: Array<{ body: string }> } {
  const pending = [...responses];
  const reviews = [...reviewResponses];
  const turnRequests: CodexQueue["requests"] = [];
  const reviewRequests: Array<{ body: string }> = [];
  let fallbackReviews = 0;
  const codex = startFakeCodex({
    route: async (body: string) => {
      if (body.includes("<permission_review>")) {
        reviewRequests.push({ body });
        const next = reviews.shift();
        if (!next) {
          fallbackReviews += 1;
          return reviewDecision("clear", `review_decision_${fallbackReviews}`);
        }
        return typeof next === "function" ? await next(body) : next;
      }
      turnRequests.push({ path: "", authorization: null, body });
      const next = pending.shift();
      if (!next) return codexFinalText("unexpected turn");
      return typeof next === "function" ? await next(body) : next;
    },
  });
  return { ...codex, requests: turnRequests, reviewRequests };
}

function startFakeGateway(
  responses: CodexResponse[],
  reviewResponses: CodexResponse[] = [],
) {
  const codex = startCodexQueue(responses, reviewResponses);
  codexes.push(codex);
  return codex;
}

// fiber ask --json wraps payloads in {ok, kind, data}: unwrap the envelope.
function parseFxJson(result: Awaited<ReturnType<typeof runFx>>) {
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout.trim()) as { data: unknown }).data as any;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeTerminalOwnershipFixture(path: string) {
  writeFileSync(path, `#!/usr/bin/env python3
import json
import os
import signal
import sys
import time

state_path = sys.argv[1]
release_path = sys.argv[2]
tty_fd = None
state = {
    "pid": os.getpid(),
    "pgid": os.getpgrp(),
    "sid": os.getsid(0),
    "tty_opened": False,
    "tty_errno": None,
    "tcsetpgrp_attempted": False,
    "tcsetpgrp_succeeded": False,
}

try:
    tty_fd = os.open("/dev/tty", os.O_RDWR)
    state["tty_opened"] = True
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    state["tcsetpgrp_attempted"] = True
    os.tcsetpgrp(tty_fd, state["pgid"])
    state["tcsetpgrp_succeeded"] = True
except OSError as error:
    state["tty_errno"] = error.errno
finally:
    if tty_fd is not None:
        os.close(tty_fd)

pending_path = state_path + ".pending"
with open(pending_path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, sort_keys=True)
    handle.flush()
    os.fsync(handle.fileno())
os.replace(pending_path, state_path)

print("TTY_SESSION_STDOUT_BEGIN", flush=True)
print("TTY_SESSION_STDERR", file=sys.stderr, flush=True)
deadline = time.monotonic() + 20
while not os.path.exists(release_path) and time.monotonic() < deadline:
    time.sleep(0.02)
if not os.path.exists(release_path):
    sys.exit(124)
print("TTY_SESSION_STDOUT_END", flush=True)
`);
  chmodSync(path, 0o755);
}

async function waitForTerminalFixture(path: string): Promise<TerminalFixtureState> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as TerminalFixtureState;
      } catch {}
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for terminal fixture state at ${path}`);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for path at ${path}`);
}

async function waitForGatewayRequestCount(
  codex: { requests: Array<{ body: string }> },
  count: number,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (codex.requests.length >= count) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${count} model requests`);
}

function paneTty(session: TmuxSession): string {
  return execFileSync(
    "tmux",
    ["display-message", "-t", session.name, "-p", "#{pane_tty}"],
    { encoding: "utf8" },
  ).trim();
}

function terminalProcessRows(ttyPath: string): TerminalProcessRow[] {
  const tty = ttyPath.replace(/^\/dev\//, "");
  let output = "";
  try {
    output = execFileSync(
      "ps",
      ["-t", tty, "-o", "pid=,pgid=,tpgid=,stat=,command="],
      { encoding: "utf8" },
    );
  } catch (error: any) {
    output = error?.stdout?.toString?.() ?? "";
  }
  return output.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/,
    );
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      pgid: Number(match[2]),
      tpgid: Number(match[3]),
      stat: match[4]!,
      command: match[5]!,
    }];
  });
}

function foregroundFxRow(
  ttyPath: string,
  binary: string,
): TerminalProcessRow & { sid: number } {
  const row = terminalProcessRows(ttyPath).find((entry) =>
    entry.command.includes(binary) &&
    !entry.command.includes("__fiber_foreground_session__")
  );
  expect(row).toBeDefined();
  expect(row!.pgid).toBe(row!.tpgid);
  expect(row!.stat).not.toContain("T");
  const sid = Number(execFileSync(
    "python3",
    ["-c", "import os,sys; print(os.getsid(int(sys.argv[1])))", String(row!.pid)],
    { encoding: "utf8" },
  ).trim());
  return { ...row!, sid };
}

function toolResultValue(body: string, toolCallId: string): string {
  return toolResultText(body, toolCallId);
}

function expectTraceOrder(trace: string, markers: string[]) {
  let offset = 0;
  for (const marker of markers) {
    const index = trace.indexOf(marker, offset);
    if (index < offset) {
      throw new Error(`Missing ordered trace marker ${JSON.stringify(marker)} after byte ${offset}`);
    }
    offset = index + marker.length;
  }
}

function createIsolatedRoot(baseDir = tmpdir()): IsolatedRoot {
  const root = realpathSync(mkdtempSync(join(baseDir, "fiber-command-permissions-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const hostileBin = join(root, "hostile-bin");
  const profileMarker = join(root, "hostile-profile-used");
  const commandMarkers: Record<string, string> = {};
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostileBin, { recursive: true });
  writeFileSync(
    join(home, ".fiber", "settings.json"),
    JSON.stringify({ sandbox: "none", permission: {} }),
  );
  writeFileSync(join(home, ".profile"), `printf profile > ${JSON.stringify(profileMarker)}\n`);
  writeFileSync(join(home, ".zprofile"), `printf zprofile > ${JSON.stringify(profileMarker)}\n`);
  writeFileSync(join(workspace, "line\nname"), "");
  writeFileSync(join(workspace, "\x1bname"), "");
  for (const name of ["pwd", "ls", "wc", "printf", "git"]) {
    const script = join(hostileBin, name);
    const marker = join(root, `hostile-${name}-used`);
    commandMarkers[name] = marker;
    writeFileSync(
      script,
      `#!/bin/sh\nprintf used > ${JSON.stringify(marker)}\nexit 99\n`,
    );
    chmodSync(script, 0o755);
  }
  roots.push(root);
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    hostileBin,
    profileMarker,
    commandMarkers,
  };
}

function hostilePath(root: IsolatedRoot) {
  return `${root.hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

function installClipboardFixture(root: IsolatedRoot, script: string) {
  for (const command of ["pbcopy", "xclip", "osascript"]) {
    const path = join(root.hostileBin, command);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
}

function installUrlOpenerFixture(root: IsolatedRoot, script: string) {
  for (const command of ["open", "xdg-open"]) {
    const path = join(root.hostileBin, command);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
}

function codexEnv(
  root: IsolatedRoot,
  codex: ReturnType<typeof startFakeGateway>,
  extra: Record<string, string | undefined> = {},
) {
  return seededFakeCodexEnv(root.home, codex, {
    FIBER_MODEL: FAKE_CODEX_DEFAULT_MODEL,
    FIBER_DIRECT_SECRET: "must-not-be-inherited",
    NO_COLOR: "1",
    ...extra,
  });
}

function definedEnv(env: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function launchPermissionResumeHarness(initialResponses: CodexResponse[]) {
  const root = createIsolatedRoot();
  const settingsPath = join(root.home, ".fiber", "settings.json");
  const markerPath = join(root.workspace, "must-not-exist");
  const initialStderrPath = join(root.root, "permission-resume-initial-stderr.log");
  const resumedStderrPath = join(root.root, "permission-resume-resumed-stderr.log");
  writeFileSync(initialStderrPath, "");
  writeFileSync(resumedStderrPath, "");

  const initialCodex = startFakeGateway(initialResponses);
  const initialSession = await TmuxSession.create({
    cmd: FIBER_BIN,
    cwd: root.workspace,
    env: codexEnv(root, initialCodex, { FIBER_PERMISSION_MODE: undefined }),
    stderrPath: initialStderrPath,
    width: 120,
    height: 40,
  });
  activeSession = initialSession;

  return {
    root,
    settingsPath,
    markerPath,
    initialCodex,
    initialSession,
    initialStderrPath,
    resumedStderrPath,
    readSettings() {
      return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    },
    async resume(responses: CodexResponse[]) {
      await initialSession.sendText("/quit");
      await initialSession.waitForSessionEnd(TIMEOUT);
      if (activeSession === initialSession) activeSession = null;

      const codex = startFakeGateway(responses);
      const session = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: root.workspace,
        env: codexEnv(root, codex, { FIBER_PERMISSION_MODE: undefined }),
        stderrPath: resumedStderrPath,
        width: 120,
        height: 40,
      });
      activeSession = session;
      return { codex, session };
    },
  };
}

function expectUserProfileTrace(tracePath: string) {
  const trace = readFileSync(tracePath, "utf8");
  expect(trace).toContain(
    "shell.run authority=shell_allowed source=yolo " +
      "route=approved_shell environment=user",
  );
  expect(trace).toContain("command runner explicit environment=user shell=");
  expect(trace).not.toContain("authority=direct_only route=direct_read_only");
}

function expectNoCommandArtifacts(root: IsolatedRoot) {
  const sessions = join(root.home, ".fiber", "sessions");
  if (!existsSync(sessions)) return;
  const files = Bun.spawnSync(["find", sessions, "-type", "f"], {
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString().trim().split("\n").filter(Boolean);
  const legacyArtifacts = files.filter((path) =>
    path.includes("/logs/commands/") && path.endsWith(".log")
  );
  expect(legacyArtifacts).toEqual([]);
}

function commandReplayFiles(root: IsolatedRoot): string[] {
  const sessions = join(root.home, ".fiber", "sessions");
  if (!existsSync(sessions)) return [];
  const result = Bun.spawnSync(
    ["find", sessions, "-type", "f", "-name", "fiber-command-replay-*"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

function expectNoHostileExecutables(root: IsolatedRoot) {
  for (const marker of Object.values(root.commandMarkers)) {
    expect(existsSync(marker)).toBe(false);
  }
}

function largeEffectfulCommand(marker: string) {
  const command = [
    ...Array.from(
      { length: 84 },
      (_, index) => `# large lifecycle ${index.toString().padStart(3, "0")} ${"x".repeat(720)}`,
    ),
    `printf '%s\\n' FIBER_LARGE_RUN_COMMAND_DONE > ${marker}`,
  ].join("\n");
  expect(Buffer.byteLength(command)).toBeGreaterThan(57 * 1024);
  return command;
}

async function expectSavedShellRun(
    root: IsolatedRoot,
    sessionId: string,
    command: string,
    status: "success" | "failure" = "success",
) {
  const result = await runFx(
    ["session", "show", "--id", sessionId, "--json"],
    { cwd: root.workspace, env: { HOME: root.home } },
  );
  expect(result.code).toBe(0);
  // session --json wraps payloads in {ok, kind, data}: unwrap the envelope.
  const detail = (JSON.parse(result.stdout) as { data: unknown }).data as any;
  const step = detail.history
    .flatMap((turn: any) => turn.execution?.tool_steps ?? [])
    .find((entry: any) => entry.tool_calls?.some((call: any) => call.name === "shell"));
  expect(step).toBeDefined();
  const call = step.tool_calls.find((entry: any) => entry.name === "shell");
  expect(JSON.parse(call.arguments_json)).toEqual(
    expect.objectContaining({
      action: "run",
      yield_time_ms: 30_000,
      timeout_ms: 600_000,
      command,
    }),
  );
  expect(step.tool_results).toContainEqual(
    expect.objectContaining({ tool_call_id: call.id, tool_name: "shell", status }),
  );
}

function normalizeVolatileStatusRows(grid: string[]): string[] {
  return grid.map((line) =>
    /^• Streaming \([^)]*\)$/.test(line) ||
      isVolatileTokenStatusRow(line)
      ? "<status>"
      : line.replace(/\s+YOLO enabled: fiber permission checks disabled$/, "")
  );
}

test("volatile token status rows normalize before transcript grid comparison", () => {
  expect(normalizeVolatileStatusRows(["  (↑10 ↓5)"])).toEqual(["<status>"]);
  expect(normalizeVolatileStatusRows(["  0s (↑10 ↓5)"])).toEqual(["<status>"]);
  expect(normalizeVolatileStatusRows([
    "YOLO · gpt-5                 YOLO enabled: fiber permission checks disabled",
  ])).toEqual(["YOLO · gpt-5"]);
});

describe("effect-aware command permissions", () => {
  test.skipIf(!tmuxAvailable())(
    "TUI keeps amended feedback after a two-command result batch through both resume paths",
    async () => {
      const root = createIsolatedRoot();
      const feedback = "first command feedback marker";
      const firstCommand = "touch history-feedback-first.txt && printf 'first command completed\\n'";
      const secondCommand = "touch history-feedback-second.txt && printf 'second command completed\\n'";
      const tapePath = join(root.root, "history-feedback.fibertape");
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      const codex = startFakeGateway([
        twoEffectfulCommandBatch(firstCommand, secondCommand),
        finalText("history feedback live complete"),
      ]);
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "gateway,permission,session,tool",
        }),
        stderrPath,
        width: 100,
        height: 28,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the prepared two-command history fixture.");
      await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      await activeSession.sendKeys("Tab");
      await activeSession.waitForText("Yes, and tell fiber what to do next", TIMEOUT);
      await activeSession.sendLiteralText(feedback);
      await activeSession.waitForText(`Yes, ${feedback}`, TIMEOUT);
      await activeSession.sendKeys("Enter");

      await activeSession.waitForPane(
        (pane) => pane.includes(COMMAND_APPROVAL_PROMPT) &&
          pane.includes("history-feedback-second.txt"),
        10_000,
      );
      await activeSession.sendKeys("1");
      await activeSession.waitForText("history feedback live complete", TIMEOUT);

      const scrollback = await activeSession.captureFullScrollback();
      expect(scrollback.indexOf("first command completed")).toBeGreaterThanOrEqual(0);
      expect(scrollback.indexOf("second command completed")).toBeGreaterThan(
        scrollback.indexOf("first command completed"),
      );
      expect(scrollback.indexOf(feedback)).toBeGreaterThan(
        scrollback.indexOf("second command completed"),
      );
      const rawAnsiScrollback = await activeSession.captureFullScrollbackEscapes();
      expect(rawAnsiScrollback).toContain(feedback);
      expect(existsSync(join(root.workspace, "history-feedback-first.txt"))).toBe(true);
      expect(existsSync(join(root.workspace, "history-feedback-second.txt"))).toBe(true);
      expect(codex.requests).toHaveLength(2);
      expectGroupedContinuationRequest(codex.requests[1]!.body, feedback);
      expect(readFileSync(tracePath, "utf8")).not.toContain("InvalidGatewayHistory");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;

      const sessionId = sessionIdFromHome(root);
      const events = readFileSync(
        join(root.home, ".fiber", "sessions", sessionId, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain(feedback);

      const cliResumeCodex = startFakeGateway([
        finalText("history feedback cli resume complete"),
      ]);
      const cliResume = await runFx(
        [
          "ask",
          "--permission-mode", "auto",
          "--resume-id",
          sessionId,
          "Continue through the exact resume flag.",
        ],
        { cwd: root.workspace, env: codexEnv(root, cliResumeCodex) },
      );
      expect(cliResume.code).toBe(0);
      // The isolated root seeds the inert legacy `sandbox` key, which issue
      // #26 reports as an unknown-config-key diagnostic on stderr.
      expect(cliResume.stderr).toBe(
        "fiber ask: config user: unknown_config_key; key=sandbox; unknown configuration key; check the spelling or remove it\n",
      );
      expect(cliResumeCodex.requests).toHaveLength(1);
      expectGroupedContinuationRequest(cliResumeCodex.requests[0]!.body, feedback);

      const pickerCodex = startFakeGateway([
        finalText("history feedback picker resume complete"),
      ]);
      writeFileSync(stderrPath, "");
      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, pickerCodex),
        stderrPath,
        width: 100,
        height: 28,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/resume");
      await activeSession.waitForText("Run the prepared two-command history fixture.", TIMEOUT);
      await activeSession.sendKeys("Enter");
      await activeSession.waitForText("history feedback cli resume complete", TIMEOUT);
      const pickerScrollback = await activeSession.captureFullScrollback();
      expect(pickerScrollback.indexOf("first command completed")).toBeGreaterThanOrEqual(0);
      expect(pickerScrollback.indexOf(feedback)).toBeGreaterThan(
        pickerScrollback.indexOf("first command completed"),
      );
      expect(pickerScrollback.indexOf("second command completed")).toBeGreaterThan(
        pickerScrollback.indexOf(feedback),
      );
      await activeSession.sendText("Continue through interactive resume.");
      await activeSession.waitForText("history feedback picker resume complete", TIMEOUT);
      expect(pickerCodex.requests).toHaveLength(1);
      expectGroupedContinuationRequest(pickerCodex.requests[0]!.body, feedback);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;

      const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: root.workspace,
        env: { HOME: root.home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      expect(replay.stdout).toContain(feedback);
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI control completes the same two-command batch with normal approvals",
    async () => {
      const root = createIsolatedRoot();
      const firstCommand = "touch history-feedback-first.txt && printf 'first command completed\\n'";
      const secondCommand = "touch history-feedback-second.txt && printf 'second command completed\\n'";
      const codex = startFakeGateway([
        twoEffectfulCommandBatch(firstCommand, secondCommand),
        finalText("history feedback control complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 100,
        height: 28,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the prepared two-command control fixture.");
      await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      await activeSession.sendKeys("1");
      await activeSession.waitForPane(
        (pane) => pane.includes(COMMAND_APPROVAL_PROMPT) &&
          pane.includes("history-feedback-second.txt"),
        10_000,
      );
      await activeSession.sendKeys("1");
      await activeSession.waitForText("history feedback control complete", TIMEOUT);

      expect(codex.requests).toHaveLength(2);
      expect(existsSync(join(root.workspace, "history-feedback-first.txt"))).toBe(true);
      expect(existsSync(join(root.workspace, "history-feedback-second.txt"))).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo executes pwd through the default user profile without prompting",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([toolCall("pwd"), finalText("direct complete")]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          FIBER_PERMISSION_MODE: "yolo",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "core",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd once.");
      const pane = await activeSession.waitForText("direct complete", TIMEOUT);

      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(codex.requests).toHaveLength(2);
      expect(codex.requests[1].body).toContain(root.workspace);
      expectUserProfileTrace(tracePath);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo user-profile command waits for authoritative arguments after streamed text",
    async () => {
      const root = createIsolatedRoot();
      const streamText = "DIRECT_NO_NOTICE_STREAM_TEXT";
      const codex = startFakeGateway([
        codexSerializedToolCall(
          "command_1",
          "shell",
          JSON.stringify({
            action: "run",
            yield_time_ms: 30_000,
            timeout_ms: 600_000,
            command: "pwd",
          }),
          streamText,
        ),
        finalText("direct auto complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          FIBER_PERMISSION_MODE: "yolo",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "core,permission,tool",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd once in auto mode.");
      await activeSession.waitForText("direct auto complete", TIMEOUT);

      const scrollback = await activeSession.captureFullScrollback();
      const completedIndex = scrollback.indexOf("└ Ran pwd");
      const streamTextIndex = scrollback.indexOf(streamText);
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(streamTextIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(streamTextIndex);
      expect(scrollback).not.toContain("Preparing command");
      expect(scrollback).not.toContain("Auto agent approved this request");
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(0);
      expectUserProfileTrace(tracePath);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI keeps command output exclusive to Ctrl-O through resize and resume",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "current-command-output-stderr.log");
      const resumedStderrPath = join(root.root, "current-command-output-resumed-stderr.log");
      writeFileSync(
        join(root.home, ".fiber", "settings.json"),
        JSON.stringify({
          sandbox: "none",
          permission_mode: "auto",
          permission: {},
        }),
      );
      writeFileSync(stderrPath, "");
      writeFileSync(resumedStderrPath, "");

      const scripts = [
        {
          name: "fxc110-fast.sh",
          body: "#!/bin/sh\nprintf 'FXC110_FAST_STDOUT\\n'\n",
        },
        {
          name: "fxc110-stream.sh",
          body:
            "#!/bin/sh\nprintf 'FXC110_STREAM_STDOUT\\n'\nsleep 1\nprintf 'FXC110_STREAM_STDERR\\n' >&2\nsleep 1\n",
        },
        {
          name: "fxc110-failed.sh",
          body: "#!/bin/sh\nprintf 'FXC110_FAILED_STDERR\\n' >&2\nexit 7\n",
        },
      ];
      for (const script of scripts) {
        const path = join(root.workspace, script.name);
        writeFileSync(path, script.body);
        chmodSync(path, 0o755);
      }

      const calls = [
        { id: "fxc110-fast", command: "./fxc110-fast.sh" },
        { id: "fxc110-stream", command: "./fxc110-stream.sh" },
        { id: "fxc110-failed", command: "./fxc110-failed.sh" },
      ];
      const codex = startFakeGateway([
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "FXC110_PROVIDER_BRIDGE",
        })}\n\n` +
          codexBatchToolCalls(
            calls.map((call) => [call.id, "shell", {
              action: "run",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
              command: call.command,
            }] as [string, string, object]),
          ),
        finalText("FXC110_COMPLETE"),
      ]);
      const outputRows = [
        "│ FXC110_FAST_STDOUT",
        "│ FXC110_STREAM_STDOUT",
        "│ FXC110_STREAM_STDERR",
        "│ FXC110_FAILED_STDERR",
      ];
      const expectNoOutputRows = (text: string) => {
        for (const row of outputRows) expect(text).not.toContain(row);
      };

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_TRACE_LOG: join(root.root, "minimal-command-output-trace.log"),
          FIBER_TRACE_SCOPES: "core,agent,tool,session,command_output",
        }),
        stderrPath,
        width: 120,
        height: 36,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the prepared command matrix.");
      await activeSession.waitForText("Running ./fxc110-stream.sh", TIMEOUT);
      await Bun.sleep(250);
      const running = await activeSession.captureFullScrollback();
      expect(running).toContain("Running ./fxc110-stream.sh");
      expectNoOutputRows(running);

      await activeSession.waitForText("1 failed", TIMEOUT);
      const completed = await activeSession.captureFullScrollback();
      expect(completed).toContain("3 tool calls");
      expect(completed).toContain("1 failed");
      for (const script of scripts) expect(completed).toContain(script.name);
      expectNoOutputRows(completed);

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.waitForText("FXC110_FAILED_STDERR", TIMEOUT);
      const full = await activeSession.capturePane();
      expect(full).toContain("FXC110_FAST_STDOUT");
      expect(full).toContain("FXC110_STREAM_STDOUT");
      expect(full).toContain("FXC110_STREAM_STDERR");
      expect(full).toContain("FXC110_FAILED_STDERR");

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("3 tool calls", TIMEOUT);
      expectNoOutputRows(await activeSession.captureFullScrollback());
      await activeSession.resizeWindow(64, 28);
      expectNoOutputRows(await activeSession.captureFullScrollback());

      await activeSession.kill();
      activeSession = null;
      activeSession = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
        }),
        stderrPath: resumedStderrPath,
        width: 88,
        height: 32,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.waitForText("3 tool calls", TIMEOUT);
      expectNoOutputRows(await activeSession.captureFullScrollback());

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.waitForText("FXC110_FAILED_STDERR", TIMEOUT);
      let resumedFull = await activeSession.capturePane();
      await activeSession.sendHexBytes(["1b", "5b", "35", "7e"]);
      await Bun.sleep(100);
      resumedFull += `\n${await activeSession.capturePane()}`;
      expect(resumedFull).toContain("FXC110_FAST_STDOUT");
      expect(resumedFull).toContain("FXC110_STREAM_STDOUT");
      expect(resumedFull).toContain("FXC110_STREAM_STDERR");
      expect(resumedFull).toContain("FXC110_FAILED_STDERR");
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(calls.length);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI user-profile printf keeps compact output hidden and Ctrl-O complete",
    async () => {
      const root = createIsolatedRoot();
      const tracePath = join(root.root, "direct-printf-trace.log");
      const stderrPath = join(root.root, "direct-printf-stderr.log");
      const resumedStderrPath = join(root.root, "direct-printf-resumed-stderr.log");
      const losslessRows = Array.from(
        { length: 7 },
        (_, index) => `DIRECT_LOSSLESS_${String(index + 1).padStart(2, "0")}`,
      );
      const losslessFormat =
        Array.from({ length: losslessRows.length - 1 }, () => "%s\\n").join("") + "%s";
      const losslessCommand = `printf '${losslessFormat}' ${
        losslessRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const lossyRows = [
        "DIRECT_PADDED",
        "DIRECT_LITERAL_</stdout>",
        "DIRECT_LOSSY_03",
        "DIRECT_LOSSY_04",
        "DIRECT_LOSSY_05",
        "DIRECT_LOSSY_06",
        "DIRECT_LOSSY_07",
        "DIRECT_TRAILING",
      ];
      const lossyFormat = "  %s  \\n\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s   ";
      const lossyCommand = `printf '${lossyFormat}' ${
        lossyRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const codex = startFakeGateway([
        toolCall(losslessCommand, {}, "direct_printf_lossless"),
        finalText("DIRECT_LOSSLESS_DONE"),
        toolCall(lossyCommand, {}, "direct_printf_lossy"),
        finalText("DIRECT_LOSSY_DONE"),
      ]);
      writeFileSync(stderrPath, "");
      writeFileSync(resumedStderrPath, "");
      const commandOutputText = (text: string): string =>
        text.split("\n").filter((line) => line.trimStart().startsWith("│ ")).join("\n");
      const toolResultValue = (body: string, toolCallId: string): string => {
        const result = codexInputItems(body).find(
          (item) => item.type === "function_call_output" && item.call_id === toolCallId,
        );
        expect(result).toBeDefined();
        return String(result?.output ?? "");
      };

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          FIBER_PERMISSION_MODE: "yolo",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "core,tool,session,command_output",
        }),
        stderrPath,
        width: 72,
        height: 30,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the lossless direct printf fixture.");
      await activeSession.waitForText("DIRECT_LOSSLESS_DONE", TIMEOUT);
      await activeSession.waitForPane(
        (pane) => pane.includes("DIRECT_LOSSLESS_DONE") && !pane.includes("Streaming ("),
        TIMEOUT,
      );

      const losslessCompact = await activeSession.captureFullScrollback();
      const losslessCompactOutput = commandOutputText(losslessCompact);
      expect(losslessCompactOutput).toBe("");
      expect(losslessCompact).toContain("Ran printf");
      for (const row of losslessRows) expect(losslessCompact).not.toContain(`│ ${row}`);
      expect(commandReplayFiles(root)).toHaveLength(1);
      const losslessGrid = await activeSession.capturePaneGrid();

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.waitForText(losslessRows[6]!, TIMEOUT);
      const losslessFull = await activeSession.capturePane();
      const losslessFullOutput = commandOutputText(losslessFull);
      for (const row of losslessRows) expect(losslessFullOutput).toContain(`│ ${row}`);
      expect(losslessFullOutput).not.toContain("<stdout>");
      expect(losslessFullOutput).not.toContain("</stdout>");
      expect(losslessFullOutput).not.toContain("lines more (ctrl o");
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("DIRECT_LOSSLESS_DONE", TIMEOUT);
      expect(normalizeVolatileStatusRows(await activeSession.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(losslessGrid),
      );

      await activeSession.sendText("Run the lossy direct printf fixture.");
      await activeSession.waitForText("DIRECT_LOSSY_DONE", TIMEOUT);
      await activeSession.waitForPane(
        (pane) => pane.includes("DIRECT_LOSSY_DONE") && !pane.includes("Streaming ("),
        TIMEOUT,
      );
      const lossyCompact = await activeSession.captureFullScrollback();
      const lossyCompactOutput = commandOutputText(lossyCompact);
      expect(lossyCompactOutput).toBe("");
      expect(lossyCompact).toContain("Ran printf");
      for (const row of lossyRows) expect(lossyCompact).not.toContain(`│ ${row}`);
      expect(commandReplayFiles(root)).toHaveLength(2);
      const lossyGrid = await activeSession.capturePaneGrid();

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.sendHexBytes(["1b", "5b", "36", "7e"]);
      await activeSession.waitForText(lossyRows[7]!, TIMEOUT);
      const lossyFull = await activeSession.capturePane();
      const lossyFullOutput = commandOutputText(lossyFull);
      for (const row of lossyRows) expect(lossyFullOutput).toContain(row);
      expect(lossyFullOutput.match(/^│ DIRECT_LITERAL_<\/stdout>$/gm)).toHaveLength(1);
      expect(lossyFullOutput).not.toContain("<stdout>");
      expect(lossyFullOutput).not.toContain("exit_code=0");
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("DIRECT_LOSSY_DONE", TIMEOUT);
      expect(normalizeVolatileStatusRows(await activeSession.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(lossyGrid),
      );

      expect(codex.requests).toHaveLength(4);
      const losslessModelResult = toolResultValue(
        codex.requests[1]!.body,
        "direct_printf_lossless",
      );
      expect(losslessModelResult).toContain(losslessRows[6]!);
      expect(losslessModelResult).not.toContain("command_output_replay");
      const lossyModelResult = toolResultValue(
        codex.requests[3]!.body,
        "direct_printf_lossy",
      );
      expect(lossyModelResult).toContain(lossyRows[1]!);
      expect(lossyModelResult).toContain("  DIRECT_PADDED  ");
      expect(lossyModelResult).toContain("DIRECT_TRAILING   ");
      expect(lossyModelResult).not.toContain("command_output_replay");
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const sessionId = sessionIdFromHome(root);
      const publicSession = await runFx(
        ["session", "show", "--id", sessionId, "--json"],
        { cwd: root.workspace, env: { HOME: root.home } },
      );
      expect(publicSession.code).toBe(0);
      expect(publicSession.stdout).not.toContain("command_output_replay");
      expect(publicSession.stdout).not.toContain("command_replay");
      expect(publicSession.stdout).not.toContain("command_process_presentation");
      expect(publicSession.stdout).not.toContain("process_presentation");
      expect(publicSession.stdout).toContain("full_output_handle");
      expect(publicSession.stdout).toContain("fiber-command-replay-");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
      await activeSession.kill();
      activeSession = null;

      const resumedGateway = startFakeGateway([]);
      activeSession = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume last`,
        cwd: root.workspace,
        env: codexEnv(root, resumedGateway),
        stderrPath: resumedStderrPath,
        width: 72,
        height: 30,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.waitForText("Ran printf", TIMEOUT);
      const resumedCompact = await activeSession.capturePane();
      const resumedCompactOutput = commandOutputText(resumedCompact);
      expect(resumedCompactOutput).toBe("");
      for (const row of lossyRows) expect(resumedCompact).not.toContain(`│ ${row}`);
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.sendHexBytes(["1b", "5b", "36", "7e"]);
      await activeSession.waitForText(lossyRows[7]!, TIMEOUT);
      const resumedFull = await activeSession.capturePane();
      const resumedFullOutput = commandOutputText(resumedFull);
      for (const row of lossyRows) expect(resumedFullOutput).toContain(row);
      expect(resumedFullOutput.match(/^│ DIRECT_LITERAL_<\/stdout>$/gm)).toHaveLength(1);
      expect(resumedFullOutput).not.toContain("<stdout>");
      expect(resumedGateway.requests).toHaveLength(0);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI user-profile output preserves compact scrollback across slash commands",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "output-setting-removal-stderr.log");
      const commandRows = Array.from(
        { length: 7 },
        (_, index) => `FXC29_COMMAND_${String(index + 1).padStart(2, "0")}`,
      );
      const responseRows = Array.from(
        { length: 10 },
        (_, index) => `FXC29_RESPONSE_${String(index + 1).padStart(2, "0")}`,
      );
      const command = `printf '${Array.from({ length: 7 }, () => "%s\\n").join("")}' ${
        commandRows.map((row) => JSON.stringify(row)).join(" ")
      }`;
      const codex = startFakeGateway([
        toolCall(command, {}, "fxc29_compact_output"),
        finalText(responseRows.join("\n")),
      ]);
      const settingsPath = join(root.home, ".fiber", "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          sandbox: "none",
          permission: {},
          output_level: { legacy: true },
          workspaces: {
            [root.workspace]: { output_level: ["quiet", 7] },
          },
        }),
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, { FIBER_PERMISSION_MODE: "yolo" }),
        stderrPath,
        width: 90,
        height: 30,
        minimumHistoryLines: 1_000,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/output quiet");
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);
      expect(promptText(codex.requests[0]!.body)).toContain("/output quiet");
      expect(codex.requests).toHaveLength(2);
      const compact = await activeSession.captureFullScrollback();
      expect(compact).toContain("Ran printf");
      for (const row of commandRows) expect(compact).not.toContain(`│ ${row}`);

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      await activeSession.waitForText(commandRows.at(-1)!, TIMEOUT);
      const full = await activeSession.capturePane();
      for (const row of commandRows) expect(full).toContain(`│ ${row}`);
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);

      const extractResponses = (scrollback: string) =>
        [...scrollback.matchAll(/FXC29_RESPONSE_\d{2}/g)].map((match) => match[0]);
      const beforeSlashCommands = await activeSession.captureFullScrollback();
      expect(extractResponses(beforeSlashCommands)).toEqual(responseRows);

      // /sound was removed; an unknown slash with arguments now
      // routes to the model, so only retained slash commands exercise this path.
      await activeSession.sendText("/settings");
      await activeSession.waitForText("←→ Change", TIMEOUT);
      await activeSession.sendKeys("Escape");
      await activeSession.waitForPane(
        (pane) => !pane.includes("←→ Change"),
        TIMEOUT,
      );
      await activeSession.waitForText(responseRows.at(-1)!, TIMEOUT);

      const afterSlashCommands = await activeSession.captureFullScrollback();
      expect(extractResponses(afterSlashCommands)).toEqual(responseRows);
      expect(afterSlashCommands).toContain("Ran printf");
      for (const row of commandRows) {
        expect(afterSlashCommands).not.toContain(`│ ${row}`);
      }
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).output_level).toEqual({
        legacy: true,
      });
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    60_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo completes more than twenty-five serial user-profile commands when unlimited",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([
        ...Array.from(
          { length: 26 },
          (_, index) => toolCall("pwd", {}, `command_${index + 1}`),
        ),
        finalText("unlimited direct commands complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          FIBER_PERMISSION_MODE: "yolo",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd until you can answer.");
      await activeSession.waitForText("unlimited direct commands complete", TIMEOUT);

      const scrollback = await activeSession.captureFullScrollback();
      expect(scrollback).not.toContain(
        "Agent step limit reached; continue with a follow-up prompt if needed.",
      );
      expect(codex.requests).toHaveLength(27);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );


  test.skipIf(!tmuxAvailable())(
    "TUI creates a private Markdown trace without a feedback CTA",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([]);
      const stderrPath = join(root.root, "trace-report-stderr.log");
      const clipboardPath = join(root.root, "trace-clipboard-path.txt");
      installClipboardFixture(
        root,
        '#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf "%s" "$last" > "$FIBER_TRACE_CLIPBOARD_OUTPUT"\n',
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          TMPDIR: root.root,
          FIBER_TRACE_CLIPBOARD_OUTPUT: clipboardPath,
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("/trace");
      await activeSession.waitForText(
        process.platform === "darwin"
          ? "Trace copied to clipboard"
          : "Trace saved at",
        TIMEOUT,
      );

      const escapes = await activeSession.capturePaneEscapes();
      expect(escapes).not.toContain("Trace:");
      expect(escapes).not.toContain("Report issue");
      expect(escapes).not.toContain("fx.sh/feedback");
      expect(escapes).not.toContain("github.com");
      const reportPath = latestTraceReportPath(root);
      const report = readFileSync(reportPath, "utf8");
      expect(report).toContain("# fiber trace");
      expect(report).toContain("## Summary");
      expect(report).toContain(root.workspace);
      expect(statSync(reportPath).mode & 0o077).toBe(0);
      if (process.platform === "darwin") {
        expect(readFileSync(clipboardPath, "utf8")).toBe(reportPath);
      } else {
        expect(existsSync(clipboardPath)).toBe(false);
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI keeps automatic review internal in compact and full transcripts",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-approved.txt");
      const command = `printf approved > ${JSON.stringify(marker)}`;
      const codex = startFakeGateway([
        toolCall(command),
        finalText("classifier approved complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "permission,tool",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the classifier approval fixture.");
      await activeSession.waitForPane(
        (pane) =>
          pane.includes("classifier approved complete") &&
          !pane.includes("Streaming ("),
        TIMEOUT,
      );

      const compactScrollback = await activeSession.captureFullScrollback();
      expect(compactScrollback).not.toContain(
        "Auto agent approved this request: Running command.",
      );
      expect(compactScrollback).toContain("└ Ran");
      const compactGrid = await activeSession.capturePaneGrid();

      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
      const fullTranscript = await activeSession.capturePane();
      expect(fullTranscript).not.toContain("Auto agent approved this request");
      expect(fullTranscript.indexOf("└ Ran")).toBeGreaterThanOrEqual(0);
      await activeSession.sendKeys("C-o");
      await activeSession.waitForText("classifier approved complete", TIMEOUT);
      expect(normalizeVolatileStatusRows(await activeSession.capturePaneGrid())).toEqual(
        normalizeVolatileStatusRows(compactGrid),
      );
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("approved");
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(readFileSync(tracePath, "utf8")).toContain("approval_source=auto_classifier");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI preserves completed transcript when a later auto-approved command starts",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "auto-command-scrollback-stderr.log");
      const tapePath = join(root.root, "auto-command-scrollback.fibertape");
      const markerPrefix = "AUTO_COMMAND_SCROLLBACK_LINE_";
      const expectedMarkers = Array.from(
        { length: 40 },
        (_, index) => `${markerPrefix}${String(index + 1).padStart(2, "0")}`,
      );
      const firstPrompt = "Render the numbered transcript fixture.";
      const secondPrompt = "Run seq 1 1.";
      const finalResponse = "AUTO_COMMAND_SCROLLBACK_COMPLETE";
      const hasComposer = (pane: string) =>
        pane.split("\n").some((line) => line.trim() === "┃");
      let releaseClassifier!: (response: string) => void;
      const heldClassifier = new Promise<string>((resolve) => {
        releaseClassifier = resolve;
      });
      const codex = startFakeGateway(
        [
          finalText(expectedMarkers.join("\n")),
          toolCall("seq 1 1", {}, "scrollback_command"),
          finalText(finalResponse),
        ],
        [() => heldClassifier],
      );
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_RECORD: tapePath,
        }),
        stderrPath,
        width: 120,
        height: 36,
        minimumHistoryLines: 1_000,
      });
      expect(activeSession.paneSize()).toEqual({ cols: 120, rows: 36 });
      await activeSession.waitForPane(hasComposer, TIMEOUT);
      await activeSession.sendText(firstPrompt);
      await activeSession.waitForText(expectedMarkers.at(-1)!, TIMEOUT);
      await activeSession.waitForPane(hasComposer, TIMEOUT);
      expect(codex.requests).toHaveLength(1);

      await activeSession.sendText(secondPrompt);
      await activeSession.waitForText(secondPrompt, TIMEOUT);
      const classifierDeadline = Date.now() + TIMEOUT;
      while (codex.reviewRequests.length === 0 && Date.now() < classifierDeadline) {
        await Bun.sleep(10);
      }
      expect(codex.reviewRequests).toHaveLength(1);

      const extractMarkers = (scrollback: string) =>
        [...scrollback.matchAll(/AUTO_COMMAND_SCROLLBACK_LINE_\d{2}/g)].map(
          (match) => match[0],
        );
      const beforeScrollback = await activeSession.captureFullScrollback();
      expect(extractMarkers(beforeScrollback)).toEqual(expectedMarkers);
      expect(beforeScrollback.indexOf(secondPrompt)).toBeGreaterThan(
        beforeScrollback.indexOf(expectedMarkers.at(-1)!),
      );
      expect(beforeScrollback).not.toContain("Auto agent approved this request");

      releaseClassifier(reviewDecision("clear", "permission_decision_1"));
      const finalPane = await activeSession.waitForPane(
        (pane) => pane.includes(finalResponse) && hasComposer(pane),
        TIMEOUT,
      );
      expect(finalPane.split("\n").filter((line) => line.trim() === "┃")).toHaveLength(1);

      const afterScrollback = await activeSession.captureFullScrollback();
      expect(extractMarkers(afterScrollback)).toEqual(expectedMarkers);
      const afterLines = afterScrollback.split("\n");
      const lastMarkerLine = afterLines.findIndex((line) =>
        line.includes(expectedMarkers.at(-1)!)
      );
      const secondPromptLine = afterLines.findIndex((line) => line.includes(secondPrompt));
      const completedLine = afterLines.findIndex((line) => line.includes("Ran seq 1 1"));
      const outputLine = afterLines.findIndex((line, index) =>
        index > completedLine && line.trim() === "│ 1"
      );
      const finalLine = afterLines.findIndex((line) => line.includes(finalResponse));
      expect(secondPromptLine).toBeGreaterThan(lastMarkerLine);
      expect(afterScrollback).not.toContain("Auto agent approved this request");
      expect(completedLine).toBeGreaterThan(secondPromptLine);
      expect(outputLine).toBe(-1);
      expect(finalLine).toBeGreaterThan(completedLine);
      expect(codex.requests).toHaveLength(3);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(activeSession.isAlive()).toBe(true);
      expect(activeSession.isPaneAlive()).toBe(true);

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
      await activeSession.kill();
      activeSession = null;

      const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
        cwd: root.workspace,
        env: { HOME: root.home },
      });
      expect(replay.code).toBe(0);
      expect(replay.stderr).toBe("");
      expect(replay.stdout).toContain(expectedMarkers.at(-1)!);
      expect(replay.stdout).toContain(finalResponse);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI isolates approved foreground commands from terminal ownership",
    async () => {
      const binary = process.env.FIBER_COMMAND_SESSION_TEST_BIN ?? FIBER_BIN;
      const sandboxModes = ["legacy-sandbox-key"] as const;

      for (const sandbox of sandboxModes) {
        const root = createIsolatedRoot();
        const fixturePath = join(root.workspace, "terminal-session-fixture.py");
        const statePath = join(root.workspace, "terminal-session-state.json");
        const releasePath = join(root.workspace, "terminal-session-release");
        const outerReturnPath = join(root.root, `terminal-session-${sandbox}-outer-returned`);
        const stderrPath = join(root.root, `terminal-session-${sandbox}-stderr.log`);
        const tracePath = join(root.root, `terminal-session-${sandbox}-trace.log`);
        const tapePath = join(root.root, `terminal-session-${sandbox}.fibertape`);
        const command = [
          "exec python3",
          shellQuote(fixturePath),
          shellQuote(statePath),
          shellQuote(releasePath),
        ].join(" ");
        const codex = startFakeGateway([
          toolCall(command, {}, "terminal_session_command"),
          finalText(`TTY_SESSION_FINAL_${sandbox}`),
          toolCall("pwd", {}, "terminal_session_pwd"),
          finalText(`TTY_SESSION_PWD_FINAL_${sandbox}`),
        ]);
        const outerShell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
        const outerArgs = outerShell.endsWith("zsh")
          ? "-f -i"
          : "--noprofile --norc -i";

        writeTerminalOwnershipFixture(fixturePath);
        writeFileSync(
          join(root.home, ".fiber", "settings.json"),
          JSON.stringify({ sandbox: "os", permission: {} }),
        );
        writeFileSync(join(root.home, ".profile"), "");
        writeFileSync(join(root.home, ".zprofile"), "");
        writeFileSync(stderrPath, "");

        activeSession = await TmuxSession.create({
          cmd: `${shellQuote(outerShell)} ${outerArgs}`,
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            SHELL: outerShell,
            TMPDIR: "/tmp",
            DEVELOPER_DIR: process.platform === "darwin"
              ? "/Library/Developer/CommandLineTools"
              : undefined,
            FIBER_PERMISSION_MODE: "auto",
            FIBER_RECORD: tapePath,
            FIBER_RECORD_INPUT: "1",
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "agent,core,gateway,permission,session,tool,worker",
          }),
          width: 120,
          height: 40,
          minimumHistoryLines: 1_000,
        });
        await activeSession.sendText(
          "export PS1='FIBER_OUTER_PROMPT> '; printf 'FIBER_OUTER_SHELL_READY\\n'",
        );
        await activeSession.waitForText("FIBER_OUTER_SHELL_READY", TIMEOUT);
        await activeSession.sendText(
          `${shellQuote(binary)} 2>${shellQuote(stderrPath)}; ` +
            `printf '%s' "$?" > ${shellQuote(outerReturnPath)}`,
        );
        await activeSession.waitForComposer(TIMEOUT);

        const ttyPath = paneTty(activeSession);
        const baselineFx = foregroundFxRow(ttyPath, binary);
        await activeSession.sendText(`Run the ${sandbox} terminal ownership fixture.`);
        const fixture = await waitForTerminalFixture(statePath);

        try {
          expect(fixture.pid).not.toBe(fixture.pgid);
          expect(fixture.pgid).toBe(fixture.sid);
          expect(fixture.sid).not.toBe(baselineFx.sid);
          expect(fixture.tty_opened).toBe(false);
          expect(fixture.tty_errno).not.toBeNull();
          expect(fixture.tcsetpgrp_attempted).toBe(false);
          expect(fixture.tcsetpgrp_succeeded).toBe(false);
          foregroundFxRow(ttyPath, binary);
          process.kill(fixture.pid, 0);

          await activeSession.waitForText("Running exec python3", TIMEOUT);
          await activeSession.sendLiteralText("q");
          await activeSession.waitForPane((pane) => pane.includes("┃ q"), TIMEOUT);
          foregroundFxRow(ttyPath, binary);
          process.kill(fixture.pid, 0);
          await activeSession.sendKeys("C-u");
        } finally {
          writeFileSync(releasePath, "release\n");
        }

        await activeSession.waitForText(`TTY_SESSION_FINAL_${sandbox}`, TIMEOUT);
        foregroundFxRow(ttyPath, binary);
        await activeSession.sendText("Run pwd through the user profile.");
        await activeSession.waitForText(`TTY_SESSION_PWD_FINAL_${sandbox}`, TIMEOUT);
        foregroundFxRow(ttyPath, binary);

        expect(codex.requests).toHaveLength(4);
        expect(codex.reviewRequests).toHaveLength(2);
        expect(codex.reviewRequests[0]!.body).toContain("action: command");
        expect(codex.reviewRequests[1]!.body).toContain("action: command");
        expect(codex.reviewRequests[1]!.body).toContain("command: pwd");
        const commandResult = toolResultValue(
          codex.requests[1]!.body,
          "terminal_session_command",
        );
        const commandSnapshot = JSON.parse(commandResult);
        expect(commandSnapshot).toMatchObject({
          state: "completed",
          backend: "captured",
          persistence: "process",
          exit_code: 0,
        });
        expect(commandSnapshot.output_delta).toContain("TTY_SESSION_STDOUT_BEGIN");
        expect(commandSnapshot.output_delta).toContain("TTY_SESSION_STDOUT_END");
        expect(commandSnapshot.output_delta).toContain("TTY_SESSION_STDERR");
        expect(commandSnapshot.full_output_handle).toMatch(/^fiber-command-replay-.+\.bin$/);
        expect(codex.requests[1]!.body).not.toContain("\\u001e");
        expect(codex.requests[1]!.body).not.toContain("\\u0006");
        expect(codex.requests[1]!.body).not.toContain("\\u0000");
        expect(codex.requests[1]!.body).not.toContain("FIBER_FOREGROUND_EXEC_FAILED");
        const pwdResult = toolResultValue(
          codex.requests[3]!.body,
          "terminal_session_pwd",
        );
        expect(JSON.parse(pwdResult).output_delta).toContain(root.workspace);

        const scrollback = await activeSession.captureFullScrollback();
        const completedIndex = scrollback.indexOf("Ran exec python3");
        const finalIndex = scrollback.indexOf(`TTY_SESSION_FINAL_${sandbox}`);
        const followupIndex = scrollback.indexOf("Run pwd through the user profile.");
        const pwdFinalIndex = scrollback.indexOf(`TTY_SESSION_PWD_FINAL_${sandbox}`);
        expect(completedIndex).toBeGreaterThanOrEqual(0);
        expect(scrollback).not.toContain("TTY_SESSION_STDOUT_BEGIN");
        expect(scrollback).not.toContain("TTY_SESSION_STDOUT_END");
        expect(finalIndex).toBeGreaterThan(completedIndex);
        expect(followupIndex).toBeGreaterThan(finalIndex);
        expect(pwdFinalIndex).toBeGreaterThan(followupIndex);
        expect(scrollback).not.toContain("suspended (tty input)");
        expect(scrollback).not.toContain("FIBER_FOREGROUND_EXEC_FAILED");

        await activeSession.sendKeys("C-o");
        await activeSession.waitForText("Full detail · ctrl o close", TIMEOUT);
        await activeSession.waitForText("TTY_SESSION_STDERR", TIMEOUT);
        const full = await activeSession.capturePane();
        expect(full).toContain("TTY_SESSION_STDOUT_BEGIN");
        expect(full).toContain("TTY_SESSION_STDOUT_END");
        expect(full).toContain("TTY_SESSION_STDERR");
        await activeSession.sendKeys("C-o");
        await activeSession.waitForComposer(TIMEOUT);

        const trace = readFileSync(tracePath, "utf8");
        expect(trace).toContain(
          "shell.run authority=shell_allowed source=auto_classifier " +
            "route=approved_shell environment=user",
        );
        expect(trace).toContain("command runner explicit environment=user shell=");
        expect(trace).not.toContain("authority=direct_only route=direct_read_only");
        expectTraceOrder(trace, [
          "event=permission_decision turn_id=1 step_id=1 call_id=terminal_session_command",
          "event=execution_start turn_id=1 step_id=1 call_id=terminal_session_command",
          "event=execution_result turn_id=1 step_id=1 call_id=terminal_session_command",
          "event=assistant_completion turn_id=1 step_id=2",
          "event=execution_start turn_id=2 step_id=3 call_id=terminal_session_pwd",
          "event=execution_result turn_id=2 step_id=3 call_id=terminal_session_pwd",
          "event=assistant_completion turn_id=2 step_id=4",
        ]);
        await activeSession.sendText("/quit");
        await waitForPath(outerReturnPath);
        expect(readFileSync(outerReturnPath, "utf8")).toBe("0");
        expect(readFileSync(stderrPath, "utf8")).toBe("");
        await activeSession.sendText("exit");
        expect(await activeSession.waitForSessionEnd(TIMEOUT)).toBe(true);
        await activeSession.kill();
        activeSession = null;

        await expectSavedShellRun(
          root,
          sessionIdFromHome(root),
          command,
        );
        const replay = await runFx(["debug", "replay", tapePath, "--frames"], {
          cwd: root.workspace,
          env: { HOME: root.home },
        });
        expect(replay.code).toBe(0);
        expect(replay.stderr).toBe("");
        expect(replay.stdout).toContain("TTY_SESSION_STDOUT_BEGIN");
        expect(replay.stdout).toContain("TTY_SESSION_STDOUT_END");
        expect(replay.stdout).toContain(`TTY_SESSION_PWD_FINAL_${sandbox}`);
        expect(replay.stdout).not.toContain("FIBER_FOREGROUND_EXEC_FAILED");
      }
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI automatic caution returns advice without prompting",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-user-check.txt");
      const command = "printf user-check > classifier-user-check.txt";
      const codex = startFakeGateway(
        [
          toolCall(command),
          finalText("classifier automatic caution complete"),
        ],
        [reviewDecision("caution", "permission_decision_1")],
      );
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "permission",
          TMPDIR: root.root,
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the classifier ask fixture.");
      const pane = await activeSession.waitForPane(
        (value) => value.includes("classifier automatic caution complete") && value.includes("┃"),
        TIMEOUT,
      );
      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(existsSync(marker)).toBe(false);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(pane).not.toContain("Auto agent denied");
      expect(pane).toContain("1 denied");
      expect(pane).toContain(`Safety caution ${command}`);
      expect(pane).not.toContain("└ terminal");
      expect(codex.requests).toHaveLength(2);
      const permissionResultRequest = codex.requests[1]!.body;
      expect(permissionResultRequest).toContain("tool_review_held");
      expect(permissionResultRequest).toContain("review_caution");
      expect(permissionResultRequest).not.toContain("user_denied");
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain("auto_review_result tool_name=shell decision=caution");
      expect(trace).toContain("decision=deny approval_source=denied");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      const sessionId = sessionIdFromHome(root);
      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;

      rmSync(
        join(root.home, ".fiber", "sessions", sessionId, "resume-view.bin"),
        { force: true },
      );
      activeSession = await TmuxSession.create({
        cmd: `${FIBER_BIN} resume ${sessionId}`,
        cwd: root.workspace,
        env: codexEnv(root, codex, { TMPDIR: root.root }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      const resumedPane = await activeSession.waitForPane(
        (value) => value.includes(`Safety caution ${command}`),
        TIMEOUT,
      );
      expect(resumedPane).toContain("1 denied");
      expect(resumedPane).not.toContain("└ terminal");
      expect(resumedPane).not.toContain("tool_permission_denied");
      expect(codex.requests).toHaveLength(2);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT * 2,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI auto mode keeps tools active across unavailable reviews",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-fallback-approved.txt");
      const command = `printf fallback > ${JSON.stringify(marker)}`;
      const codex = startFakeGateway(
        [
          toolCall(command, {}, "invalid_review_1"),
          toolCall(command, {}, "invalid_review_2"),
          toolCall(command, {}, "invalid_review_3"),
          (body) => {
            expect(body).not.toContain('"tools":[]');
            expect(body).not.toContain('"toolChoice":{"type":"none"}');
            return toolCall(command, {}, "invalid_review_4");
          },
          finalText("Reviewer unavailable handled normally."),
        ],
        Array.from({ length: 4 }, () => finalText("invalid")),
      );
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "permission",
          TMPDIR: root.root,
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the reviewer fallback fixture.");
      const pane = await activeSession.waitForText(
        "Reviewer unavailable handled normally.",
        TIMEOUT,
      );

      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(existsSync(marker)).toBe(false);
      expect(codex.requests).toHaveLength(5);
      expect(codex.reviewRequests).toHaveLength(4);
      const trace = readFileSync(tracePath, "utf8");
      expect(
        trace.match(/decision=unavailable fallback_reason=invalid_or_unavailable/g),
      ).toHaveLength(4);
      expect(trace).not.toContain("event=automatic_recovery_exhausted");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI yolo returns every repeated user-profile command result to the model",
    async () => {
      const root = createIsolatedRoot();
      const callIds = Array.from({ length: 10 }, (_, index) => `command_${index + 1}`);
      const codex = startFakeGateway([
        toolCalls("pwd", callIds),
        finalText("repetition batch complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
          FIBER_PERMISSION_MODE: "yolo",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "core",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run pwd until you can answer.");
      const pane = await activeSession.waitForText("repetition batch complete", TIMEOUT);

      expect(pane).not.toContain(COMMAND_APPROVAL_PROMPT);
      expect(pane).not.toContain("Guarding repeated");
      expect(codex.requests).toHaveLength(2);
      expectOrdinaryToolResults(codex.requests[1].body, callIds);
      expect(codex.requests[1].body).not.toContain("Agent stopped:");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI cancellation aborts held automatic review and returns idle",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "held-review-must-not-run.txt");
      const command = `printf cancelled > ${JSON.stringify(marker)}`;
      let releaseClassifier!: (response: string) => void;
      const heldClassifier = new Promise<string>((resolve) => {
        releaseClassifier = resolve;
      });
      const codex = startFakeGateway(
        [
          toolCall(command),
          finalText("follow-up after review cancellation"),
        ],
        [() => heldClassifier],
      );
      const tracePath = join(root.root, "trace.log");
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "permission,interrupt",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the held automatic review fixture.");
      const reviewDeadline = Date.now() + TIMEOUT;
      while (codex.reviewRequests.length === 0 && Date.now() < reviewDeadline) {
        await Bun.sleep(10);
      }
      expect(codex.reviewRequests).toHaveLength(1);

      await activeSession.sendKeys("Escape");
      const cancelDeadline = Date.now() + TIMEOUT;
      while (
        (!existsSync(tracePath) || !readFileSync(tracePath, "utf8").includes("fallback_reason=Cancelled")) &&
        Date.now() < cancelDeadline
      ) {
        await Bun.sleep(10);
      }
      expect(readFileSync(tracePath, "utf8")).toContain("fallback_reason=Cancelled");
      releaseClassifier(reviewDecision("clear", "permission_decision_1"));
      expect(existsSync(marker)).toBe(false);

      await activeSession.sendText("Confirm the next prompt works.");
      const pane = await activeSession.waitForText(
        "follow-up after review cancellation",
        TIMEOUT,
      );
      expect(pane).toContain("┃");
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(readFileSync(tracePath, "utf8")).not.toContain("decision=clear");
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test(
    "default fiber ask defaults missing permission mode to auto",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "ask-turn-default-auto.txt");
      const command = `printf ask-turn-auto > ${JSON.stringify(marker)}`;
      const codex = startFakeGateway([
        toolCall(command),
        finalText("ask turn default auto complete"),
      ]);

      const result = await runFx(["ask", "Create the marker."], {
        cwd: root.workspace,
        env: codexEnv(root, codex, {
        }),
        timeoutMs: TIMEOUT,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ask turn default auto complete");
      expect(result.stderr).not.toContain("permission required");
      expect(existsSync(marker)).toBe(true);
      expect(codex.requests).toHaveLength(2);
    },
    TIMEOUT,
  );

  test(
    "fiber ask yolo returns repeated user-profile command results to the model",
    async () => {
      const root = createIsolatedRoot();
      const callIds = ["direct_1", "direct_2", "direct_3"];
      const codex = startFakeGateway([
        toolCalls("pwd", callIds),
        finalText("direct repetition complete"),
      ]);

      const result = await runFx(["ask", "--permission-mode", "yolo", "Run pwd until you can answer."], {
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
        }),
        timeoutMs: TIMEOUT,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("direct repetition complete");
      expect(result.stderr).toContain("Running pwd");
      expect(codex.requests).toHaveLength(2);
      expectOrdinaryToolResults(codex.requests[1].body, callIds);
      expect(codex.requests[1].body).not.toContain("Agent stopped:");
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask yolo completes more than ten serial user-profile commands when unlimited",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([
        ...Array.from(
          { length: 11 },
          (_, index) => toolCall("pwd", {}, `direct_${index + 1}`),
        ),
        finalText("direct unlimited complete"),
      ]);

      const result = await runFx(["ask", "--permission-mode", "yolo", "Run pwd until you can answer."], {
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          PATH: hostilePath(root),
        }),
        timeoutMs: TIMEOUT,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("direct unlimited complete");
      expect(result.stderr).toContain("Running pwd");
      expect(codex.requests).toHaveLength(12);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI /permissions ask preserves complete existing scrollback",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "permissions-scrollback-stderr.log");
      const tracePath = join(root.root, "permissions-scrollback-trace.log");
      const markerPrefix = "PERMISSIONS_SCROLLBACK_LINE_";
      const expectedMarkers = Array.from(
        { length: 80 },
        (_, index) => `${markerPrefix}${String(index + 1).padStart(2, "0")}`,
      );
      const codex = startFakeGateway([finalText(expectedMarkers.join("\n"))]);
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: undefined,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "scroll,frame_commit",
        }),
        stderrPath,
        width: 120,
        height: 36,
        minimumHistoryLines: 1_000,
      });

      await activeSession.waitForText("auto · gpt-5.6-luna", TIMEOUT);
      await activeSession.sendText("Render the fixed scrollback fixture.");
      await activeSession.waitForText(expectedMarkers.at(-1)!, TIMEOUT);
      expect(codex.requests).toHaveLength(1);

      const extractMarkers = (scrollback: string) =>
        [...scrollback.matchAll(/PERMISSIONS_SCROLLBACK_LINE_\d{2}/g)].map(
          (match) => match[0],
        );
      const waitForExpectedScrollback = async () => {
        const deadline = Date.now() + TIMEOUT;
        let latest = "";
        while (Date.now() < deadline) {
          latest = await activeSession!.captureFullScrollback();
          const markers = extractMarkers(latest);
          if (
            markers.length === expectedMarkers.length &&
            markers.every((marker, index) => marker === expectedMarkers[index])
          ) return latest;
          await Bun.sleep(100);
        }
        throw new Error(
          `Timed out waiting for complete permissions scrollback.\nScrollback:\n${latest}`,
        );
      };
      const beforeScrollback = await waitForExpectedScrollback();
      expect(extractMarkers(beforeScrollback)).toEqual(expectedMarkers);
      const traceOffset = readFileSync(tracePath, "utf8").length;

      await activeSession.sendText("/permissions ask");
      await activeSession.waitForText("mode set to ask", TIMEOUT);
      await activeSession.waitForText("ask · gpt-5.6-luna", TIMEOUT);

      const commandTrace = await waitForTraceSlice(
        tracePath,
        traceOffset,
        "permissions projection commits",
        (trace) => {
          const lines = trace.split(/\r?\n/);
          return lines.some((line) =>
            line.includes("transcript_transition_plan") &&
            line.includes("footer_reservation_changed=true") &&
            line.includes("replay_displaced_footer_history=true") &&
            /semantic_rows=([1-9]\d*) planned_rows=\1 .* geometry_rebase=true/.test(line)
          ) && lines.some((line) =>
            line.includes("transcript_transition_plan") &&
            line.includes("footer_reservation_changed=true") &&
            line.includes("replay_displaced_footer_history=false") &&
            line.includes("semantic_rows=0 planned_rows=0") &&
            line.includes("geometry_rebase=true")
          ) && trace.includes("transcript_projection_history_floor");
        },
        45_000,
      );

      const afterScrollback = await waitForExpectedScrollback();
      expect(extractMarkers(afterScrollback)).toEqual(expectedMarkers);
      expect([...afterScrollback.matchAll(/mode set to ask/g)]).toHaveLength(1);
      expect(afterScrollback.indexOf("mode set to ask")).toBeGreaterThan(
        afterScrollback.indexOf(expectedMarkers.at(-1)!),
      );
      const replayPlan = commandTrace.split(/\r?\n/).find((line) =>
        line.includes("transcript_transition_plan") &&
        line.includes("footer_reservation_changed=true") &&
        line.includes("replay_displaced_footer_history=true")
      );
      expect(replayPlan).toMatch(
        /semantic_rows=([1-9]\d*) planned_rows=\1 .* geometry_rebase=true/,
      );
      const replayRows = replayPlan!.match(/planned_rows=([1-9]\d*)/)![1];
      expect(commandTrace).toContain(`terminal_movement planned_rows=${replayRows}`);
      const dismissalPlan = commandTrace.split(/\r?\n/).find((line) =>
        line.includes("transcript_transition_plan") &&
        line.includes("footer_reservation_changed=true") &&
        line.includes("replay_displaced_footer_history=false")
      );
      expect(dismissalPlan).toContain("semantic_rows=0 planned_rows=0");
      expect(dismissalPlan).toContain("geometry_rebase=true");
      expect(commandTrace).toContain("transcript_projection_history_floor");
      expect(JSON.parse(readFileSync(join(root.home, ".fiber", "settings.json"), "utf8")).permission_mode)
        .toBe("ask");
      expect(codex.requests).toHaveLength(1);
      expect(activeSession.isAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    60_000,
  );

  test.skipIf(!tmuxAvailable())(
    "interactive child approval uses the normal parent prompt",
    async () => {
      const root = createIsolatedRoot();
      const stderrPath = join(root.root, "interactive-child-approval-stderr.log");
      const markerPath = join(root.workspace, "child-approval-must-not-exist");
      const rootPrompt = "DELEGATE_ONE_APPROVAL_TASK";
      const childPrompt = "Request permission to create the delegated marker.";
      const createId = "direct_child_create";
      const commandId = "direct_child_command";
      writeFileSync(stderrPath, "");

      const codex = startFakeCodex({
        route: (body: string) => {
          const outputs = codexInputItems(body).filter(
            (item) => item.type === "function_call_output",
          );
          if (outputs.some((item) => item.call_id === commandId)) {
            return finalText("CHILD_PERMISSION_DENIED");
          }
          if (outputs.some((item) => item.call_id === createId)) {
            const created = JSON.parse(toolResultText(body, createId)) as {
              ok: boolean;
              result?: string;
            };
            expect(created.ok).toBe(true);
            expect(created.result).toContain("CHILD_PERMISSION_DENIED");
            expect(toolResultText(body, createId)).not.toContain("child_id");
            return finalText("PARENT_OBSERVED_CHILD_DENIAL");
          }
          if (currentUserText(body).includes(childPrompt)) {
            expect(body).not.toContain('"name":"subagent"');
            return toolCall(`/usr/bin/touch ${shellQuote(markerPath)}`, {}, commandId);
          }
          if (currentUserText(body).includes(rootPrompt)) {
            return codexToolCall(createId, "subagent", {
              action: "run",
              task: childPrompt,
            });
          }
          throw new Error(`Unexpected direct child approval request: ${body}`);
        },
      });
      codexes.push(codex);

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText(rootPrompt);
      const approvalPane = await activeSession.waitForText(
        COMMAND_APPROVAL_PROMPT,
        TIMEOUT,
      );
      expect(approvalPane).toContain("touch");
      expect(existsSync(markerPath)).toBe(false);
      await activeSession.sendKeys("3");
      await activeSession.waitForText("PARENT_OBSERVED_CHILD_DENIAL", TIMEOUT);
      expect(existsSync(markerPath)).toBe(false);
      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd(5_000)).toBe(true);
      activeSession = null;
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    60_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI slash permission mode survives resume and gates a fresh effectful command",
    async () => {
      const harness = await launchPermissionResumeHarness([
        finalText("permission resume seed complete"),
      ]);

      await harness.initialSession.waitForText("auto · gpt-5.6-luna", TIMEOUT);
      await harness.initialSession.sendText("Save a turn before changing permission mode.");
      await harness.initialSession.waitForText("permission resume seed complete", TIMEOUT);
      expect(harness.initialCodex.requests).toHaveLength(1);

      await harness.initialSession.sendText("/permissions ask");
      await harness.initialSession.waitForText("mode set to ask", TIMEOUT);
      await harness.initialSession.waitForText("ask · gpt-5.6-luna", TIMEOUT);
      const initialScrollback = await harness.initialSession.captureFullScrollback();
      expect(initialScrollback).toContain("permission resume seed complete");
      expect(initialScrollback).toContain("mode set to ask");
      expect(harness.readSettings().permission_mode).toBe("ask");

      const resumed = await harness.resume([
        toolCall("touch must-not-exist"),
        finalText("permission resume denial complete"),
      ]);
      await resumed.session.waitForText("● Session resumed", TIMEOUT);
      await resumed.session.waitForText("ask · gpt-5.6-luna", TIMEOUT);
      await resumed.session.sendText("Create the marker after resuming.");

      const approvalPane = await resumed.session.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      expect(approvalPane).toContain("touch must-not-exist");
      expect(resumed.codex.requests).toHaveLength(1);
      expect(existsSync(harness.markerPath)).toBe(false);

      await resumed.session.sendKeys("3");
      await resumed.session.waitForText("permission resume denial complete", TIMEOUT);
      expect(resumed.codex.requests).toHaveLength(2);
      expect(existsSync(harness.markerPath)).toBe(false);
      expect(harness.readSettings().permission_mode).toBe("ask");
      expect(readFileSync(harness.initialStderrPath, "utf8")).toBe("");
      expect(readFileSync(harness.resumedStderrPath, "utf8")).toBe("");
      expectNoHostileExecutables(harness.root);

      const resumedScrollback = await resumed.session.captureFullScrollback();
      expect(resumedScrollback).toContain("permission resume seed complete");
      expect(resumedScrollback).toContain("● Session resumed");
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI requires approval before an effectful command can create a file",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "must-not-exist");
      const codex = startFakeGateway([
        toolCall("touch must-not-exist"),
        finalText("denial complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Create the marker.");
      const approvalPane = await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      expect(approvalPane).toContain("1. Yes");
      expect(approvalPane).toContain("2. Yes, and don't ask again");
      expect(approvalPane).toContain("3. No");
      expect(approvalPane).toContain("touch must-not-exist");
      expect(codex.requests).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);

      await activeSession.sendKeys("3");
      const finalPane = await activeSession.waitForText("denial complete", TIMEOUT);

      expect(finalPane).toContain("denial complete");
      expect(codex.requests).toHaveLength(2);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expectNoHostileExecutables(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI one-time approval executes the effectful command",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "allowed-once");
      const codex = startFakeGateway([
        toolCall("touch allowed-once"),
        finalText("one-time approval complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Create the one-time marker.");
      await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      expect(existsSync(marker)).toBe(false);

      await activeSession.sendKeys("1");
      await activeSession.sendKeys("Enter");
      await activeSession.waitForText("one-time approval complete", TIMEOUT);

      expect(existsSync(marker)).toBe(true);
      expect(codex.requests).toHaveLength(2);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expectNoHostileExecutables(root);
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI completes a large terminal exec after one-time approval",
    async () => {
      const foregroundRoot = createIsolatedRoot();
      const foregroundMarker = "large-tui-foreground-marker";
      const foregroundCommand = largeEffectfulCommand(foregroundMarker);
      const foregroundGateway = startFakeGateway([
        toolCall(foregroundCommand),
        finalText("large TUI foreground complete"),
      ]);
      const foregroundStderr = join(foregroundRoot.root, "foreground-stderr.log");
      writeFileSync(foregroundStderr, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: foregroundRoot.workspace,
        env: codexEnv(foregroundRoot, foregroundGateway, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath: foregroundStderr,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Run the large foreground fixture.");
      await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      await activeSession.sendKeys("1");
      await activeSession.sendKeys("Enter");
      await activeSession.waitForText("large TUI foreground complete", TIMEOUT);

      const foregroundScrollback = await activeSession.captureFullScrollback();
      const foregroundRawAnsi = await activeSession.captureFullScrollbackEscapes();
      expect(foregroundScrollback).toContain("large TUI foreground complete");
      expect(foregroundScrollback).not.toContain("integer does not fit in destination type");
      expect(foregroundRawAnsi).toContain("…");
      expect(existsSync(join(foregroundRoot.workspace, foregroundMarker))).toBe(true);
      expect(foregroundGateway.requests).toHaveLength(2);
      expect(readFileSync(foregroundStderr, "utf8")).toBe("");

      await activeSession.sendText("/quit");
      expect(await activeSession.waitForSessionEnd()).toBe(true);
      await activeSession.kill();
      activeSession = null;
      await expectSavedShellRun(
        foregroundRoot,
        sessionIdFromHome(foregroundRoot),
        foregroundCommand,
      );
    },
    90_000,
  );

  test.skipIf(!tmuxAvailable())(
    "TUI always approval authorizes the matching command for the session",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "allowed-always");
      const changedMarker = join(root.workspace, "allowed-always-changed");
      const codex = startFakeGateway([
        toolCall("touch allowed-always", {}, "always_command_1"),
        finalText("first always approval complete"),
        toolCall("touch allowed-always", {}, "always_command_2"),
        finalText("second always approval complete"),
        toolCall("touch allowed-always-changed", {}, "always_command_3"),
        finalText("changed command approval complete"),
      ]);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      activeSession = await TmuxSession.create({
        cmd: FIBER_BIN,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_PERMISSION_MODE: "ask",
        }),
        stderrPath,
        width: 120,
        height: 40,
      });
      await activeSession.waitForComposer(TIMEOUT);
      await activeSession.sendText("Create the reusable marker.");
      const firstApprovalPane = await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      expect(firstApprovalPane).toContain("Yes, and don't ask again for this exact command");

      await activeSession.sendKeys("2");
      await activeSession.sendKeys("Enter");
      await activeSession.waitForText("first always approval complete", TIMEOUT);
      expect(existsSync(marker)).toBe(true);

      rmSync(marker);
      await activeSession.sendText("Create the reusable marker again.");
      const finalPane = await activeSession.waitForText("second always approval complete", TIMEOUT);

      expect(finalPane).toContain("second always approval complete");
      expect(existsSync(marker)).toBe(true);

      await activeSession.sendText("Create the changed marker.");
      const changedApprovalPane = await activeSession.waitForText(COMMAND_APPROVAL_PROMPT, TIMEOUT);
      expect(changedApprovalPane).toContain("touch allowed-always-changed");
      expect(existsSync(changedMarker)).toBe(false);

      await activeSession.sendKeys("1");
      await activeSession.sendKeys("Enter");
      await activeSession.waitForText("changed command approval complete", TIMEOUT);

      expect(existsSync(changedMarker)).toBe(true);
      expect(codex.requests).toHaveLength(6);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expectNoHostileExecutables(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask yolo executes pwd through the default user profile with process-scoped replay",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([toolCall("pwd"), finalText("ask direct complete")]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--permission-mode", "yolo", "--quiet", "--json", "--no-save", "Run pwd once."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            PATH: hostilePath(root),
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Running pwd");
      expect(result.stderr.toLowerCase()).not.toContain("error");
      expect(JSON.parse(toolResultText(codex.requests[1].body, "command_1"))).toMatchObject({
        state: "completed",
        output_delta: `${root.workspace}\n`,
        exit_code: 0,
      });
      const json = parseFxJson(result);
      expect(json.tool_calls).toHaveLength(1);
      expect(json.tool_calls[0].name).toBe("shell");
      expect(json.tool_calls[0].status).toBe("success");
      expect(json.tool_calls[0].command_result.command).toBe("pwd");
      expect(json.tool_calls[0].command_result.cwd).toBe(root.workspace);
      expect(json.tool_calls[0].command_result.output_file).toMatch(
        /^fiber-command-replay-[a-f0-9-]+\.bin$/,
      );
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask defaults missing permission mode to auto through the classifier",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-accepted.txt");
      const command = `printf 'classifier\\n' >> ${JSON.stringify(marker)}`;
      const codex = startFakeGateway([
        toolCall(command),
        finalText("classifier accept complete"),
      ]);
      const tracePath = join(root.root, "trace.log");

      const result = await runFx(
        ["ask", "--quiet", "--json", "--no-save", "Run the classifier fixture."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("Auto agent approved this request");
      expect(result.stderr).not.toContain("permission required");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("classifier\n");
      const json = parseFxJson(result);
      expect(json.output).toContain("classifier accept complete");
      expect(json.tool_calls).toContainEqual(
        expect.objectContaining({ name: "shell", status: "success" }),
      );
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(1);
      // Gateway-era review wire assertions (headers, toolChoice, token caps,
      // classifier system prompt) have no Codex Responses equivalent; the
      // retained review payload keeps the contextual review context.
      expect(codex.reviewRequests[0]!.body).toContain(
        "review_context_kind: contextual",
      );
      expect(codex.reviewRequests[0]!.body).toContain(
        "Run the classifier fixture.",
      );
      expect(codex.reviewRequests[0]!.body).toContain("action: command");
      expect(codex.reviewRequests[0]!.body).toContain("command: printf");
      expect(readFileSync(tracePath, "utf8")).toContain("approval_source=auto_classifier");
    },
    TIMEOUT,
  );

  test(
    "fiber ask does not retry a malformed classifier completion and safely replans",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-malformed-must-not-run.txt");
      const command = `printf 'unsafe\\n' >> ${JSON.stringify(marker)}`;
      const codex = startFakeGateway(
        [
          toolCall(command),
          (body) => {
            expect(body).toContain("review_unavailable");
            return toolCall("pwd", "safe_after_malformed");
          },
          finalText("classifier recovery complete"),
        ],
        [finalText("accept")],
      );
      const tracePath = join(root.root, "trace.log");

      const result = await runFx(
        ["ask", "--quiet", "--json", "--no-save", "Run the classifier recovery fixture."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(codex.requests).toHaveLength(3);
      expect(codex.reviewRequests).toHaveLength(1);
      const trace = readFileSync(tracePath, "utf8");
      expect(trace.match(/event=auto_review_start/g)).toHaveLength(1);
      expect(trace.match(/event=auto_review_result/g)).toHaveLength(1);
      expect(trace).toContain("decision=unavailable");
      expect(trace).toContain("fallback_reason=invalid_or_unavailable");
      expect(result.stderr).not.toContain("Auto agent approved this request:");
    },
    TIMEOUT,
  );

  test(
    "fiber ask returns one malformed classifier completion to the agent without execution",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-fallback-must-not-exist.txt");
      const command = `printf fallback > ${JSON.stringify(marker)}`;
      const codex = startFakeGateway(
        [
          toolCall(command),
          (body) => {
            expect(body).toContain("review_unavailable");
            return finalText("classifier fallback handled");
          },
        ],
        [finalText("accept")],
      );
      const tracePath = join(root.root, "trace.log");

      const result = await runFx(
        ["ask", "--quiet", "--json", "--no-save", "Run the classifier fallback fixture."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("classifier fallback handled");
      expect(existsSync(marker)).toBe(false);
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(1);
      const trace = readFileSync(tracePath, "utf8");
      expect(trace.match(/event=auto_review_start/g)).toHaveLength(1);
      expect(trace.match(/event=auto_review_result/g)).toHaveLength(1);
      expect(trace).toContain("decision=unavailable");
      expect(trace).toContain("fallback_reason=invalid_or_unavailable");
      expect(result.stderr).not.toContain(COMMAND_APPROVAL_PROMPT);
    },
    TIMEOUT,
  );

  test(
    "fiber ask SIGINT during classifier wait terminates before decision or execution",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "classifier-cancel-must-not-exist.txt");
      const command = `printf cancelled > ${JSON.stringify(marker)}`;
      let releaseClassifier!: (response: string) => void;
      const heldClassifier = new Promise<string>((resolve) => {
        releaseClassifier = resolve;
      });
      const codex = startFakeGateway(
        [toolCall(command)],
        [() => heldClassifier],
      );
      const tracePath = join(root.root, "trace.log");
      const child = nodeSpawn(
        FIBER_BIN,
        ["ask", "--quiet", "--json", "--no-save", "Run the classifier cancellation fixture."],
        {
          cwd: root.workspace,
          env: definedEnv(codexEnv(root, codex, {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission,stream",
          })),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.end();

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
      );
      try {
        const requestDeadline = Date.now() + TIMEOUT;
        while (codex.reviewRequests.length === 0 && Date.now() < requestDeadline) {
          await Bun.sleep(10);
        }
        expect(codex.reviewRequests).toHaveLength(1);

        expect(child.kill("SIGINT")).toBe(true);
        const result = await Promise.race([
          closed,
          Bun.sleep(2_000).then(() => {
            throw new Error("fiber did not exit on SIGINT while the classifier remained blocked");
          }),
        ]);
        expect(result).toEqual({ code: null, signal: "SIGINT" });

        expect(Buffer.concat(stdoutChunks).toString()).toBe("");
        const stderr = Buffer.concat(stderrChunks).toString();
        expect(stderr).toContain("Running printf cancelled >");
        expect(stderr).not.toContain("Auto agent couldn’t approve because");
        expect(stderr).not.toContain("permission required");
        expect(existsSync(marker)).toBe(false);
        expect(codex.requests).toHaveLength(1);
        expect(codex.reviewRequests).toHaveLength(1);
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).not.toContain("decision=clear");
        expect(trace).toContain("decision=cancelled_or_error");
        expect(trace).not.toContain("event=after_permission_decision");
        expect(trace).not.toContain("event=permission_decision");
        expect(trace).not.toContain("event=execution_start");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await Promise.race([closed, Bun.sleep(1_000)]);
        }
        releaseClassifier(reviewDecision("clear", "permission_decision_1"));
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask automatic review receives the exact delegated command",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "delegated-agent-ran.txt");
      const prompt = "Create the requested Desktop note.";
      const claudePath = join(root.hostileBin, "claude");
      writeFileSync(
        claudePath,
        `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(marker)}\nprintf 'delegated claude complete\\n'\n`,
      );
      chmodSync(claudePath, 0o755);
      const command = `claude -p ${JSON.stringify(prompt)}`;
      const codex = startFakeGateway([
        toolCall(command),
        finalText("delegated classifier complete"),
      ]);
      const tracePath = join(root.root, "trace.log");

      const result = await runFx(
        ["ask", "--quiet", "--json", "--no-save", "Ask Claude to create the requested Desktop note."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            PATH: hostilePath(root),
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "permission",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("permission required");
      expect(readFileSync(marker, "utf8")).toContain(`-p ${prompt}`);
      const json = parseFxJson(result);
      expect(json.output).toContain("delegated classifier complete");
      expect(json.tool_calls).toContainEqual(
        expect.objectContaining({ name: "shell", status: "success" }),
      );
      expect(codex.requests).toHaveLength(2);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(codex.reviewRequests[0]!.body).toContain(
        "review_context_kind: contextual",
      );
      expect(codex.reviewRequests[0]!.body).toContain(
        "Ask Claude to create the requested Desktop note.",
      );
      expect(codex.reviewRequests[0]!.body).toContain("action: command");
      expect(codex.reviewRequests[0]!.body).toContain(
        "command: claude -p \\\"Create the requested Desktop note.\\\"",
      );
      expect(readFileSync(tracePath, "utf8")).toContain("approval_source=auto_classifier");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "fiber ask terminal automatic caution returns advice without prompting",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "fiber-ask-prompt-approved.txt");
      const command = `printf approved > ${JSON.stringify(marker)}`;
      const codex = startFakeGateway(
        [
          toolCall(command),
          finalText("fiber ask prompt complete"),
        ],
        [reviewDecision("caution", "permission_decision_1")],
      );
      const tracePath = join(root.root, "trace.log");

      activeSession = await TmuxSession.create({
        cmd: `${shellQuote(FIBER_BIN)} ask --permission-mode auto --no-save ${shellQuote("Run the one-shot prompt fixture.")}`,
        cwd: root.workspace,
        env: codexEnv(root, codex, {
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "permission",
          TMPDIR: root.root,
        }),
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      const finalPane = await activeSession.waitForText("fiber ask prompt complete", TIMEOUT);
      expect(finalPane).not.toContain("Approve? [y/N]");
      expect(finalPane).not.toContain("Auto agent denied");
      expect(existsSync(marker)).toBe(false);
      expect(codex.reviewRequests).toHaveLength(1);
      expect(readFileSync(tracePath, "utf8")).toContain("event=auto_review_result");
      expect(readFileSync(tracePath, "utf8")).toContain("decision=caution");
      expect(existsSync(marker)).toBe(false);
      expect(codex.requests).toHaveLength(2);
      expect(codex.requests[1]!.body).toContain("review_caution");
      expect(codex.requests[1]!.body).not.toContain("user_denied");
      expect(readFileSync(tracePath, "utf8")).not.toContain("approval_source=interactive_once");

      await activeSession.kill();
      activeSession = null;
    },
    TIMEOUT,
  );

  test(
    "fiber ask sends large automatic review packets before execution",
    async () => {
      const cliRoot = createIsolatedRoot();
      const cliMarker = "large-cli-marker";
      const cliCommand = largeEffectfulCommand(cliMarker);
      const cliGateway = startFakeGateway([
        toolCall(cliCommand),
        finalText("large CLI complete"),
      ]);
      const cliResult = await runFx(
        ["ask", "--permission-mode", "auto", "--quiet", "--json", "Run the large CLI fixture."],
        {
          cwd: cliRoot.workspace,
          env: codexEnv(cliRoot, cliGateway),
          timeoutMs: TIMEOUT,
        },
      );

      expect(cliResult.code).toBe(0);
      expect(cliResult.stderr).not.toContain("permission required");
      expect(cliResult.stderr).not.toContain("integer does not fit in destination type");
      const cliJson = parseFxJson(cliResult);
      expect(cliJson.output).toContain("large CLI complete");
      expect(cliJson.tool_calls).toHaveLength(1);
      expect(cliJson.tool_calls).toContainEqual(
        expect.objectContaining({ name: "shell", status: "success" }),
      );
      expect(existsSync(join(cliRoot.workspace, cliMarker))).toBe(true);
      expect(cliGateway.requests).toHaveLength(2);
      expect(cliGateway.reviewRequests).toHaveLength(1);
      expect(
        Buffer.byteLength(cliGateway.reviewRequests[0]!.body),
      ).toBeGreaterThan(16 * 1024);
      await expectSavedShellRun(
        cliRoot,
        cliJson.session_id,
        cliCommand,
        "success",
      );
    },
    90_000,
  );

  test(
    "fiber ask projects hostile ls filenames through the default user profile",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([toolCall("ls"), finalText("ask ls complete")]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--permission-mode", "yolo", "--quiet", "--json", "--no-save", "List this directory."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(codex.requests).toHaveLength(2);
      const encoded = toolResultText(codex.requests[1].body, "command_1");
      expect(encoded).toContain("\\u001bname");
      expect(encoded).toContain("line\\nname");
      expect(encoded).not.toContain("\x1b");
      expect(encoded).not.toContain("\\x1b");
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask preserves quoted shell metacharacters through the user profile",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([
        toolCall("printf '%s' '<'"),
        finalText("quoted direct complete"),
      ]);
      const tracePath = join(root.root, "trace.log");
      const result = await runFx(
        ["ask", "--permission-mode", "yolo", "--quiet", "--json", "--no-save", "Print a literal less-than sign."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            PATH: hostilePath(root),
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "core",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Running printf '%s' '<'");
      expect(codex.requests).toHaveLength(2);
      expect(JSON.parse(toolResultText(codex.requests[1].body, "command_1"))).toMatchObject({
        state: "completed",
        output_delta: "<",
        exit_code: 0,
      });
      expectUserProfileTrace(tracePath);
      expect(existsSync(root.profileMarker)).toBe(true);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask keeps parser hardening cases approval-bearing",
    async () => {
      const commands = [
        "wc -c < input.txt",
        "printf x\r|wc -c",
        "printf x | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c | wc -c",
      ];

      for (const command of commands) {
        const root = createIsolatedRoot();
        writeFileSync(join(root.workspace, "input.txt"), "bounded");
        const codex = startFakeGateway([toolCall(command)]);
        const result = await runFx(
          ["ask", "--json", "--no-save", "Run the requested inspection."],
          {
            cwd: root.workspace,
            env: codexEnv(root, codex, {
              PATH: hostilePath(root),
              FIBER_PERMISSION_MODE: "ask",
            }),
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("permission required");
        expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
        expect(codex.requests).toHaveLength(1);
        expect(existsSync(root.profileMarker)).toBe(false);
        expectNoHostileExecutables(root);
        expectNoCommandArtifacts(root);
      }
    },
    TIMEOUT,
  );

  test(
    "fiber ask blocks approval-bearing commands before side effects",
    async () => {
      const root = createIsolatedRoot();
      const marker = join(root.workspace, "must-not-exist");
      const codex = startFakeGateway([toolCall("touch must-not-exist")]);
      const result = await runFx(
        ["ask", "--json", "--no-save", "Create the marker."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            PATH: hostilePath(root),
            FIBER_PERMISSION_MODE: "ask",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(result.stderr).toContain("permission required");
      expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
    },
    TIMEOUT,
  );

  test(
    "fiber ask blocks hostile git before any executable or repository access",
    async () => {
      const root = createIsolatedRoot();
      const codex = startFakeGateway([
        toolCall("git status"),
        finalText("git inspection complete"),
      ]);
      const result = await runFx(
        ["ask", "--json", "--no-save", "Inspect repository status."],
        {
          cwd: root.workspace,
          env: codexEnv(root, codex, {
            PATH: hostilePath(root),
            FIBER_PERMISSION_MODE: "ask",
          }),
          timeoutMs: TIMEOUT,
        },
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("permission required");
      expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
      expect(existsSync(root.profileMarker)).toBe(false);
      expectNoHostileExecutables(root);
      expectNoCommandArtifacts(root);
    },
    TIMEOUT,
  );
});
