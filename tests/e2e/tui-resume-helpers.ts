import { expect } from "bun:test";
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

export const TIMEOUT = 30_000;
export const UPGRADE_TIMEOUT = TIMEOUT * 2;
export const SESSION_PICKER_META_RE = /\bturns?\b/;
export const SELECTED_COMPLETION_SGR = "\x1b[1m\x1b[38;5;255m";
// Under NO_COLOR the shell strips colour runs but keeps styles, so the
// selected row carries bold alone instead of bold+white.
export const SELECTED_COMPLETION_BOLD_SGR = "\x1b[1m";

export function fakeShellRun(
  callId: string,
  command: string,
  options: Record<string, unknown> = {},
): string {
  return codexToolCall(callId, "shell", {
    request: {
      action: "run",
      command,
      yield_time_ms: 30_000,
      timeout_ms: 600_000,
      ...options,
    },
  });
}

export function sessionIdFromHome(home: string): string {
  const sessions = join(home, ".fiber", "sessions");
  const ids = readdirSync(sessions, { withFileTypes: true })
    .filter((entry) => entry.name !== "latest" && entry.isDirectory())
    .map((entry) => entry.name);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseReplayData(stdout: string): Record<string, number> {
  return JSON.parse(stdout).data as Record<string, number>;
}

export function startUpgradeServer(
  root: string,
  argvLogPath: string,
): { baseUrl: string; stop: () => void } {
  const artifactDir = join(root, "release-artifact");
  const wrapperPath = join(artifactDir, "fiber");
  const archivePath = join(root, "fiber.tar.gz");
  mkdirSync(artifactDir);
  const script = `#!/bin/sh
{
  printf '%s' "$0"
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
} >> ${shellQuote(argvLogPath)}
exec ${shellQuote(FIBER_BIN)} "$@"
`;
  writeFileSync(wrapperPath, script);
  chmodSync(wrapperPath, 0o755);
  const tar = Bun.spawnSync(["tar", "-czf", archivePath, "-C", artifactDir, "fiber"]);
  if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());

  const archive = readFileSync(archivePath);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const platform = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const archiveRoute = `/v9.9.9/fiber-${platform}.tar.gz`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/latest.txt") return new Response("v9.9.9\n");
      if (path === archiveRoute) return new Response(archive);
      if (path === `${archiveRoute}.sha256`) return new Response(`${checksum}\n`);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

export type CodexQueueResponse =
  | string
  | Response
  | ((body: string) => string | Response | Promise<string | Response>);

export type CodexQueueRequest = { body: string; headers: Headers };

// File-local fake-Codex server. startFakeCodex only serves whole SSE strings,
// but this suite paces delivery with held streams, so the route also passes
// Response streams through. Protocol endpoints mirror startFakeCodex.
export function serveCodexQueue(
  next: (body: string) => string | Response | Promise<string | Response>,
  options: { models?: Array<{ id: string }> } = {},
) {
  const accountId = "acct_e2e";
  const refreshedAccessToken = chatGptAccessToken(accountId, "fresh");
  const requests: CodexQueueRequest[] = [];
  const classifierRequests: CodexQueueRequest[] = [];
  const modelRequests: Array<{ path: string; authorization: string | null; url: string }> = [];
  const tokenRequests: Array<{ path: string; authorization: string | null; body: string }> = [];
  const extraModels = (options.models ?? []).map((model) => model.id);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") {
        modelRequests.push({
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          url: req.url,
        });
        return Response.json(fakeCodexModelsPayload(extraModels));
      }
      if (url.pathname === "/token") {
        tokenRequests.push({
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          body: await req.text(),
        });
        return Response.json({
          access_token: refreshedAccessToken,
          refresh_token: "chatgpt-refresh-next",
          expires_in: 3600,
        });
      }
      const body = await req.text();
      const headers = new Headers(req.headers);
      if (body.includes("<permission_review>")) {
        classifierRequests.push({ body, headers });
        return new Response(
          codexToolCall(
            `review_decision_${classifierRequests.length}`,
            "permission_decision",
            { risk: "low", decision: "clear", rationale: "test fixture" },
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      requests.push({ body, headers });
      const resolved = await next(body);
      if (typeof resolved === "string") {
        return new Response(resolved, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return resolved;
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    requests,
    classifierRequests,
    modelRequests,
    tokenRequests,
    responsesUrl: `${base}/responses`,
    modelsUrl: `${base}/models`,
    tokenUrl: `${base}/token`,
    stop() {
      server.stop(true);
    },
  };
}

export function startCodexQueue(
  responses: CodexQueueResponse[],
  options: { models?: Array<{ id: string }> } = {},
) {
  return serveCodexQueue(async (body) => {
    const queued = responses.shift();
    if (queued === undefined) return new Response("unexpected request", { status: 500 });
    return typeof queued === "function" ? await queued(body) : queued;
  }, options);
}

export type CodexStreamCtx = { indexByCallId: Map<string, number>; nextIndex: number };

export function createCodexStreamCtx(): CodexStreamCtx {
  return { indexByCallId: new Map(), nextIndex: 0 };
}

export function codexIndexForCall(ctx: CodexStreamCtx, id: string): number {
  const existing = ctx.indexByCallId.get(id);
  if (existing !== undefined) return existing;
  const index = ctx.nextIndex;
  ctx.nextIndex += 1;
  ctx.indexByCallId.set(id, index);
  return index;
}

// Translate legacy event fixtures to Codex Responses SSE while preserving
// event order and pacing.
export function codexEventLines(event: Record<string, unknown>, ctx: CodexStreamCtx): string[] {
  const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  switch (event.type) {
    case "text-delta":
      return [data({ type: "response.output_text.delta", delta: event.delta })];
    case "text-start":
    case "text-end":
    case "reasoning-end":
    case "tool-input-end":
      return [];
    case "reasoning-start":
      return [data({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } })];
    case "reasoning-delta":
      return [data({ type: "response.reasoning_summary_text.delta", delta: event.delta })];
    case "tool-input-start": {
      const index = codexIndexForCall(ctx, event.id as string);
      return [data({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "function_call", call_id: event.id, name: event.toolName },
      })];
    }
    case "tool-input-delta": {
      const index = codexIndexForCall(ctx, event.id as string);
      return [data({ type: "response.function_call_arguments.delta", output_index: index, delta: event.delta })];
    }
    case "tool-call": {
      const id = event.toolCallId as string;
      const lines: string[] = [];
      if (!ctx.indexByCallId.has(id)) {
        const index = codexIndexForCall(ctx, id);
        lines.push(data({
          type: "response.output_item.added",
          output_index: index,
          item: { type: "function_call", call_id: id, name: event.toolName },
        }));
      }
      const index = ctx.indexByCallId.get(id)!;
      lines.push(data({
        type: "response.function_call_arguments.done",
        output_index: index,
        arguments: typeof event.input === "string" ? event.input : JSON.stringify(event.input),
      }));
      return lines;
    }
    case "finish": {
      const usage = (event.usage ?? {}) as { inputTokens?: { total?: number }; outputTokens?: { total?: number } };
      return [data({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: usage.inputTokens?.total ?? 4, output_tokens: usage.outputTokens?.total ?? 2 },
        },
      })];
    }
    case "error":
      return [data({ type: "response.failed", response: { status: "failed", error: event.error } })];
    default:
      return [];
  }
}

export function codexSse(events: Record<string, unknown>[]): string {
  const ctx = createCodexStreamCtx();
  return events.flatMap((event) => codexEventLines(event, ctx)).join("");
}

// Viewport polls are cheap (visible rows only); full-scrollback dumps on a
// large history buffer cost seconds each, so marker waits poll the viewport
// and reserve full scrollback for the final assertion (#127).
export const VIEWPORT_POLL_MS = 250;

export async function waitForScrollback(
  session: TmuxSession,
  marker: string,
  timeout = TIMEOUT,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let lastPane = "";
  while (Date.now() < deadline) {
    lastPane = await session.capturePane();
    if (lastPane.includes(marker)) {
      // A live full-scrollback capture can tear against the viewport, so
      // only return it when it actually contains the marker; otherwise
      // keep polling (#127).
      const scrollback = await session.captureFullScrollback();
      if (scrollback.includes(marker)) return scrollback;
    }
    await Bun.sleep(VIEWPORT_POLL_MS);
  }
  // The marker may have scrolled out of the viewport: one full-scrollback
  // check before failing so a scrolled-past marker still passes.
  const scrollback = await session.captureFullScrollback();
  if (scrollback.includes(marker)) return scrollback;
  throw new Error(
    `Timed out waiting for scrollback to contain ${marker}.\nLast pane:\n${lastPane}\nScrollback:\n${scrollback}`,
  );
}

export async function waitForScrollbackMarkers(
  session: TmuxSession,
  markers: readonly string[],
  timeout = TIMEOUT,
): Promise<string> {
  // Latch per-marker sightings across polls: markers that arrive pages
  // apart never coexist in one viewport, so a marker seen once counts.
  const seen = new Set<string>();
  const deadline = Date.now() + timeout;
  let lastPane = "";
  while (Date.now() < deadline) {
    lastPane = await session.capturePane();
    for (const marker of markers) if (lastPane.includes(marker)) seen.add(marker);
    if (markers.every((marker) => seen.has(marker))) {
      const scrollback = await session.captureFullScrollback();
      if (markers.every((marker) => scrollback.includes(marker))) return scrollback;
      // Torn capture: keep polling. Sightings stay latched.
    }
    await Bun.sleep(VIEWPORT_POLL_MS);
  }
  const scrollback = await session.captureFullScrollback();
  for (const marker of markers) if (scrollback.includes(marker)) seen.add(marker);
  if (markers.every((marker) => scrollback.includes(marker))) return scrollback;
  const missing = markers.filter((marker) => !seen.has(marker));
  throw new Error(
    `Timed out waiting for scrollback markers ${markers.join(", ")}. Never seen: ${missing.join(", ")}.\nLast pane:\n${lastPane}\nScrollback:\n${scrollback}`,
  );
}

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export async function waitForScrollbackOccurrences(
  session: TmuxSession,
  marker: string,
  expectedCount: number,
  timeout = TIMEOUT,
): Promise<string> {
  // Latch the best sighting across polls: panes are transient, so the
  // highest occurrence count observed in any single poll counts.
  let bestCount = 0;
  let everSeen = false;
  const deadline = Date.now() + timeout;
  let lastPane = "";
  while (Date.now() < deadline) {
    lastPane = await session.capturePane();
    const count = countOccurrences(lastPane, marker);
    if (count > 0) everSeen = true;
    if (count > bestCount) bestCount = count;
    if (bestCount >= expectedCount) {
      const scrollback = await session.captureFullScrollback();
      if (countOccurrences(scrollback, marker) >= expectedCount) return scrollback;
      // Torn capture: keep polling. The sighting stays latched.
    }
    await Bun.sleep(VIEWPORT_POLL_MS);
  }
  const scrollback = await session.captureFullScrollback();
  const finalCount = countOccurrences(scrollback, marker);
  if (finalCount > 0) everSeen = true;
  if (finalCount > bestCount) bestCount = finalCount;
  if (finalCount >= expectedCount) return scrollback;
  const neverSeen = everSeen ? "" : ` Marker ${marker} was never seen in any poll.`;
  throw new Error(
    `Timed out waiting for ${expectedCount} occurrences of ${marker}. Best sighting: ${bestCount}.${neverSeen}\nLast pane:\n${lastPane}\nScrollback:\n${scrollback}`,
  );
}

export async function waitForQuiescentReplay(
  replayPath: string,
  timeout = TIMEOUT,
  minBytes = 1024 * 1024,
): Promise<Buffer> {
  // #89: a replay .bin can pass the size assert while the tail is still
  // flushing on a slow runner. Stability counts only after the artifact
  // crosses its known minimum size, so an empty (or truncated) file is
  // never quiescent. The producer exposes no explicit flush fence, so
  // size-stability above the minimum is the gate.
  const deadline = Date.now() + timeout;
  let previousSize = -1;
  let stablePolls = 0;
  let lastSize = 0;
  while (Date.now() < deadline) {
    lastSize = statSync(replayPath).size;
    if (lastSize >= minBytes && lastSize === previousSize) {
      stablePolls += 1;
      if (stablePolls >= 3) return readFileSync(replayPath);
    } else {
      previousSize = lastSize;
      stablePolls = 0;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for replay artifact quiescence at ${replayPath}. Last size: ${lastSize} (minimum ${minBytes}).`,
  );
}

export type HoldState = {
  started: boolean;
  cancelled: boolean;
};

export function heldCodexResponse(state: HoldState): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.started = true;
        const initial = codexFinalText("SESSION_PICKER_ACTIVE_STREAM").split("\n\n")[0]! + "\n\n";
        controller.enqueue(encoder.encode(initial));
        timer = setInterval(() => {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 100);
      },
      cancel() {
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function streamedTextResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let offset = 0; offset < text.length; offset += 24) {
          controller.enqueue(encoder.encode(codexEventLines({
            type: "text-delta",
            delta: text.slice(offset, offset + 24),
          }, createCodexStreamCtx())[0]!));
          await Bun.sleep(10);
        }
        const completion = codexFinalText("").split("\n\n")[1]! + "\n\n";
        controller.enqueue(encoder.encode(completion));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export type WaitForConditionEvidence = {
  session?: TmuxSession;
  tracePath?: string;
};

export function readTraceTail(tracePath: string, maxBytes = 4_000): string {
  try {
    const text = readFileSync(tracePath, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return `(no trace at ${tracePath})`;
  }
}

export async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeout = TIMEOUT,
  evidence: WaitForConditionEvidence = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  const parts = [`Timed out waiting for ${description}.`];
  if (evidence.session) {
    try {
      parts.push(`Last scrollback:\n${await evidence.session.captureFullScrollback()}`);
    } catch (error) {
      parts.push(`Scrollback unavailable: ${String(error)}`);
    }
  }
  if (evidence.tracePath) {
    parts.push(`Trace tail:\n${readTraceTail(evidence.tracePath)}`);
  }
  throw new Error(parts.join("\n"));
}

export async function waitForPersistedSessionMarker(
  home: string,
  marker: string,
  timeout = TIMEOUT,
): Promise<void> {
  const sessionsDir = join(home, ".fiber", "sessions");
  await waitForCondition(() => {
    if (!existsSync(sessionsDir)) return false;
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.name !== "latest" && entry.isDirectory())
      .some((entry) => {
        const eventsPath = join(sessionsDir, entry.name, "events.jsonl");
        return existsSync(eventsPath) &&
          readFileSync(eventsPath, "utf8").includes(marker);
      });
  }, `persisted session marker ${marker}`, timeout);
}

export async function waitForCommittedSessionMarker(
  home: string,
  marker: string,
  timeout = TIMEOUT,
): Promise<void> {
  const sessionsDir = join(home, ".fiber", "sessions");
  await waitForCondition(() => {
    if (!existsSync(sessionsDir)) return false;
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.name !== "latest" && entry.isDirectory())
      .some((entry) => {
        const sessionDir = join(sessionsDir, entry.name);
        const eventsPath = join(sessionDir, "events.jsonl");
        if (!existsSync(eventsPath) || !readFileSync(eventsPath, "utf8").includes(marker)) {
          return false;
        }
        const watermarkName = readdirSync(sessionDir).find(
          (name) => name.startsWith("commit.") && name.endsWith(".json"),
        );
        if (!watermarkName) return false;
        try {
          const watermark = JSON.parse(
            readFileSync(join(sessionDir, watermarkName), "utf8"),
          ) as { through_event_log_bytes?: number };
          return watermark.through_event_log_bytes === statSync(eventsPath).size;
        } catch {
          return false;
        }
      });
  }, `committed session marker ${marker}`, timeout);
}

export async function waitForSessionPicker(session: TmuxSession): Promise<string> {
  return session.waitForPane(
    (pane) => {
      const plain = stripAnsi(pane);
      return plain.includes("Sessions") &&
        (plain.includes("[Current workspace]") || plain.includes("[All workspaces]"));
    },
    TIMEOUT,
  );
}

export async function waitForSessionPickerClosed(session: TmuxSession): Promise<string> {
  return session.waitForPane(
    (pane) => {
      const plain = stripAnsi(pane);
      return hasEmptyComposer(plain) &&
        !plain.includes("Sessions");
    },
    TIMEOUT,
  );
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export type SessionPickerEntry = {
  row: number;
  title: string;
  meta: string;
  selected: boolean;
};

export function visibleSessionPickerEntries(escapes: string): SessionPickerEntry[] {
  const rawLines = escapes.split("\n");
  const lines = rawLines.map(stripAnsi);
  const entries: SessionPickerEntry[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const title = lines[index]!;
    const meta = title;
    if (!SESSION_PICKER_META_RE.test(meta) || !meta.includes(" · ")) continue;
    const trimmedTitle = title.trimStart();
    if (
      trimmedTitle.length === 0 ||
      trimmedTitle.startsWith("Sessions") ||
      trimmedTitle.startsWith("Tab ")
    ) {
      continue;
    }
    entries.push({
      row: index,
      title,
      meta,
      selected: rawLines[index]!.includes(SELECTED_COMPLETION_SGR) ||
        rawLines[index]!.includes(SELECTED_COMPLETION_BOLD_SGR),
    });
  }
  return entries;
}

export const TAG_FLAG_SYMBOL = "\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc65\udb40\udc6e\udb40\udc67\udb40\udc7f";

export const SEMANTIC_TABLE_ROWS = [
  { type: "ASCII", symbol: "OK", description: "Plain ASCII", cells: 2 },
  { type: "Emoji", symbol: "\u2705", description: "Passed", cells: 2 },
  { type: "Emoji", symbol: "\u274c", description: "Failed", cells: 2 },
  { type: "CJK", symbol: "\u754c", description: "Wide character", cells: 2 },
  { type: "VS15", symbol: "\u2600\ufe0e", description: "Text presentation", cells: 1 },
  { type: "Wide VS15", symbol: "\u231a\ufe0e", description: "Wide text presentation", cells: 2 },
  { type: "VS16", symbol: "\u2600\ufe0f", description: "Emoji presentation", cells: 2 },
  { type: "Modifier", symbol: "\ud83d\udc4d\ud83c\udffd", description: "Skin tone", cells: 2 },
  { type: "Flag", symbol: "\ud83c\uddfa\ud83c\uddf8", description: "Regional pair", cells: 2 },
  { type: "Keycap", symbol: "#\ufe0f\u20e3", description: "Keycap sequence", cells: 2 },
  {
    type: "Tag",
    symbol: TAG_FLAG_SYMBOL,
    description: "RGI tag flag",
    cells: 2,
  },
  { type: "ZWJ", symbol: "\ud83d\udc69\u200d\ud83d\udcbb", description: "Joined sequence", cells: 2 },
] as const;

export type SemanticObservation = "tmux" | "replay";
export type SemanticRow = (typeof SEMANTIC_TABLE_ROWS)[number];

export function isLossyLinuxTmuxSymbolRow(
  row: SemanticRow,
  observation: SemanticObservation,
  platform = process.platform,
): boolean {
  return observation === "tmux" && platform === "linux" &&
    (row.type === "Keycap" || row.type === "Tag" || row.type === "ZWJ");
}

export function hasUnstableLinuxTmuxColumns(
  row: SemanticRow,
  observation: SemanticObservation,
  platform = process.platform,
): boolean {
  return observation === "tmux" && platform === "linux" && row.type !== "ASCII";
}

export function hasSemanticSymbol(
  text: string,
  row: SemanticRow,
  observation: SemanticObservation,
  platform = process.platform,
): boolean {
  if (text.includes(row.symbol)) return true;
  if (!isLossyLinuxTmuxSymbolRow(row, observation, platform)) return false;
  if (row.type === "Keycap") return /#\ufe0f(?: +\u20e3)?/u.test(text);
  if (row.type === "Tag") return text.includes("\ud83c\udff4");
  return text.includes("\ud83d\udc69");
}

export function expectSemanticTableRows(
  text: string,
  observation: SemanticObservation,
): void {
  for (const row of SEMANTIC_TABLE_ROWS) {
    expect(text).toContain(row.type);
    expect(text).toContain(row.description);
    expect(hasSemanticSymbol(text, row, observation)).toBe(true);
  }
  expect(text).not.toContain("| Type | Symbol | Description |");
}

export function physicalBorderColumns(line: string): number[] {
  let normalized = line;
  for (const row of SEMANTIC_TABLE_ROWS) {
    normalized = normalized.replaceAll(row.symbol, " ".repeat(row.cells));
  }
  return [...normalized.matchAll(/│/g)].map((match) =>
    Bun.stringWidth(normalized.slice(0, match.index))
  );
}

export function semanticColumnsMatch(
  row: SemanticRow,
  expected: number[],
  captured: number[],
  observation: SemanticObservation,
  platform = process.platform,
): boolean {
  const exact = captured.length === expected.length &&
    captured.every((column, index) => column === expected[index]);
  if (exact) return true;
  if (!hasUnstableLinuxTmuxColumns(row, observation, platform)) return false;
  const hasEnoughBorders = isLossyLinuxTmuxSymbolRow(row, observation, platform)
    ? captured.length >= 2
    : captured.length === expected.length;
  return hasEnoughBorders && captured[0] === expected[0] &&
    captured.every((column, index) => index === 0 || column > captured[index - 1]!);
}

export function expectAlignedSemanticTable(
  scrollback: string,
  observation: SemanticObservation,
): void {
  const lines = scrollback.split("\n").map(stripAnsi);
  const header = lines.find((line) =>
    line.includes("Type") && line.includes("Symbol") && line.includes("Description")
  );
  expect(header).toBeDefined();
  const expectedColumns = physicalBorderColumns(header!);
  expect(expectedColumns).toHaveLength(4);

  for (const row of SEMANTIC_TABLE_ROWS) {
    const line = lines.find((candidate) => candidate.includes(row.description));
    expect(line).toBeDefined();
    expect(hasSemanticSymbol(line!, row, observation)).toBe(true);
    const capturedColumns = physicalBorderColumns(line!);
    expect(semanticColumnsMatch(
      row,
      expectedColumns,
      capturedColumns,
      observation,
    )).toBe(true);
  }
}

export function findPaginatedSemanticFieldLines(
  lines: string[],
  row: SemanticRow,
  observation: SemanticObservation,
): { symbolLine: string | undefined; descriptionLine: string | undefined } {
  const symbolLine = lines.find((line) =>
    line.includes("│Symbol:") && hasSemanticSymbol(line, row, observation)
  );
  const descriptionLine = lines.find((line) =>
    line.includes("│Description:") && line.includes(row.description)
  );
  return { symbolLine, descriptionLine };
}

export function expectAlignedSemanticCards(
  text: string,
  observation: SemanticObservation,
): void {
  const lines = text.split("\n").map(stripAnsi);
  let expectedColumns: number[] | undefined;

  for (const row of SEMANTIC_TABLE_ROWS) {
    const { symbolLine, descriptionLine } = findPaginatedSemanticFieldLines(
      lines,
      row,
      observation,
    );
    expect(symbolLine).toBeDefined();
    expect(descriptionLine).toBeDefined();
    expect(hasSemanticSymbol(symbolLine!, row, observation)).toBe(true);

    const symbolColumns = physicalBorderColumns(symbolLine!);
    const descriptionColumns = physicalBorderColumns(descriptionLine!);
    expect(symbolColumns).toHaveLength(2);
    expect(descriptionColumns).toHaveLength(2);
    expect(semanticColumnsMatch(
      row,
      descriptionColumns,
      symbolColumns,
      observation,
    )).toBe(true);
    if (expectedColumns) {
      expect(descriptionColumns).toEqual(expectedColumns);
    } else {
      expectedColumns = descriptionColumns;
    }
  }
}

export function normalizeVolatileStatusRows(grid: string[]): string[] {
  return grid.map((line) =>
    /^• (?:Thinking|Generating|Running)(?: \(\d+s\))?$/.test(line) ||
      /^• Streaming \([^)]*\)$/.test(line) ||
      isVolatileTokenStatusRow(line)
      ? "<status>"
      : line
  );
}
