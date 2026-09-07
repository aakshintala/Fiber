import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIBER_BIN, REPO_ROOT } from "../evals/eval-helpers";
import {
  chatGptAccessToken,
  codexFinalText,
  codexSerializedToolCall,
  codexToolCall,
  composerContains,
  fakeCodexModelsPayload,
  FAKE_CODEX_DEFAULT_MODEL,
  hasEmptyComposer,
  isEmptyComposerLine,
  seededFakeCodexEnv,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";
import { readTapeFrames, stdoutFrames } from "./render-lab/tape";

const MODEL = FAKE_CODEX_DEFAULT_MODEL;
const TURN_SUMMARY_WITH_TOKENS =
  /^ {2}(?:\d+s|\d+m \d+s|\d+h \d{2}m) \(↑\d+(?:\.\d)?k? ↓\d+(?:\.\d)?k?\)$/m;
const TIMEOUT = 30_000;
const SPLIT_BOUNDARY_WAIT_TIMEOUT = TIMEOUT * 3;
const SPLIT_BOUNDARY_TEST_TIMEOUT = SPLIT_BOUNDARY_WAIT_TIMEOUT + 5_000;
const CANONICAL_PRE_TOOL_TEXT =
  "FIBER_MODEL_TEXT_SENTINEL before tools must remain contiguous.";
const CANONICAL_FINAL_TEXT = "FIBER_FINAL_RESPONSE_SENTINEL completed.";
const CANONICAL_READ_PATH = "alpha-FIBER_PATH_SENTINEL.txt";
const CANONICAL_GREP_PATTERN = "FIBER_PATTERN_SENTINEL";
const APPROVAL_PROMPT = "Would you like to allow this action?";
const SPLIT_NEW_USER_PROMPT = "SPLIT_NEW_USER_PROMPT";
const SPLIT_OLD_SENTINELS = [
  "SPLIT_OLD_HEAD",
  ...Array.from(
    { length: 250 },
    (_, index) => `SPLIT_OLD_TAIL_${index.toString().padStart(3, "0")}`,
  ),
  "SPLIT_OLD_TAIL_FINAL",
];
const SPLIT_OLD_RESPONSE = SPLIT_OLD_SENTINELS
  .map((sentinel) => `${sentinel} ${"paced assistant text ".repeat(12)}\n`)
  .join("");
if (Buffer.byteLength(SPLIT_OLD_RESPONSE) < 30 * 1024) {
  throw new Error("split fixture must exceed 30 KiB");
}
const CANONICAL_A_B_CODEX_SSE =
  `data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: CANONICAL_PRE_TOOL_TEXT,
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "read_a", name: "read_file" },
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: '{"path":"alpha-FIBER_PATH_SENTINEL',
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", call_id: "grep_b", name: "grep_files" },
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    delta: '{"pattern":"FIBER_PATTERN_SENTINEL","path":""',
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    delta: '.txt"}',
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.done",
    output_index: 0,
    arguments: JSON.stringify({ path: CANONICAL_READ_PATH }),
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    delta: '."}',
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.function_call_arguments.done",
    output_index: 1,
    arguments: JSON.stringify({ pattern: CANONICAL_GREP_PATTERN, path: "." }),
  })}\n\n` +
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 11, output_tokens: 17 },
    },
  })}\n\n`;
const CANONICAL_A_B_SHA256 =
  "4319640fff9b45ad034d7ffa80df84b1893c21dc3053a2d5553b2654e65ad109";

type LifecycleStage =
  | "baseline-silent"
  | "fatal-reported"
  | "correlation-corrected"
  | "corrected";
type GatewayHandle = { stop(): void };

let session: TmuxSession | null = null;
let gateway: GatewayHandle | null = null;
let root: string | null = null;
let artifactRoot: string | null = null;
let preserveArtifacts = false;

afterEach(async () => {
  if (session) {
    await session.kill();
    session = null;
  }
  gateway?.stop();
  gateway = null;
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
  if (artifactRoot && !preserveArtifacts) {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
  artifactRoot = null;
  preserveArtifacts = false;
});

type CodexQueueResponse =
  | string
  | Response
  | ((body: string) => string | Response | Promise<string | Response>);

type CodexQueueRequest = { body: string; headers: Headers };

// File-local fake-Codex server. startFakeCodex only serves whole SSE strings,
// but this suite paces delivery with held streams (partial content now,
// remainder on release), so the route must also pass Response streams
// through. Protocol endpoints mirror startFakeCodex (models/token/responses).
function serveCodexQueue(
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

// The Codex route serves one callback instead of a finite queue, so the old
// response array becomes queue pops inside the callback.
function startCodexQueue(
  responses: CodexQueueResponse[],
  options: { models?: Array<{ id: string }> } = {},
) {
  return serveCodexQueue(async (body) => {
    const queued = responses.shift();
    if (queued === undefined) {
      return new Response("unexpected request", { status: 500 });
    }
    return typeof queued === "function" ? await queued(body) : queued;
  }, options);
}

type CodexStreamCtx = {
  indexByCallId: Map<string, number>;
  nextIndex: number;
};

function createCodexStreamCtx(): CodexStreamCtx {
  return { indexByCallId: new Map(), nextIndex: 0 };
}

function codexIndexForCall(ctx: CodexStreamCtx, id: string): number {
  const existing = ctx.indexByCallId.get(id);
  if (existing !== undefined) return existing;
  const index = ctx.nextIndex;
  ctx.nextIndex += 1;
  ctx.indexByCallId.set(id, index);
  return index;
}

// Maps gateway-shaped stream event objects to Codex Responses SSE lines so
// paced/held fixtures keep their delivery semantics on the Codex protocol.
// Tool calls correlate by output_index, assigned in first-seen order.
function codexEventLines(event: Record<string, unknown>, ctx: CodexStreamCtx): string[] {
  const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  switch (event.type) {
    case "text-delta":
      return [data({ type: "response.output_text.delta", delta: event.delta })];
    case "text-start":
    case "text-end":
      return [];
    case "reasoning-start":
      return [data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning" },
      })];
    case "reasoning-delta":
      return [data({
        type: "response.reasoning_summary_text.delta",
        delta: event.delta,
      })];
    case "reasoning-end":
      return [];
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
      return [data({
        type: "response.function_call_arguments.delta",
        output_index: index,
        delta: event.delta,
      })];
    }
    case "tool-input-end":
      return [];
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
      const input = typeof event.input === "string"
        ? event.input
        : JSON.stringify(event.input);
      lines.push(data({
        type: "response.function_call_arguments.done",
        output_index: index,
        arguments: input,
      }));
      return lines;
    }
    case "finish": {
      const usage = (event.usage ?? {}) as {
        inputTokens?: { total?: number };
        outputTokens?: { total?: number };
      };
      return [data({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: usage.inputTokens?.total ?? 4,
            output_tokens: usage.outputTokens?.total ?? 2,
          },
        },
      })];
    }
    case "error":
      return [data({
        type: "response.failed",
        response: { status: "failed", error: event.error },
      })];
    default:
      return [];
  }
}

function codexSse(events: Record<string, unknown>[]): string {
  const ctx = createCodexStreamCtx();
  return events.flatMap((event) => codexEventLines(event, ctx)).join("");
}

function codexContentFilterResponse(): string {
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })}\n\n`;
}

function codexFinalTextWithUsage(
  text: string,
  inputTokens: number,
  outputTokens: number,
): string {
  return `data: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: text,
  })}\n\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    })}\n\n`;
}

function codexDuplicateKeyToolResponse(): string {
  return codexSerializedToolCall(
    "queued_duplicate_list",
    "glob_files",
    '{"depth":1, "depth":2}',
  );
}

type HoldState = {
  started: boolean;
  cancelled: boolean;
  release?: () => void;
};

type TokenProgressHoldState = HoldState & {
  sendContent?: () => void;
  sendMoreContent?: () => void;
  finish?: () => void;
};

type ToolPayloadHoldState = HoldState & {
  sendMoreInput?: () => void;
  finish?: () => void;
};

function streamingOutputTokens(scrollback: string): number | null {
  const matches = [...scrollback.matchAll(
    /^• Generating \(\d+(?:h\d+m\d+s|m\d+s|s)\) \(↑\d+(?:\.\d)?k? ↓(\d+(?:\.\d)?k?)\)$/gm,
  )];
  const value = matches.at(-1)?.[1];
  if (!value) return null;
  return value.endsWith("k")
    ? Number.parseFloat(value.slice(0, -1)) * 1000
    : Number.parseFloat(value);
}

function quietToolPayloadOutputTokens(scrollback: string): number | null {
  const matches = [...scrollback.matchAll(
    /^• Running \(\d+(?:h\d+m\d+s|m\d+s|s)\) \(↑\d+(?:\.\d)?k? ↓(\d+(?:\.\d)?k?)\)$/gm,
  )];
  const value = matches.at(-1)?.[1];
  if (!value) return null;
  return value.endsWith("k")
    ? Number.parseFloat(value.slice(0, -1)) * 1000
    : Number.parseFloat(value);
}

function heldCodexResponse(
  state: HoldState,
  initialEvents: Record<string, unknown>[] = [],
  releaseEvents?: Record<string, unknown>[],
): Response {
  const encoder = new TextEncoder();
  const ctx = createCodexStreamCtx();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ) => {
    for (const line of codexEventLines(event, ctx)) {
      controller.enqueue(encoder.encode(line));
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.started = true;
        for (const event of initialEvents) {
          send(controller, event);
        }
        const keepAlive = () => {
          if (!closed) controller.enqueue(encoder.encode(": hold-active-turn\n\n"));
        };
        keepAlive();
        timer = setInterval(keepAlive, 50);
        if (releaseEvents) {
          state.release = () => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            for (const event of releaseEvents) {
              send(controller, event);
            }
            controller.close();
          };
        }
      },
      cancel() {
        closed = true;
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stagedCodexTokenProgressResponse(
  state: TokenProgressHoldState,
  reasoning: string,
  content: string,
): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let firstContentSent = false;
  let allContentSent = false;
  const split = Math.floor(content.length / 2);
  const ctx = createCodexStreamCtx();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ) => {
    for (const line of codexEventLines(event, ctx)) {
      controller.enqueue(encoder.encode(line));
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.started = true;
        send(controller, { type: "reasoning-start", id: "reasoning_1" });
        send(controller, {
          type: "reasoning-delta",
          id: "reasoning_1",
          delta: reasoning,
        });
        timer = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": hold-token-progress\n\n"));
        }, 50);
        state.sendContent = () => {
          if (closed || firstContentSent) return;
          firstContentSent = true;
          send(controller, { type: "reasoning-end", id: "reasoning_1" });
          send(controller, { type: "text-start", id: "answer_1" });
          send(controller, {
            type: "text-delta",
            id: "answer_1",
            delta: content.slice(0, split),
          });
        };
        state.sendMoreContent = () => {
          if (closed || !firstContentSent || allContentSent) return;
          allContentSent = true;
          send(controller, {
            type: "text-delta",
            id: "answer_1",
            delta: content.slice(split),
          });
        };
        state.finish = () => {
          if (closed || !allContentSent) return;
          closed = true;
          if (timer) clearInterval(timer);
          send(controller, { type: "text-end", id: "answer_1" });
          send(controller, {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 50_000 },
              outputTokens: { total: 20_000 },
            },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
      cancel() {
        closed = true;
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stagedCodexToolPayloadResponse(
  state: ToolPayloadHoldState,
  assistantText: string,
  path: string,
  content: string,
): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let moreInputSent = false;
  const input = JSON.stringify({ path, content });
  const split = Math.floor(input.length / 2);
  const ctx = createCodexStreamCtx();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ) => {
    for (const line of codexEventLines(event, ctx)) {
      controller.enqueue(encoder.encode(line));
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.started = true;
        send(controller, { type: "text-start", id: "answer_1" });
        send(controller, {
          type: "text-delta",
          id: "answer_1",
          delta: assistantText,
        });
        send(controller, { type: "text-end", id: "answer_1" });
        send(controller, {
          type: "tool-input-start",
          id: "write_payload",
          toolName: "write_file",
        });
        send(controller, {
          type: "tool-input-delta",
          id: "write_payload",
          delta: input.slice(0, split),
        });
        timer = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": hold-tool-payload\n\n"));
        }, 50);
        state.sendMoreInput = () => {
          if (closed || moreInputSent) return;
          moreInputSent = true;
          send(controller, {
            type: "tool-input-delta",
            id: "write_payload",
            delta: input.slice(split),
          });
        };
        state.finish = () => {
          if (closed || !moreInputSent) return;
          closed = true;
          if (timer) clearInterval(timer);
          send(controller, { type: "tool-input-end", id: "write_payload" });
          send(controller, {
            type: "tool-call",
            toolCallId: "write_payload",
            toolName: "write_file",
            input: { path, content },
          });
          send(controller, {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: {
              inputTokens: { total: 8 },
              outputTokens: { total: 4_096 },
            },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
      cancel() {
        closed = true;
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function codexFinalTextWithUsage(
  text: string,
  inputTokens: number,
  outputTokens: number,
): string {
  return codexSse([
    { type: "text-delta", id: "answer_1", delta: text },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: inputTokens },
        outputTokens: { total: outputTokens },
      },
    },
  ]);
}

function splitHeldCodexResponse(
  state: HoldState,
  before: string,
  after: string,
): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const ctx = createCodexStreamCtx();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
    for (const line of codexEventLines(event, ctx)) {
      controller.enqueue(encoder.encode(line));
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        state.started = true;
        send(controller, { type: "text-start", id: "answer_1" });
        send(controller, { type: "text-delta", id: "answer_1", delta: before });
        const keepAlive = () => {
          if (!closed) controller.enqueue(encoder.encode(": hold-split-turn\n\n"));
        };
        timer = setInterval(keepAlive, 50);
        state.release = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          send(controller, { type: "text-delta", id: "answer_1", delta: after });
          send(controller, { type: "text-end", id: "answer_1" });
          send(controller, {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
      cancel() {
        closed = true;
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function codexDuplicateKeyToolResponse(): string {
  return codexSse([
    { type: "tool-input-start", id: "queued_duplicate_list", toolName: "glob_files" },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: '{"' },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: "dept" },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: 'h"' },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: ":1" },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: ', "' },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: "dept" },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: 'h"' },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: ":2" },
    { type: "tool-input-delta", id: "queued_duplicate_list", delta: "}" },
    { type: "tool-input-end", id: "queued_duplicate_list" },
    {
      type: "tool-call",
      toolCallId: "queued_duplicate_list",
      toolName: "glob_files",
      input: '{"depth":1, "depth":2}',
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
    },
  ]);
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = TIMEOUT,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForCursorRow(
  session: TmuxSession,
  text: string,
  description: string,
  timeoutMs = TIMEOUT,
): Promise<{ cursor: { row: number; col: number }; grid: string[] }> {
  const started = Date.now();
  let cursor = session.cursorPosition();
  let grid: string[] = [];
  while (Date.now() - started < timeoutMs) {
    const before = session.cursorPosition();
    grid = await session.capturePaneGrid();
    cursor = session.cursorPosition();
    if (
      before.row === cursor.row &&
      before.col === cursor.col &&
      grid[cursor.row]?.includes(text)
    ) {
      return { cursor, grid };
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for ${description}; cursor=${JSON.stringify(cursor)}\n${grid.join("\n")}`,
  );
}

async function waitForEscapedScrollback(
  session: TmuxSession,
  predicate: (scrollback: string) => boolean,
  description: string,
  timeoutMs = TIMEOUT,
): Promise<string> {
  const started = Date.now();
  let lastScrollback = "";
  while (Date.now() - started < timeoutMs) {
    const scrollback = await session.captureFullScrollbackEscapes();
    if (scrollback.length > 0 || lastScrollback.length === 0) {
      lastScrollback = scrollback;
    }
    if (predicate(scrollback)) return scrollback;
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for ${description}.\nLast escaped scrollback:\n${lastScrollback}`,
  );
}

async function waitForScrollback(
  session: TmuxSession,
  predicate: (scrollback: string) => boolean,
  description: string,
  timeoutMs = TIMEOUT,
): Promise<string> {
  const started = Date.now();
  let lastScrollback = "";
  while (Date.now() - started < timeoutMs) {
    lastScrollback = await session.captureFullScrollback();
    if (predicate(lastScrollback)) return lastScrollback;
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for ${description}.\nLast scrollback:\n${lastScrollback}`,
  );
}

function lifecycleStage(): LifecycleStage {
  const value = process.env.FIBER_LIFECYCLE_STAGE ?? "corrected";
  if (
    value !== "baseline-silent" &&
    value !== "fatal-reported" &&
    value !== "correlation-corrected" &&
    value !== "corrected"
  ) {
    throw new Error(`invalid FIBER_LIFECYCLE_STAGE: ${JSON.stringify(value)}`);
  }
  return value;
}

function createArtifactRoot(): string {
  const configured = process.env.FIBER_LIFECYCLE_ARTIFACT_DIR;
  if (configured) {
    mkdirSync(configured, { recursive: true });
    preserveArtifacts = true;
    artifactRoot = realpathSync(configured);
  } else {
    artifactRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "fiber-streamed-tool-lifecycle-artifacts-")),
    );
  }
  return artifactRoot;
}

function writeLifecycleWrapper(
  artifacts: string,
  invocation: "interactive" | "invalid-added-root" = "interactive",
): string {
  const wrapperPath = join(artifacts, "run-fixture.sh");
  const fxCommand = invocation === "invalid-added-root"
    ? '"$fiber_bin" --add-dir "$FIBER_INVALID_ADDED_ROOT"'
    : '"$fiber_bin"';
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
set -u

artifact_dir="\${FIBER_LIFECYCLE_ARTIFACT_DIR:?}"
fiber_bin="\${FIBER_TEST_BIN:?}"

write_atomic() {
  name="$1"
  value="$2"
  target="$artifact_dir/$name"
  printf '%s\\n' "$value" > "$target.tmp"
  /bin/mv "$target.tmp" "$target"
}

write_atomic "wrapper.pid" "$$"
write_atomic "stty.before" "$(/bin/stty -g)"
: > "$artifact_dir/stderr.log"

${fxCommand} 2>"$artifact_dir/stderr.log"
child_status=$?

write_atomic "child.status" "$child_status"
write_atomic "stty.after" "$(/bin/stty -g)"
: > "$artifact_dir/done.tmp"
/bin/mv "$artifact_dir/done.tmp" "$artifact_dir/done"

while [ ! -e "$artifact_dir/release" ]; do
  /bin/sleep 0.05
done

write_atomic "wrapper.status" "0"
`,
  );
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

test("generated lifecycle wrapper uses POSIX sh syntax", () => {
  const artifacts = createArtifactRoot();
  const wrapperPath = writeLifecycleWrapper(artifacts);
  const wrapper = readFileSync(wrapperPath, "utf8");

  expect(wrapperPath.endsWith("run-fixture.sh")).toBe(true);
  expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
  execFileSync("/bin/sh", ["-n", wrapperPath]);
});

function normalizedPaneText(pane: string): string {
  return pane
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) throw new Error("needle must not be empty");
  return value.split(needle).length - 1;
}

function queuedSummaryText(count: number): string {
  return count === 1
    ? "1 queued message · ↑ to edit"
    : `${count} queued messages · ↑ to edit`;
}

function writeDelayedMcpFixture(
  fixtureRoot: string,
  home: string,
  delayMs: number,
) {
  const scriptPath = join(fixtureRoot, "mcp-delayed-fixture.js");
  const callStartedPath = join(fixtureRoot, "mcp-call-started.json");
  writeFileSync(
    scriptPath,
    `const { appendFileSync } = require("node:fs");
let buffer = Buffer.alloc(0);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(message) {
  if (message.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "echo",
          description: "Delayed echo fixture",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    appendFileSync(
      process.env.FIBER_MCP_CALL_STARTED,
      JSON.stringify({
        id: message.id,
        timestamp_ms: Date.now(),
        arguments: message.params.arguments,
      }) + "\\n",
    );
    setTimeout(() => send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "MCP_DELAY_DONE" }] },
    }), ${delayMs});
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const lineEnd = buffer.indexOf("\\n");
    if (lineEnd < 0) return;
    const line = buffer.subarray(0, lineEnd).toString("utf8").replace(/\\r+$/, "");
    buffer = buffer.subarray(lineEnd + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
`,
  );
  writeFileSync(
    join(home, ".fiber", "mcp.json"),
    JSON.stringify({
      mcp: {
        fixture: {
          type: "local",
          command: [process.execPath, scriptPath],
          enabled: true,
          environment: {
            FIBER_MCP_CALL_STARTED: callStartedPath,
          },
        },
      },
    }),
  );
  return { callStartedPath };
}

function readDelayedMcpCalls(path: string): Array<{ arguments: unknown }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { arguments: unknown });
}

function assertThinkingFramesShowSubmittedPrompt(
  framesRoot: string,
  submittedPrompt: string,
) {
  const frameDir = join(framesRoot, "frames");
  const frameNames = readdirSync(frameDir)
    .filter((name) => name.endsWith(".grid.txt"))
    .sort();
  let thinkingFrameCount = 0;

  for (const frameName of frameNames) {
    const frame = readFileSync(join(frameDir, frameName), "utf8");
    const rows = frame.split(/\r?\n/);
    const thinkingRow = rows.findIndex((row) => row.includes("Thinking"));
    if (thinkingRow < 0) continue;
    thinkingFrameCount += 1;

    const submittedPromptVisible = rows.some((row, rowIndex) =>
      rowIndex < thinkingRow && row.includes(submittedPrompt)
    );
    if (!submittedPromptVisible) {
      throw new Error(
        `${frameName} shows Thinking before submitted prompt card:\n${frame}`,
      );
    }
  }

  expect(thinkingFrameCount).toBeGreaterThan(0);
}

function assertFirstPostEnterOutputShowsSubmittedPrompt(
  tapePath: string,
  submittedPrompt: string,
) {
  const frames = readTapeFrames(tapePath);
  const enterIndex = findEnterAfterSubmittedPrompt(frames, submittedPrompt);

  const firstOutput = frames
    .slice(enterIndex + 1)
    .find((frame) => frame.kind === 1);
  expect(firstOutput).toBeDefined();
  expect(firstOutput!.payload.includes(Buffer.from(submittedPrompt))).toBe(true);
}

function findEnterAfterSubmittedPrompt(
  frames: ReturnType<typeof readTapeFrames>,
  submittedPrompt: string,
): number {
  const promptInputIndex = frames.findIndex((frame) =>
    frame.kind === 2 && frame.payload.includes(Buffer.from(submittedPrompt))
  );
  expect(promptInputIndex).toBeGreaterThanOrEqual(0);
  const enterIndex = frames.findIndex((frame, index) =>
    index > promptInputIndex &&
    frame.kind === 2 &&
    frame.payload.equals(Buffer.from("\r"))
  );
  expect(enterIndex).toBeGreaterThan(promptInputIndex);
  return enterIndex;
}

function assertSubmittedPromptRowStaysStableAfterEnter(
  tapePath: string,
  framesRoot: string,
  submittedPrompt: string,
) {
  const frames = readTapeFrames(tapePath);
  const enterIndex = findEnterAfterSubmittedPrompt(frames, submittedPrompt);
  const firstOutput = frames.slice(enterIndex + 1).find((frame) => frame.kind === 1);
  expect(firstOutput).toBeDefined();
  const gridDir = join(framesRoot, "frames");
  const frameNames = readdirSync(gridDir)
    .filter((name) => name.endsWith(".grid.txt"))
    .sort();
  const firstGrid = readFileSync(
    join(gridDir, `${String(firstOutput!.index).padStart(4, "0")}.grid.txt`),
    "utf8",
  );
  const thinkingGrid = frameNames
    .filter((name) => Number.parseInt(name, 10) > firstOutput!.index)
    .map((name) => readFileSync(join(gridDir, name), "utf8"))
    .find((grid) => grid.includes("Thinking"));
  expect(thinkingGrid).toBeDefined();

  const promptRow = (grid: string) => {
    const row = grid.split(/\r?\n/).findIndex((line) =>
      line.includes(submittedPrompt)
    );
    expect(row).toBeGreaterThanOrEqual(0);
    return row;
  };
  expect(promptRow(thinkingGrid!)).toBe(
    promptRow(firstGrid),
  );
}

function hasBareRunningRow(value: string): boolean {
  return value.split(/\r?\n/).some((line) => line.trim() === "● Running");
}

function readTrimmed(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOnlyChildPid(
  parentPid: number,
  timeoutMs = TIMEOUT,
): Promise<number> {
  const started = Date.now();
  let stablePid: number | null = null;
  let stableCount = 0;
  while (Date.now() - started < timeoutMs) {
    let output = "";
    try {
      output = execFileSync("pgrep", ["-P", String(parentPid)], {
        encoding: "utf8",
      }).trim();
    } catch {}
    const pids = output
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isInteger);
    if (pids.length === 1) {
      if (pids[0] === stablePid) {
        stableCount += 1;
      } else {
        stablePid = pids[0];
        stableCount = 1;
      }
      if (stableCount >= 2) return pids[0];
    } else {
      stablePid = null;
      stableCount = 0;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for one child of wrapper ${parentPid}`);
}

async function waitForPath(path: string, timeoutMs = TIMEOUT): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for artifact ${path}`);
}

async function waitForPaneOrDone(
  activeSession: TmuxSession,
  pattern: string,
  donePath: string,
  timeoutMs = TIMEOUT,
): Promise<{ matched: boolean; pane: string }> {
  const started = Date.now();
  let pane = "";
  while (Date.now() - started < timeoutMs) {
    pane = await activeSession.capturePane();
    if (pane.includes(pattern)) return { matched: true, pane };
    if (existsSync(donePath)) return { matched: false, pane };
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for ${JSON.stringify(pattern)} or ${donePath}\n${pane}`,
  );
}

function countTraceEvent(trace: string, event: string, callId?: string): number {
  return trace.split("\n").filter((line) =>
    line.includes(`event=${event}`) &&
    (callId === undefined || line.includes(`call_id=${callId}`))
  ).length;
}

function collectToolResultIds(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectToolResultIds(item, result);
    return result;
  }
  if (value === null || typeof value !== "object") return result;

  const record = value as Record<string, unknown>;
  if (record.type === "tool-result" && typeof record.toolCallId === "string") {
    result.push(record.toolCallId);
  }
  if (record.type === "function_call_output" && typeof record.call_id === "string") {
    result.push(record.call_id);
  }
  for (const nested of Object.values(record)) {
    collectToolResultIds(nested, result);
  }
  return result;
}

function collectTypedToolResults(value: unknown): Array<{
  toolCallId: string;
  toolName: string;
  outputType: string;
}> {
  const results: Array<{
    toolCallId: string;
    toolName: string;
    outputType: string;
  }> = [];

  function collectCallNames(candidate: unknown, names: Map<string, string>) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) collectCallNames(item, names);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (
      record.type === "function_call" &&
      typeof record.call_id === "string" &&
      typeof record.name === "string"
    ) {
      names.set(record.call_id, record.name);
    }
    for (const nested of Object.values(record)) collectCallNames(nested, names);
  }

  const callNames = new Map<string, string>();
  collectCallNames(value, callNames);

  function visit(candidate: unknown) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;

    const record = candidate as Record<string, unknown>;
    if (record.type === "function_call_output" && typeof record.call_id === "string") {
      const toolName = callNames.get(record.call_id) ?? "unknown";
      results.push({
        toolCallId: record.call_id,
        toolName,
        outputType: typeof record.output === "string" ? "text" : "unknown",
      });
    }
    if (record.type === "tool-result") {
      const output =
        record.output !== null && typeof record.output === "object"
          ? (record.output as Record<string, unknown>)
          : {};
      if (
        typeof record.toolCallId === "string" &&
        typeof record.toolName === "string" &&
        typeof output.type === "string"
      ) {
        results.push({
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          outputType: output.type,
        });
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  }

  visit(value);
  return results;
}

async function runCanonicalLifecycleFixture(
  stage: LifecycleStage,
  traceStderr = false,
) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-gateway-ordering-")));
  const home = join(root, "home");
  const workspacePath = join(root, "workspace");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  const workspace = realpathSync(workspacePath);
  writeFileSync(
    join(home, ".fiber", "settings.json"),
    JSON.stringify({
      permission_mode: "ask",
      permission: {
        read: {
          "*": "ask",
        },
        grep: {
          "*": "ask",
        },
      },
    }),
  );
  writeFileSync(join(workspace, CANONICAL_READ_PATH), "alpha fixture\n");
  writeFileSync(
    join(workspace, "beta.txt"),
    `first line\n${CANONICAL_GREP_PATTERN}\nlast line\n`,
  );

  const artifacts = createArtifactRoot();
  const donePath = join(artifacts, "done");
  const releasePath = join(artifacts, "release");
  const tracePath = join(artifacts, "trace.log");
  const wrapperPath = writeLifecycleWrapper(artifacts);
  writeFileSync(join(artifacts, "canonical.sse"), CANONICAL_A_B_CODEX_SSE);
  writeFileSync(
    join(artifacts, "fixture.sha256"),
    `${createHash("sha256").update(CANONICAL_A_B_CODEX_SSE).digest("hex")}\n`,
  );

  const queuedGateway = startCodexQueue([
    CANONICAL_A_B_CODEX_SSE,
    codexFinalText(CANONICAL_FINAL_TEXT),
  ]);
  gateway = queuedGateway;

  session = await TmuxSession.create({
    cmd: wrapperPath,
    cwd: workspace,
    env: seededFakeCodexEnv(home, queuedGateway, {
      FIBER_MODEL: MODEL,
      FIBER_TRACE_LOG: tracePath,
      FIBER_TRACE_SCOPES: undefined,
      FIBER_TRACE_STDERR: traceStderr ? "1" : undefined,
      FIBER_TEST_BIN: FIBER_BIN,
      FIBER_LIFECYCLE_ARTIFACT_DIR: artifacts,
    }),
  });

  await session.waitForComposer(TIMEOUT);
  await waitForPath(join(artifacts, "wrapper.pid"));
  const wrapperPid = Number.parseInt(
    readTrimmed(join(artifacts, "wrapper.pid")),
    10,
  );
  const childPid = await waitForOnlyChildPid(wrapperPid);
  writeFileSync(join(artifacts, "child.pid"), `${childPid}\n`);
  await session.sendText("Inspect both canonical fixtures.");

  let reachedFinal = false;
  let helpVisible = false;
  let requestCountAfterHelp: number | null = null;
  if (stage === "correlation-corrected" || stage === "corrected") {
    let approval = await session.waitForPane(
      (pane) =>
        pane.includes(APPROVAL_PROMPT) &&
        pane.includes(`read_file ${CANONICAL_READ_PATH}`),
      TIMEOUT,
    );
    if (!approval.includes(APPROVAL_PROMPT)) {
      throw new Error("read_file approval prompt did not render");
    }
    await session.sendKeys("Enter");

    approval = await session.waitForPane(
      (pane) =>
        pane.includes(APPROVAL_PROMPT) &&
        pane.includes(`grep_files ${CANONICAL_GREP_PATTERN}`),
      TIMEOUT,
    );
    if (!approval.includes(APPROVAL_PROMPT)) {
      throw new Error("grep_files approval prompt did not render");
    }
    await session.sendKeys("Enter");

    const settled = await waitForPaneOrDone(
      session,
      CANONICAL_FINAL_TEXT,
      donePath,
    );
    reachedFinal = settled.matched;
    if (reachedFinal) {
      await session.sendText("/help");
      const help = await waitForPaneOrDone(session, "Commands 20", donePath);
      helpVisible = help.matched;
      requestCountAfterHelp = queuedGateway.requests.length;
      if (helpVisible) {
        await session.sendKeys("Escape");
        await session.waitForPane((pane) => !pane.includes("Enter Insert"), TIMEOUT);
        await session.sendText("/quit");
      }
    }
  }

  await waitForPath(donePath);
  const pane = await session.capturePane();
  const childStatus = Number.parseInt(
    readTrimmed(join(artifacts, "child.status")),
    10,
  );
  const sttyBefore = readTrimmed(join(artifacts, "stty.before"));
  const sttyAfter = readTrimmed(join(artifacts, "stty.after"));
  const stderr = readFileSync(join(artifacts, "stderr.log"), "utf8");
  const trace = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  const parsedRequests = queuedGateway.requests.map(({ body }) => JSON.parse(body));
  const wrapperAliveAtCapture = session.isAlive() && session.isPaneAlive();
  const childAliveAtCapture = isProcessAlive(childPid);

  writeFileSync(join(artifacts, "pane.txt"), pane);
  writeFileSync(
    join(artifacts, "requests.json"),
    `${JSON.stringify(parsedRequests, null, 2)}\n`,
  );

  writeFileSync(releasePath, "");
  await session.waitForSessionEnd(TIMEOUT);
  session = null;
  const wrapperStatus = Number.parseInt(
    readTrimmed(join(artifacts, "wrapper.status")),
    10,
  );
  const fixtureSha256 = readTrimmed(join(artifacts, "fixture.sha256"));
  const observation = {
    stage,
    traceStderr,
    fixtureSha256,
    pane,
    stderr,
    trace,
    parsedRequests,
    requestCount: queuedGateway.requests.length,
    requestCountAfterHelp,
    reachedFinal,
    helpVisible,
    childPid,
    wrapperPid,
    childStatus,
    childAliveAtCapture,
    wrapperAliveAtCapture,
    wrapperStatus,
    sttyBefore,
    sttyAfter,
  };
  writeFileSync(
    join(artifacts, "manifest.json"),
    `${JSON.stringify(
      {
        stage,
        traceStderr,
        fixtureSha256,
        requestCount: observation.requestCount,
        requestCountAfterHelp,
        reachedFinal,
        helpVisible,
        childPid,
        wrapperPid,
        childStatus,
        childAliveAtCapture,
        wrapperAliveAtCapture,
        wrapperStatus,
        sttyBefore,
        sttyAfter,
        stderrBytes: Buffer.byteLength(stderr),
        traceBytes: Buffer.byteLength(trace),
        paneBytes: Buffer.byteLength(pane),
        done: existsSync(donePath),
      },
      null,
      2,
    )}\n`,
  );
  return observation;
}

async function launchRouteRecoveryTui(
  prefix: string,
  responses: CodexQueueResponse[],
  options: {
    model?: string;
    models?: Array<{ id: string }>;
    settings?: Record<string, unknown>;
  } = {},
) {
  root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspacePath = join(root, "workspace");
  const stderrPath = join(root, "stderr.log");
  mkdirSync(join(home, ".fiber"), { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(home, ".fiber", "settings.json"), JSON.stringify(options.settings ?? {}));
  const workspace = realpathSync(workspacePath);
  const model = options.model ?? MODEL;

  const queuedGateway = startCodexQueue(responses, {
    models: options.models ?? [{ id: model }],
  });
  gateway = queuedGateway;

  session = await TmuxSession.create({
    cwd: workspace,
    width: 72,
    height: 24,
    minimumHistoryLines: 200,
    stderrPath,
    env: seededFakeCodexEnv(home, queuedGateway, {
      FIBER_PERMISSION_MODE: "auto",
      FIBER_MODEL: model,
    }),
  });
  await session.waitForComposer(TIMEOUT);
  return { queuedGateway, stderrPath };
}

describe.skipIf(!tmuxAvailable())("TUI gateway stream lifecycle", () => {
  // Stage-2 deleted cases (all asserted removed products; evidence from the
  // stage-1 codex-harness run, where every one died at a terminal
  // `System: request failed: OpenAICodexResponseFailed` instead of the
  // gateway retry/backoff/recovery UI it waited on):
  // - Gateway transport recovery arc, deleted with the Vercel host-stream
  //   provider (docs/ideas/fiber-product-transition.md): "agent-owned HTTP
  //   retry", "HTTP restricted provider error" (Vercel team allowlist),
  //   "post-tool HTTP 503", "provider route recovery counts down",
  //   "paused response resumes through slash continue", "slash continue
  //   cannot duplicate an active checkpointed request", "paused tool
  //   lifecycle", "Escape during provider recovery backoff", "slash
  //   continue does not render checkpointed partial output twice",
  //   "provider error after assistant output", "provider error after
  //   streamed tool start".
  // - Standing Fast mode, now a per-request tier (same doc): "Fast failure
  //   heartbeat", "process restart during backoff", "Fast route failure
  //   automatically falls back" (also pinned non-Codex zai/glm-5.2).
  // - Non-Codex provider model identity: "streaming model selection"
  //   (zai/glm-5.2, ai-language-model-id headers, gateway settings shape).
  // - Removed /image family (same doc): "queued prompt stays pending until
  //   active assistant text completes" and "queued image yank".
  test(
    "full-window output limit is omitted from the agent request",
    async () => {
      const model = "meta/muse-spark-1.2-contributor";
      const finalText = "Full-window output limit omitted.";
      const { queuedGateway, stderrPath } = await launchRouteRecoveryTui(
        "fiber-tui-full-window-output-limit-",
        [codexFinalText(finalText)],
        {
          model,
          models: [{
            id: model,
            type: "language",
            tags: ["reasoning", "tool-use", "implicit-caching", "file-input", "vision"],
            context_window: 1_048_576,
            max_tokens: 1_048_576,
          }],
          settings: { model },
        },
      );
      await waitForCondition(
        () => queuedGateway.modelRequests.length === 1,
        "full-window model catalog",
      );

      await session!.sendText("hi");
      await session!.waitForText(finalText, TIMEOUT);
      await session!.waitForComposer(TIMEOUT);

      expect(queuedGateway.modelRequests).toHaveLength(1);
      expect(queuedGateway.requests).toHaveLength(1);
      expect(JSON.parse(queuedGateway.requests[0]!.body)).not.toHaveProperty(
        "maxOutputTokens",
      );
      expect(session!.isAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await session!.sendText("/quit");
      expect(await session!.waitForSessionEnd(TIMEOUT)).toBe(true);
      await session!.kill();
      session = null;
    },
    TIMEOUT * 2,
  );

  test(
    "live token counter includes submitted input, reasoning, and streamed text",
    async () => {
      const hold: TokenProgressHoldState = { started: false, cancelled: false };
      const finalSentinel = "FIBER_LIVE_TOKEN_COUNTER_COMPLETE";
      const streamedText = `${"streaming output\n".repeat(256)}${finalSentinel}`;
      const { queuedGateway, stderrPath } = await launchRouteRecoveryTui(
        "fiber-tui-live-token-counter-",
        [
          () =>
            stagedCodexTokenProgressResponse(
              hold,
              "reasoning tokens should advance while hidden from the transcript",
              streamedText,
            ),
        ],
      );

      await session!.sendText("Exercise the live token counter.");
      const reasoningPane = await waitForScrollback(
        session!,
        (value) =>
          /Thinking \(\d+s\) \(↑8 ↓[1-9]\d*(?:\.\d)?k?\)/.test(
            value,
          ),
        "reasoning token progress",
      );
      expect(reasoningPane).not.toContain(
        "reasoning tokens should advance while hidden from the transcript",
      );
      expect(queuedGateway.requests).toHaveLength(1);

      hold.sendContent?.();
      const streamingPane = await waitForScrollback(
        session!,
        (value) =>
          streamingOutputTokens(value) !== null &&
          !value.includes(finalSentinel),
        "first estimated live token progress while text is paced",
      );
      const firstOutputTokens = streamingOutputTokens(streamingPane)!;

      hold.sendMoreContent?.();
      const laterStreamingPane = await waitForScrollback(
        session!,
        (value) => {
          const outputTokens = streamingOutputTokens(value);
          return outputTokens !== null &&
            outputTokens > firstOutputTokens &&
            !value.includes(finalSentinel);
        },
        "increasing estimated live token progress",
      );
      expect(streamingOutputTokens(laterStreamingPane)).toBeGreaterThan(
        firstOutputTokens,
      );

      hold.finish?.();
      await session!.waitForText(finalSentinel, TIMEOUT);
      const finalScrollback = await waitForScrollback(
        session!,
        (value) =>
          value.includes(finalSentinel) &&
          / {2}(?:\d+s|\d+m \d+s|\d+h \d{2}m) \(↑8 ↓20k\)/.test(
            value,
          ),
        "final compact token summary",
      );
      expect(finalScrollback).toContain(finalSentinel);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );

  test(
    "assistant publishes a complete markdown block before the following tool",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-bounded-assistant-pacing-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const framesRoot = join(root, "replay-frames");
      const hold: HoldState = { started: false, cancelled: false };
      const renderedSentence =
        "PACING_STREAM_SENTENCE keeps smooth markdown visible before tool presentation begins.";
      const sourceSentence = renderedSentence.replace("smooth", "**smooth**");
      const toolMarker = "PACING_TOOL_BOUNDARY_DONE";
      const finalText = "PACING_STREAM_COMPLETE";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");

      const queuedGateway = startCodexQueue([
        () =>
          heldCodexResponse(
            hold,
            [{ type: "text-delta", id: "answer_1", delta: `${sourceSentence}\n\n` }],
            [
              { type: "tool-input-start", id: "pacing_tool", toolName: "shell" },
              {
                type: "tool-call",
                toolCallId: "pacing_tool",
                toolName: "shell",
                input: { request: {
                  action: "run",
                  yield_time_ms: 30_000,
                  timeout_ms: 10_000,
                  command: `printf ${toolMarker}`,
                } },
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ],
          ),
        codexFinalText(finalText),
      ]);
      gateway = queuedGateway;
      session = await TmuxSession.create({
        cwd: realpathSync(workspace),
        width: 120,
        height: 40,
        stderrPath,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_PERMISSION_MODE: "yolo",
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Render markdown, then run the command.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held markdown response",
      );
      await session.waitForText(renderedSentence, TIMEOUT);
      hold.release?.();
      await session.waitForText(finalText, TIMEOUT);

      execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--frames-dir", framesRoot], {
        encoding: "utf8",
      });
      const grids = readdirSync(join(framesRoot, "frames"))
        .filter((name) => name.endsWith(".grid.txt"))
        .sort()
        .map((name) => readFileSync(join(framesRoot, "frames", name), "utf8"));
      const prefixLength = (grid: string): number => {
        const rows = grid.split("\n");
        for (let count = renderedSentence.length; count > 0; count -= 1) {
          if (rows.some((row) => row.startsWith(`|  ${renderedSentence.slice(0, count)}`))) {
            return count;
          }
        }
        return 0;
      };
      const prefixLengths = grids
        .map(prefixLength)
        .filter((count, index, values) => count > 0 && count !== values[index - 1]);
      const paragraphFrame = grids.findIndex((grid) => grid.includes(renderedSentence));
      const toolFrame = grids.findIndex((grid) => grid.includes(toolMarker));

      expect(prefixLengths).toEqual([renderedSentence.length]);
      expect(paragraphFrame).toBeGreaterThanOrEqual(0);
      expect(toolFrame).toBeGreaterThanOrEqual(0);
      expect(paragraphFrame).toBeLessThan(toolFrame);
      expect(prefixLength(grids[toolFrame]!)).toBe(renderedSentence.length);
      expect(grids[toolFrame]!.indexOf(renderedSentence)).toBeLessThan(
        grids[toolFrame]!.indexOf(toolMarker),
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "streamed write payload keeps the activity row live",
    async () => {
      const hold: ToolPayloadHoldState = { started: false, cancelled: false };
      const nextStep: HoldState = { started: false, cancelled: false };
      const payloadPath = "payload-progress.md";
      // Preserve two substantial streamed input chunks for the live
      // activity-row assertions.
      const payloadContent = "staged tool payload content\n".repeat(64);
      const assistantText = "I will write the staged payload now.";
      const finalSentinel = "FIBER_TOOL_PAYLOAD_PROGRESS_COMPLETE";
      const { queuedGateway, stderrPath } = await launchRouteRecoveryTui(
        "fiber-tui-tool-payload-progress-",
        [
          () =>
            stagedCodexToolPayloadResponse(
              hold,
              assistantText,
              payloadPath,
              payloadContent,
            ),
          () => heldCodexResponse(nextStep, [], [
            { type: "text-delta", id: "answer_2", delta: finalSentinel },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 8 },
                outputTokens: { total: 5 },
              },
            },
          ]),
        ],
      );

      await session!.sendText("Write the staged payload file.");
      const firstPayloadPane = await waitForScrollback(
        session!,
        (value) =>
          value.includes(assistantText) &&
          quietToolPayloadOutputTokens(value) !== null,
        "activity marker during the first tool payload chunk",
      );
      const firstOutputTokens = quietToolPayloadOutputTokens(firstPayloadPane)!;
      expect(queuedGateway.requests).toHaveLength(1);

      hold.sendMoreInput?.();
      const laterPayloadPane = await waitForScrollback(
        session!,
        (value) => {
          const outputTokens = quietToolPayloadOutputTokens(value);
          return outputTokens !== null && outputTokens > firstOutputTokens;
        },
        "increasing token progress during the tool payload",
      );
      expect(quietToolPayloadOutputTokens(laterPayloadPane)).toBeGreaterThan(
        firstOutputTokens,
      );

      hold.finish?.();
      await waitForCondition(
        () => queuedGateway.requests.length === 2 && nextStep.started,
        "next model step after tool completion",
      );
      const nextStepPane = await waitForScrollback(
        session!,
        (value) =>
          /• Thinking \(\d+(?:h\d+m\d+s|m\d+s|s)\) \(↑\d+(?:\.\d)?k? ↓\d+(?:\.\d)?k?\)/.test(
            value,
          ) && !value.includes(finalSentinel),
        "thinking activity during the next admitted model step",
      );
      expect(nextStepPane).not.toContain(finalSentinel);
      nextStep.release?.();
      await session!.waitForText(finalSentinel, TIMEOUT);
      expect(queuedGateway.classifierRequests).toHaveLength(0);
      const writtenPath = join(root!, "workspace", payloadPath);
      await waitForCondition(
        () => existsSync(writtenPath),
        "staged payload file",
      );
      expect(readFileSync(writtenPath, "utf8")).toBe(payloadContent);
      expect(queuedGateway.requests).toHaveLength(2);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );

  test(
    "follow-up input counter excludes retained context and provider input usage",
    async () => {
      const firstFinal = `FIRST_TURN_CONTEXT_COMPLETE ${"retained assistant context ".repeat(128)}`;
      const followupFinal = "FOLLOWUP_INPUT_COUNTER_COMPLETE";
      const { queuedGateway, stderrPath } = await launchRouteRecoveryTui(
        "fiber-tui-followup-input-counter-",
        [
          codexFinalTextWithUsage(firstFinal, 30_000, 600),
          codexFinalTextWithUsage(followupFinal, 16_000, 5),
        ],
      );

      await session!.sendText("Seed retained context for the follow-up.");
      await waitForScrollback(
        session!,
        (value) =>
          value.includes("FIRST_TURN_CONTEXT_COMPLETE") &&
          TURN_SUMMARY_WITH_TOKENS.test(value),
        "first turn summary",
      );

      await session!.sendText("open it for me");
      const followupScrollback = await waitForScrollback(
        session!,
        (value) =>
          value.includes(followupFinal) &&
          / {2}(?:\d+s|\d+m \d+s|\d+h \d{2}m) \(↑4 ↓5\)/.test(
            value,
          ),
        "follow-up submitted input summary",
      );

      expect(queuedGateway.requests).toHaveLength(2);
      expect(queuedGateway.requests[1].body).toContain(
        "FIRST_TURN_CONTEXT_COMPLETE",
      );
      expect(followupScrollback).not.toContain("(↑16k ↓5)");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );

  test(
    "content filter opens local recovery modal without transcript card",
    async () => {
      const { queuedGateway, stderrPath } = await launchRouteRecoveryTui(
        "fiber-tui-route-content-filter-",
        [codexContentFilterResponse()],
      );

      await session!.sendText("Trigger content filter.");
      const pane = await session!.waitForText("Try again later", TIMEOUT);
      await session!.sendKeys("Down");
      await session!.sendKeys("Enter");
      await session!.waitForComposer(TIMEOUT);
      await session!.waitForText("⚠ blocked · content_filter · content filter", TIMEOUT);
      const scrollback = await session!.captureFullScrollback();

      expect(queuedGateway.requests.length).toBe(1);
      expect(scrollback).not.toContain("What should fiber do?");
      expect(pane).toContain("Change model");
      expect(pane).toContain("Try again later");
      expect(pane).toContain("Response blocked by content filter");
      expect(scrollback).toContain("⚠ blocked · content_filter · content filter");
      expect(pane).not.toContain("Disable Fast");
      expect(pane).not.toContain("Retry same route");
      expect(scrollback).not.toContain("System");
      expect(scrollback).not.toContain("Change model");
      expect(scrollback).not.toContain("request failed: ModelError");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "unavailable read_tool_result renders and persists a failed result",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-read-tool-result-failure-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const tracePath = join(root, "trace.log");
      const expectedFailure =
        "read_tool_result failed for handle unknown-dogfood-handle: ResultHandleNotFound. No exact match exists in the active tool-result store; handles are session-scoped and must be copied exactly from the tool result preview.";
      const finalText = "Read tool result failure lifecycle completed.";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);

      const queuedGateway = startCodexQueue([
        codexToolCall(
          "read_result_unknown_1",
          "read_tool_result",
          {
            handle: "unknown-dogfood-handle",
            start_byte: 1,
            byte_count: 64,
          },
        ),
        codexFinalText(finalText),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Exercise the unavailable tool-result handle.");
      const pane = await session.waitForText(finalText, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 2,
        "tool-result continuation request",
      );

      const sessionsRoot = join(home, ".fiber", "sessions");
      await waitForCondition(
        () =>
          existsSync(sessionsRoot) &&
          readdirSync(sessionsRoot).some((entry) =>
            existsSync(join(sessionsRoot, entry, "checkpoint.json")),
          ),
        "session checkpoint",
      );
      const sessionId = readdirSync(sessionsRoot).find((entry) =>
        existsSync(join(sessionsRoot, entry, "checkpoint.json")),
      );
      if (!sessionId) throw new Error("session checkpoint was not found");

      const readSavedSession = () =>
        execFileSync(FIBER_BIN, ["session", "show", "--id", sessionId, "--json"], {
          cwd: workspace,
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        });
      await waitForCondition(
        () => readSavedSession().includes('"status":"failure"'),
        "completed persisted tool failure",
      );

      const scrollback = await session.captureFullScrollback();
      const continuation = queuedGateway.requests[1]!.body;
      const savedSession = readSavedSession();

      expect(pane).toContain(finalText);
      expect(scrollback).toContain("Failed tool result");
      expect(continuation).toContain(expectedFailure);
      expect(savedSession).toContain('"status":"failure"');
      expect(savedSession).toContain(expectedFailure);
      expect(existsSync(tapePath)).toBe(true);
      expect(existsSync(tracePath)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "typing during a streamed response leaves the native cursor visible",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-streaming-caret-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const draft = "draft while stream is active";
      const stream = { started: false, cancelled: false };
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");

      const streamingGateway = startCodexQueue([
        () => heldCodexResponse(stream),
      ]);
      gateway = streamingGateway;
      session = await TmuxSession.create({
        cwd: realpathSync(workspace),
        stderrPath,
        env: seededFakeCodexEnv(home, streamingGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Start the streamed response.");
      await waitForCondition(() => stream.started, "stream start");
      await session.waitForText("Thinking", TIMEOUT);
      await session.sendLiteral(draft);
      const pane = await session.waitForText(draft, TIMEOUT);

      const draftFrames = stdoutFrames(tapePath).filter((frame) =>
        frame.payload.includes(Buffer.from(draft)),
      );
      const cursorVisibility = draftFrames.flatMap((frame) =>
        [...frame.payload.toString("binary").matchAll(/\x1b\[\?25([hl])/g)]
          .map((match) => match[1]!),
      );

      expect(pane).toContain("Thinking");
      expect(draftFrames).not.toHaveLength(0);
      expect(cursorVisibility.at(-1)).toBe("h");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "idle submitted prompt stays visible across a first-use context notice",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-idle-submit-order-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const tracePath = join(root, "fiber-trace.log");
      const framesRoot = join(root, "replay-frames");
      const submittedPrompt = "IDLE_SUBMIT_ORDER_SENTINEL";
      const newerDraft = "RAPID_SECOND_DRAFT_SENTINEL";
      const hold: HoldState = { started: false, cancelled: false };
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      writeFileSync(
        join(root, "outside-instructions.md"),
        "# Outside instructions\n",
      );
      symlinkSync("../outside-instructions.md", join(workspacePath, "AGENTS.md"));
      const workspace = realpathSync(workspacePath);

      const heldGateway = startCodexQueue([
        () => heldCodexResponse(hold),
      ]);
      gateway = heldGateway;
      session = await TmuxSession.create({
        cwd: workspace,
        width: 96,
        height: 28,
        stderrPath,
        env: seededFakeCodexEnv(home, heldGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "input,worker",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendLiteral(submittedPrompt);
      session.sendKeysImmediate(["Enter"]);
      session.sendLiteralImmediate(newerDraft);
      session.sendKeysImmediate(["Enter"]);
      await waitForCondition(
        () => heldGateway.requests.length === 1 && hold.started,
        "held idle submitted prompt stream",
      );
      await session.waitForText("Thinking", TIMEOUT);
      await Bun.sleep(250);
      await session.sendKeys("C-c");
      const cancelledPane = await session.waitForText("cancelled", TIMEOUT);

      execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--frames-dir", framesRoot], {
        encoding: "utf8",
      });
      assertFirstPostEnterOutputShowsSubmittedPrompt(tapePath, submittedPrompt);
      assertSubmittedPromptRowStaysStableAfterEnter(
        tapePath,
        framesRoot,
        submittedPrompt,
      );
      assertThinkingFramesShowSubmittedPrompt(framesRoot, submittedPrompt);
      const trace = readFileSync(tracePath, "utf8");
      const frameCommitted = trace.indexOf("event=pending_prompt_frame_committed");
      const promptQueued = trace.indexOf("event=prompt_enqueue");
      const workerBegin = trace.indexOf("event=worker_begin");
      expect(frameCommitted).toBeGreaterThanOrEqual(0);
      expect(promptQueued).toBeGreaterThan(frameCommitted);
      expect(workerBegin).toBeGreaterThan(promptQueued);
      expect(composerContains(cancelledPane, newerDraft)).toBe(true);

      expect(hold.cancelled).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(tapePath)).toBe(true);
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "idle submitted prompt keeps its canonical row after a completed turn",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-idle-submit-multiturn-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const framesRoot = join(root, "replay-frames");
      const seedPrompt = "MULTI_TURN_SEED_PROMPT";
      const seedReply = "MULTI_TURN_SEED_REPLY";
      const submittedPrompt = "MULTI_TURN_ROW_SENTINEL";
      const hold: HoldState = { started: false, cancelled: false };
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");

      const queuedGateway = startCodexQueue([
        codexFinalText(seedReply),
        () => heldCodexResponse(hold),
      ]);
      gateway = queuedGateway;
      session = await TmuxSession.create({
        cwd: realpathSync(workspace),
        width: 96,
        height: 28,
        stderrPath,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText(seedPrompt);
      await session.waitForText(seedReply, TIMEOUT);
      await session.waitForComposer(TIMEOUT);
      await session.sendLiteral(submittedPrompt);
      session.sendKeysImmediate(["Enter"]);
      await waitForCondition(
        () => queuedGateway.requests.length === 2 && hold.started,
        "held multi-turn submitted prompt stream",
      );
      await session.waitForText("Thinking", TIMEOUT);
      await Bun.sleep(250);
      await session.sendKeys("C-c");
      await session.waitForText("cancelled", TIMEOUT);

      execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--frames-dir", framesRoot], {
        encoding: "utf8",
      });
      assertFirstPostEnterOutputShowsSubmittedPrompt(tapePath, submittedPrompt);
      assertSubmittedPromptRowStaysStableAfterEnter(
        tapePath,
        framesRoot,
        submittedPrompt,
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "complete assistant block precedes a queued user prompt in scrollback",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-prompt-boundary-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      const tracePath = join(root, "trace.log");
      const firstResponse: HoldState = { started: false, cancelled: false };
      const secondResponse = { started: false, cancelled: false };
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);

      const splitGateway = startCodexQueue([
        () =>
          heldCodexResponse(
            firstResponse,
            [{ type: "text-delta", id: "split_old", delta: `${SPLIT_OLD_RESPONSE}\n` }],
            [
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 3 },
                  outputTokens: { total: 5 },
                },
              },
            ],
          ),
        () => heldCodexResponse(secondResponse),
      ]);
      gateway = splitGateway;
      session = await TmuxSession.create({
        cwd: workspace,
        width: 120,
        height: 34,
        minimumHistoryLines: 2_000,
        stderrPath,
        env: seededFakeCodexEnv(home, splitGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Return the first split fixture.");
      await waitForCondition(
        () => splitGateway.requests.length === 1 && firstResponse.started,
        "held first Gateway stream",
      );
      await session.waitForText("SPLIT_OLD_TAIL_FINAL", TIMEOUT);

      await session.sendText(SPLIT_NEW_USER_PROMPT);
      expect(splitGateway.requests).toHaveLength(1);
      firstResponse.release?.();
      await waitForCondition(
        () => splitGateway.requests.length === 2 && secondResponse.started,
        "held second Gateway stream",
      );

      const rawScrollback = await waitForEscapedScrollback(
        session,
        (candidate) => {
          const promptIndex = candidate.lastIndexOf(SPLIT_NEW_USER_PROMPT);
          if (promptIndex < 0) return false;
          const finalTailIndex = candidate.lastIndexOf("SPLIT_OLD_TAIL_FINAL");
          return finalTailIndex >= 0 && finalTailIndex < promptIndex;
        },
        "old assistant final tail before the next user prompt",
        SPLIT_BOUNDARY_WAIT_TIMEOUT,
      );
      const scrollback = await session.captureFullScrollback();
      const promptIndex = rawScrollback.lastIndexOf(SPLIT_NEW_USER_PROMPT);
      expect(promptIndex).toBeGreaterThanOrEqual(0);

      const finalTailIndex = rawScrollback.lastIndexOf("SPLIT_OLD_TAIL_FINAL");
      expect(finalTailIndex).toBeGreaterThanOrEqual(0);
      expect(finalTailIndex).toBeLessThan(promptIndex);
      expect(countOccurrences(rawScrollback, SPLIT_NEW_USER_PROMPT)).toBe(1);

      expect(scrollback).toContain("SPLIT_OLD_TAIL_FINAL");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(tapePath)).toBe(true);
      expect(existsSync(tracePath)).toBe(true);
      expect(
        execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--json"], {
          encoding: "utf8",
        }),
      ).not.toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    SPLIT_BOUNDARY_TEST_TIMEOUT,
  );

  test(
    "confirmed post-cancel queued prompt recovers duplicate-key tool arguments",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-cancel-integrity-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "session.fibertape");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: HoldState = { started: false, cancelled: false };
      const duplicateArguments = '{"depth":1, "depth":2}';
      const finalText = "Queued recovery completed after sanitized history.";
      const queuedGateway = startCodexQueue([
        codexSerializedToolCall(
          "first_turn_command",
          "shell",
          '{"request":{"action":"run","yield_time_ms":30000,"timeout_ms":600000,"command":"printf preflight-failed > preflight.txt"}}',
        ),
        () => heldCodexResponse(hold),
        codexSerializedToolCall(
          "queued_grep_command",
          "shell",
          '{"request":{"action":"run","yield_time_ms":30000,"timeout_ms":600000,"command":"grep -R \\"preflight\\" -n . | head"}}',
        ),
        codexDuplicateKeyToolResponse(),
        codexFinalText(finalText),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,core,gateway,stream,tool,sse,worker,input,prompt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText(
        "Create dogfood-notes.txt with three lines, then report its byte count.",
      );
      await waitForCondition(
        () => queuedGateway.requests.length >= 2 && hold.started,
        "held second gateway request",
      );

      await session.sendText(
        "Why did preflight fail? Do not write anything; just explain briefly.",
      );
      await session.waitForText(queuedSummaryText(1), TIMEOUT);
      await session.sendKeys("C-c");
      await session.waitForPane(
        (candidate) =>
          candidate.includes("Why did preflight fail?") &&
          candidate.includes("paused") &&
          candidate.includes("enter to send"),
        TIMEOUT,
      );
      expect(queuedGateway.requests).toHaveLength(2);
      await session.sendKeys("Enter");
      const pane = await session.waitForText(finalText, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 5 && hold.cancelled,
        "fifth gateway request after held request cancellation",
      );

      const finalRequest = JSON.parse(queuedGateway.requests[4].body) as {
        input: Array<Record<string, unknown>>;
      };
      const parts = finalRequest.input ?? [];
      const repairedCalls = parts.filter((part) =>
        part.type === "function_call" &&
        part.call_id === "queued_duplicate_list" &&
        part.name === "glob_files"
      );
      const repairedResults = parts.filter((part) =>
        part.type === "function_call_output" &&
        part.call_id === "queued_duplicate_list"
      );
      const trace = readFileSync(tracePath, "utf8");
      const stderr = readFileSync(stderrPath, "utf8");

      // Owner ruling (scrub-vs-retain): recovery retains the verbatim model
      // action in function_call; the structured error rides the paired
      // function_call_output pinned below.
      expect(repairedCalls).toEqual([
        expect.objectContaining({
          type: "function_call",
          name: "glob_files",
          arguments: duplicateArguments,
        }),
      ]);
      expect(repairedResults).toEqual([
        expect.objectContaining({
          output: expect.stringContaining("tool_execution_failed"),
        }),
      ]);
      expect(queuedGateway.requests[4].body).not.toContain(duplicateArguments);
      // Codex-era integrity event (replaces the gateway-era
      // provider_tool_arguments_rejected pin).
      expect(trace).toContain("event=argument_integrity_rejected");
      expect(trace).toContain("failure=malformed_json");
      expect(trace).toContain("event=queue_review_started");
      expect(trace).toContain("reason=post_cancel");
      expect(trace).toContain("event=queue_review_committed");
      expect(trace).toContain("event=queue_review_resumed");
      expect(trace).not.toContain(duplicateArguments);
      expect(pane).not.toContain("InvalidGatewayHistory");
      expect(stderr).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
      expect(existsSync(tapePath)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "active /permissions preserves a held post-tool turn and next prompt",
    async () => {
      const artifacts = createArtifactRoot();
      const home = join(artifacts, "home");
      const workspacePath = join(artifacts, "workspace");
      const stderrPath = join(artifacts, "stderr.log");
      const readFilename = "ACTIVE_PERMISSION_READ_SENTINEL.txt";
      const toolHeader = "● 1 tool call · 1 read";
      const toolMarker = `└ Read ${readFilename}`;
      const permissionMarker = "● Permissions: mode=auto";
      const activeBefore = "ACTIVE_PERMISSION_BEFORE_SENTINEL\n";
      const activeAfter = "ACTIVE_PERMISSION_AFTER_SENTINEL\n";
      const followupPrompt = "ACTIVE_PERMISSION_FOLLOWUP_PROMPT_SENTINEL";
      const followupResponse = "ACTIVE_PERMISSION_FOLLOWUP_RESPONSE_SENTINEL";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      writeFileSync(join(workspacePath, readFilename), "active permission fixture\n");
      const workspace = realpathSync(workspacePath);
      const hold: HoldState = { started: false, cancelled: false };
      const heldGateway = startCodexQueue([
        codexToolCall(
          "active_permission_read",
          "read_file",
          { path: readFilename },
        ),
        () => splitHeldCodexResponse(hold, activeBefore, activeAfter),
        codexFinalText(followupResponse),
      ]);
      gateway = heldGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, heldGateway, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_MODEL: MODEL,
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Exercise the active permissions fixture.");
      await waitForCondition(
        () => heldGateway.requests.length === 2 && hold.started,
        "held post-tool continuation",
      );

      await session.sendText("/permissions");
      await waitForEscapedScrollback(
        session,
        (candidate) => {
          const visible = normalizedPaneText(candidate);
          return heldGateway.requests.length === 2 &&
            hold.started &&
            visible.includes(toolHeader) &&
            visible.includes(toolMarker) &&
            visible.includes(permissionMarker) &&
            visible.includes("Generating");
        },
        "local permissions output during held post-tool continuation",
      );
      expect(heldGateway.requests).toHaveLength(2);
      expect(hold.cancelled).toBe(false);

      hold.release?.();
      await session.waitForPane(
        (pane) =>
          pane.includes(activeBefore.trim()) &&
          pane.includes(activeAfter.trim()) &&
          !pane.includes("Generating"),
        TIMEOUT,
      );
      expect(heldGateway.requests).toHaveLength(2);

      await session.sendText(followupPrompt);
      await waitForCondition(
        () => heldGateway.requests.length === 3,
        "follow-up Gateway request",
      );
      await session.waitForText(followupResponse, TIMEOUT);
      await session.waitForPane(
        (pane) => pane.includes(followupResponse) && !pane.includes("Generating"),
        TIMEOUT,
      );

      const followupRequest = JSON.parse(heldGateway.requests[2]!.body) as {
        input: Array<Record<string, unknown>>;
      };
      const followupContext = JSON.stringify(followupRequest.input);
      expect(followupContext).toContain(readFilename);
      expect(followupContext).toContain(activeBefore.trim());
      expect(followupContext).toContain(activeAfter.trim());
      expect(followupContext).toContain(followupPrompt);
      expect(heldGateway.requests).toHaveLength(3);
      expect(session.paneStatus()).toEqual({ dead: false, status: null });
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );

  test(
    "Up pauses queued admission and commits every edited prompt in FIFO order",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-review-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const activeAfter = "ACTIVE_FINISHED_WHILE_QUEUE_PAUSED";
      const firstQueued = "Continue with QUEUE_REVIEW_FIRST_SENTINEL.";
      const firstEdited = " QUEUE_REVIEW_EDITED_SENTINEL";
      const secondQueued = "Continue with QUEUE_REVIEW_SECOND_SENTINEL.";
      const secondEdited = " QUEUE_REVIEW_SECOND_EDITED_SENTINEL";
      const firstDone = "QUEUE_REVIEW_FIRST_DONE";
      const secondDone = "QUEUE_REVIEW_SECOND_DONE";
      const queuedGateway = startCodexQueue([
        () => splitHeldCodexResponse(hold, "ACTIVE_QUEUE_REVIEW_STARTED\n", activeAfter),
        codexFinalText(firstDone),
        codexFinalText(secondDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the active queue review turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for manual queue review",
      );
      await session.sendText(firstQueued);
      await session.sendText(secondQueued);
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedSummaryText(2)) &&
          !pane.includes(firstQueued) &&
          !pane.includes(secondQueued),
        TIMEOUT,
      );

      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(secondQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      const queuedCardLine = (await session.capturePaneEscapes())
        .split("\n")
        .find((line) => line.includes(firstQueued));
      expect(queuedCardLine).toBeDefined();
      expect(queuedCardLine).toContain("┃");
      expect(queuedCardLine).not.toContain("\x1b[48;");
      await session.sendLiteral(secondEdited);
      await session.waitForPane(
        (pane) => pane.includes(secondQueued + secondEdited),
        TIMEOUT,
      );
      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(firstQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );

      hold.release?.();
      await session.waitForText(activeAfter, TIMEOUT);
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=prompt_finish"),
        "active stream completion while queue review is paused",
      );
      await Bun.sleep(250);
      expect(queuedGateway.requests).toHaveLength(1);
      expect(hold.cancelled).toBe(false);

      await session.pasteText(firstEdited);
      await session.sendKeys("Enter");
      await session.waitForText(secondDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 3,
        "edited and remaining queued prompts in FIFO order",
      );

      const firstQueuedBody = queuedGateway.requests[1].body;
      const secondQueuedBody = queuedGateway.requests[2].body;
      const trace = readFileSync(tracePath, "utf8");
      expect(firstQueuedBody).toContain(firstQueued);
      expect(firstQueuedBody).toContain(firstEdited.trim());
      expect(firstQueuedBody).not.toContain(secondQueued);
      expect(secondQueuedBody).toContain(secondQueued);
      expect(secondQueuedBody).toContain(secondEdited.trim());
      expect(trace).toContain("event=queue_review_started");
      expect(trace).toContain("reason=manual");
      expect(trace).toContain("event=queue_review_committed");
      expect(trace).toContain("event=queue_review_batch_committed");
      expect(trace).toContain("event=queue_review_resumed");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "Escape hides a focused queue editor without cancelling the active stream",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-review-escape-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const queuedPrompt = "Keep QUEUE_ESCAPE_FOCUS_SENTINEL pending.";
      const editorSuffix = " QUEUE_ESCAPE_EDITOR_SUFFIX";
      const composerText = "NEW_COMPOSER_OWNER";
      const queuedGateway = startCodexQueue([
        () =>
          splitHeldCodexResponse(
            hold,
            "ACTIVE_QUEUE_ESCAPE_STARTED\n",
            "ACTIVE_QUEUE_ESCAPE_FINISHED",
          ),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the queue Escape ownership turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for queue Escape ownership",
      );
      await session.sendText(queuedPrompt);
      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedPrompt) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      await session.sendLiteralText(editorSuffix);
      await session.waitForText(queuedPrompt + editorSuffix, TIMEOUT);

      await session.sendKeys("Escape");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=queue_review_hidden"),
        "hidden queue review before stream cancellation",
      );
      await session.waitForPane(
        (pane) => pane.includes("Generating"),
        TIMEOUT,
      );
      expect(hold.cancelled).toBe(false);

      await session.sendLiteralText(composerText);
      await session.waitForPane(
        (pane) =>
          pane.includes(composerText) &&
          !pane.includes(queuedPrompt + editorSuffix + composerText),
        TIMEOUT,
      );

      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain("event=queue_review_hidden");
      expect(trace).not.toContain("event=cancel_requested");
      expect(queuedGateway.requests).toHaveLength(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "queued review preserves pasted backing and follows a long draft cursor",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-semantic-drafts-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const pastedPrompt =
        `QUEUE_PASTE_START_${"q".repeat(5000)}_QUEUE_PASTE_END`;
      const pastedEdit = "Z";
      const longPrompt =
        `QUEUE_CURSOR_HEAD_${"e".repeat(1800)}_QUEUE_CURSOR_TAIL`;
      const longEdit = "_EDITED_AT_TAIL";
      const pastedDone = "QUEUE_PASTE_DONE";
      const longDone = "QUEUE_CURSOR_DONE";
      const queuedGateway = startCodexQueue([
        () =>
          splitHeldCodexResponse(
            hold,
            "ACTIVE_SEMANTIC_QUEUE_STARTED\n",
            "ACTIVE_SEMANTIC_QUEUE_FINISHED",
          ),
        codexFinalText(pastedDone),
        codexFinalText(longDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 80,
        height: 24,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the semantic queue review turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for semantic queue review",
      );

      await session.pasteText(pastedPrompt);
      await session.waitForPane(
        (pane) => pane.includes("[Pasted text #"),
        TIMEOUT,
      );
      await session.sendKeys("Enter");
      await session.sendLiteralText(longPrompt);
      await session.sendKeys("Enter");
      await session.waitForPane(
        (pane) => pane.includes(queuedSummaryText(2)),
        TIMEOUT,
      );

      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes("QUEUE_CURSOR_TAIL") &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      let { cursor, grid } = await waitForCursorRow(
        session,
        "QUEUE_CURSOR_TAIL",
        "long queued draft cursor row",
      );
      expect(grid[cursor.row]).toContain("QUEUE_CURSOR_TAIL");
      await session.sendLiteral(longEdit);
      await session.waitForPane((pane) => pane.includes(longEdit), TIMEOUT);

      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) => pane.includes("[Pasted text #") && pane.includes("paused"),
        TIMEOUT,
      );
      ({ cursor, grid } = await waitForCursorRow(
        session,
        "[Pasted text #",
        "pasted queued draft cursor row",
      ));
      expect(grid[cursor.row]).toContain("[Pasted text #");
      await session.sendLiteral(pastedEdit);
      await session.waitForPane((pane) => pane.includes("]Z"), TIMEOUT);

      await session.sendKeys("Enter");
      hold.release?.();
      await session.waitForText(longDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 3,
        "semantic queued prompts after active turn",
      );

      expect(queuedGateway.requests[1].body).toContain(
        pastedPrompt + pastedEdit,
      );
      expect(queuedGateway.requests[2].body).toContain(longPrompt + longEdit);
      expect(readFileSync(tracePath, "utf8")).toContain(
        "event=queue_review_batch_committed",
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 3,
  );

  test(
    "queued review shows file completions and preserves the accepted path",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-file-picker-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(join(workspacePath, "src"), { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      writeFileSync(
        join(workspacePath, "src", "main.zig"),
        "pub fn main() void {}\n",
      );
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const olderPrompt = "OLDER_QUEUE_DRAFT";
      const completedPrompt = "Review @src/main.zig";
      const queuedDone = "QUEUE_FILE_PICKER_DONE";
      const queuedGateway = startCodexQueue([
        () =>
          splitHeldCodexResponse(
            hold,
            "ACTIVE_FILE_PICKER_QUEUE_STARTED\n",
            "ACTIVE_FILE_PICKER_QUEUE_FINISHED",
          ),
        codexFinalText(olderPrompt),
        codexFinalText(queuedDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 80,
        height: 24,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the queued file picker turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for queued file picker",
      );
      await session.sendText(olderPrompt);
      await session.sendText(completedPrompt);
      await session.waitForPane(
        (pane) => pane.includes(queuedSummaryText(2)),
        TIMEOUT,
      );

      await session.sendKeys("Up");
      await session.waitForText("paused", TIMEOUT);
      await session.sendKeys("BSpace BSpace BSpace BSpace");
      await session.waitForPane(
        (pane) =>
          pane.includes("Review @src/main") &&
          pane.includes("src/main.zig"),
        TIMEOUT,
      );
      await session.sendKeys("Up");
      await session.waitForText(olderPrompt, TIMEOUT);
      await session.sendKeys("Down");
      await session.waitForPane(
        (pane) =>
          pane.includes("Review @src/main") &&
          pane.includes("src/main.zig"),
        TIMEOUT,
      );

      await session.sendKeys("Enter");
      await session.waitForText(completedPrompt, TIMEOUT);
      await session.sendKeys("Up");
      await session.waitForText(olderPrompt, TIMEOUT);
      await session.sendKeys("Down");
      await session.waitForText(completedPrompt, TIMEOUT);
      await session.sendKeys("Enter");

      hold.release?.();
      await session.waitForText(queuedDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 3,
        "queued prompts after file picker review",
      );

      expect(queuedGateway.requests[2].body).toContain(completedPrompt);
      expect(readFileSync(tracePath, "utf8")).toContain(
        "file picker Enter consumed selected=true",
      );
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 3,
  );

  test(
    "queued review keeps the disabled model picker hidden",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-model-picker-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const hiddenModel = "provider/queued-hidden-model";
      const queuedGateway = startCodexQueue(
        [
          () =>
            splitHeldCodexResponse(
              hold,
              "ACTIVE_MODEL_PICKER_QUEUE_STARTED\n",
              "ACTIVE_MODEL_PICKER_QUEUE_FINISHED",
            ),
        ],
        {
          models: [
            { id: MODEL, type: "language", tags: ["tool-use"] },
            { id: hiddenModel, type: "language", tags: ["tool-use"] },
          ],
        },
      );
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 80,
        height: 24,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the queued model picker turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for queued model picker",
      );
      await waitForCondition(
        () => queuedGateway.modelRequests.length > 0,
        "queued model picker catalog warmup",
      );
      await session.sendText("QUEUED_MODEL_PICKER_DRAFT");
      await session.waitForPane(
        (pane) => pane.includes(queuedSummaryText(1)),
        TIMEOUT,
      );

      await session.sendKeys("Up");
      await session.waitForText("paused", TIMEOUT);
      await session.sendKeys("C-u");
      await session.sendLiteralText("/model provider/queued-hidden");
      await session.waitForPane(
        (pane) => pane.includes("/model provider/queued-hidden"),
        TIMEOUT,
      );
      await Bun.sleep(200);

      let pane = await session.capturePane();
      expect(pane).not.toContain(hiddenModel);
      await session.sendKeys("Tab");
      pane = await session.capturePane();
      expect(pane).toContain("/model provider/queued-hidden");
      expect(pane).not.toContain(hiddenModel);
      await session.sendKeys("Enter");
      pane = await session.capturePane();
      expect(pane).toContain("/model provider/queued-hidden");
      expect(pane).not.toContain(hiddenModel);
      expect(queuedGateway.requests).toHaveLength(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "empty Enter resumes a hidden paused queue without editing it",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-empty-enter-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const queuedPrompt = "Continue with EMPTY_ENTER_QUEUE_SENTINEL.";
      const queuedDone = "EMPTY_ENTER_QUEUE_DONE";
      const queuedGateway = startCodexQueue([
        () =>
          splitHeldCodexResponse(
            hold,
            "ACTIVE_EMPTY_ENTER_STARTED\n",
            "ACTIVE_EMPTY_ENTER_FINISHED",
          ),
        codexFinalText(queuedDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the empty Enter queue turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for empty Enter queue review",
      );
      await session.sendText(queuedPrompt);
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedSummaryText(1)) &&
          !pane.includes(queuedPrompt),
        TIMEOUT,
      );
      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedPrompt) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      await session.sendKeys("Down");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=queue_review_hidden"),
        "hidden queue review after Down before empty Enter",
      );

      await session.sendKeys("Enter");
      await waitForCondition(
        () =>
          readFileSync(tracePath, "utf8").includes(
            "event=queue_review_finished source=unchanged_queue",
          ),
        "unchanged queue submission from empty composer",
      );
      expect(queuedGateway.requests).toHaveLength(1);

      hold.release?.();
      await session.waitForText(queuedDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 2,
        "unchanged queued prompt after active turn",
      );

      const trace = readFileSync(tracePath, "utf8");
      expect(queuedGateway.requests[1].body).toContain(queuedPrompt);
      expect(trace).toContain("event=queue_review_resumed");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "Up edits a queued card in place and repeated Ctrl+U deletes only the empty draft",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-inline-delete-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: SplitHoldState = { started: false, cancelled: false };
      const firstQueued = "Keep QUEUE_INLINE_FIRST_SENTINEL.";
      const firstQueuedEdit = " this";
      const secondQueued = "Delete QUEUE_INLINE_SECOND_SENTINEL.";
      const firstDone = "QUEUE_INLINE_FIRST_DONE";
      const queuedGateway = startCodexQueue([
        () =>
          splitHeldCodexResponse(
            hold,
            "ACTIVE_QUEUE_INLINE_STARTED\n",
            "ACTIVE_QUEUE_INLINE_FINISHED",
          ),
        codexFinalText(firstDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the inline queue editor turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for inline queue editing",
      );
      await session.sendText(firstQueued);
      await session.sendText(secondQueued);
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedSummaryText(2)) &&
          !pane.includes(firstQueued) &&
          !pane.includes(secondQueued),
        TIMEOUT,
      );

      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(secondQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      let { cursor, grid } = await waitForCursorRow(
        session,
        secondQueued,
        "second queued draft cursor row",
      );
      expect(grid[cursor.row]).toContain(secondQueued);
      const pausedRow = grid.findIndex((line) => line.includes("paused"));
      const emptyComposerRow = grid.findIndex(
        (line, index) => index > pausedRow && isEmptyComposerLine(line),
      );
      expect(pausedRow).toBeGreaterThanOrEqual(0);
      expect(emptyComposerRow).toBeGreaterThan(pausedRow);
      expect(cursor.row).not.toBe(emptyComposerRow);

      await session.sendKeys("Up");
      await session.waitForPane((pane) => pane.includes(firstQueued), TIMEOUT);
      await session.sendKeys("Left");
      await session.sendKeys("Right");
      await session.sendLiteral(firstQueuedEdit);
      await session.waitForPane(
        (pane) => pane.includes(firstQueued + firstQueuedEdit),
        TIMEOUT,
      );
      await session.sendKeys("Down");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes(
            "event=queue_review_navigate direction=newer index=1",
          ),
        "edited draft followed by newer queue navigation",
      );
      ({ cursor, grid } = await waitForCursorRow(
        session,
        secondQueued,
        "newer queued draft cursor row",
      ));
      expect(grid[cursor.row]).toContain(secondQueued);
      await session.waitForPane(
        (pane) => pane.includes(firstQueued + firstQueuedEdit),
        TIMEOUT,
      );

      await session.sendKeys("C-u");
      await session.waitForPane(
        (pane) =>
          pane.includes(firstQueued) &&
          !pane.includes(secondQueued) &&
          pane.includes("delete again to remove queued prompt") &&
          pane.includes("enter to send unchanged"),
        TIMEOUT,
      );
      await session.sendKeys("C-u");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes(
            "event=queue_review_draft_deleted",
          ),
        "selected empty queued draft deletion",
      );
      await session.waitForPane(
        (pane) =>
          pane.includes(firstQueued) &&
          !pane.includes(secondQueued) &&
          pane.includes("queued 1"),
        TIMEOUT,
      );
      ({ cursor, grid } = await waitForCursorRow(
        session,
        firstQueued,
        "remaining queued draft cursor row",
      ));
      expect(grid[cursor.row]).toContain(firstQueued);
      expect(queuedGateway.requests).toHaveLength(1);

      await session.sendKeys("Enter");
      hold.release?.();
      await session.waitForText(firstDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 2,
        "remaining queued prompt after inline deletion",
      );

      const trace = readFileSync(tracePath, "utf8");
      expect(queuedGateway.requests[1].body).toContain(
        firstQueued + firstQueuedEdit,
      );
      expect(queuedGateway.requests[1].body).not.toContain(secondQueued);
      expect(trace).toContain("event=queue_review_deleted");
      expect(trace).toContain("event=queue_review_draft_deleted");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "Ctrl+C pauses two queued prompts until the visible draft is confirmed",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-post-cancel-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: HoldState = { started: false, cancelled: false };
      const firstQueued = "Continue with FOLLOWUP_FIRST_SENTINEL.";
      const firstEdited = " FOLLOWUP_EDITED_SENTINEL";
      const secondQueued = "Continue with FOLLOWUP_SECOND_SENTINEL.";
      const firstDone = "FOLLOWUP_FIRST_DONE";
      const secondDone = "FOLLOWUP_SECOND_DONE";
      const queuedGateway = startCodexQueue([
        () =>
          heldCodexResponse(hold, [
            { type: "text-start", id: "answer_1" },
            {
              type: "text-delta",
              id: "answer_1",
              delta: "ACTIVE_POST_CANCEL_REVIEW_STARTED\n",
            },
          ]),
        codexFinalText(firstDone),
        codexFinalText(secondDone),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the active post-cancel turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request for post-cancel queue review",
      );
      await session.sendText(firstQueued);
      await session.sendText(secondQueued);
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedSummaryText(2)) &&
          !pane.includes(firstQueued) &&
          !pane.includes(secondQueued),
        TIMEOUT,
      );
      expect(queuedGateway.requests).toHaveLength(1);
      await session.sendKeys("C-c");
      await waitForCondition(() => hold.cancelled, "active request cancellation");
      await session.waitForPane(
        (pane) =>
          pane.includes(secondQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      await Bun.sleep(250);
      expect(queuedGateway.requests).toHaveLength(1);

      await session.sendKeys("Escape");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=queue_review_hidden"),
        "hidden post-cancel queue draft",
      );
      await Bun.sleep(250);
      expect(queuedGateway.requests).toHaveLength(1);

      await session.sendText("/status");
      await Bun.sleep(250);
      expect(queuedGateway.requests).toHaveLength(1);
      expect(readFileSync(tracePath, "utf8")).not.toContain(
        "event=queue_review_resumed",
      );

      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(secondQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      await session.sendKeys("Up");
      await session.waitForPane(
        (pane) =>
          pane.includes(firstQueued) &&
          pane.includes("paused") &&
          pane.includes("enter to send"),
        TIMEOUT,
      );
      await session.pasteText(firstEdited);
      await session.sendKeys("Enter");
      await session.waitForText(secondDone, TIMEOUT);
      await waitForCondition(
        () => queuedGateway.requests.length === 3,
        "post-cancel edited and remaining queued prompts",
      );

      const firstQueuedBody = queuedGateway.requests[1].body;
      const secondQueuedBody = queuedGateway.requests[2].body;
      const trace = readFileSync(tracePath, "utf8");
      expect(firstQueuedBody).toContain(firstQueued);
      expect(firstQueuedBody).toContain(firstEdited.trim());
      expect(firstQueuedBody).not.toContain(secondQueued);
      expect(secondQueuedBody).toContain(secondQueued);
      expect(trace).toContain("event=queue_review_started");
      expect(trace).toContain("reason=post_cancel");
      expect(trace).toContain("event=queue_review_hidden");
      expect(trace).toContain("event=queue_review_committed");
      expect(trace).toContain("event=queue_review_resumed");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  for (const scenario of [
    { name: "at stable geometry", slug: "stable", resize: null },
    {
      name: "after a settled resize",
      slug: "resized",
      resize: { width: 68, height: 18 },
    },
  ]) {
    test(
      `queue resume preserves streamed scrollback ${scenario.name}`,
      async () => {
        const artifactBase = createArtifactRoot();
        const artifacts = join(artifactBase, scenario.slug);
        const home = join(artifacts, "home");
        const workspace = join(artifacts, "workspace");
        const tracePath = join(artifacts, "trace.log");
        const stderrPath = join(artifacts, "stderr.log");
        const tapePath = join(artifacts, "session.fibertape");
        mkdirSync(join(home, ".fiber"), { recursive: true });
        mkdirSync(workspace, { recursive: true });
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({
            sandbox: "none",
            permission_mode: "auto",
            permission: {},
          }),
        );

        const numberedLines = Array.from(
          { length: 24 },
          (_, index) => `QUEUE_SCROLLBACK_LINE_${String(index + 1).padStart(2, "0")}`,
        );
        const firstQueued = "QUEUE_SCROLLBACK_FIRST_PROMPT";
        const secondQueued = "QUEUE_SCROLLBACK_SECOND_PROMPT";
        const draft = "QUEUE_SCROLLBACK_DRAFT_PROMPT";
        const firstDone = "QUEUE_SCROLLBACK_FIRST_DONE";
        const secondDone = "QUEUE_SCROLLBACK_SECOND_DONE";
        const draftDone = "QUEUE_SCROLLBACK_DRAFT_DONE";
        const queuedGateway = startCodexQueue([
          codexSse([
            { type: "text-start", id: "answer_1" },
            ...numberedLines.map((line) => ({
              type: "text-delta",
              id: "answer_1",
              delta: `${line}\n`,
            })),
            { type: "text-end", id: "answer_1" },
            {
              type: "tool-call",
              toolCallId: "queue_scrollback_command",
              toolName: "shell",
              input: {
                request: {
                  action: "run",
                  yield_time_ms: 30_000,
                  timeout_ms: 600_000,
                  command: "sleep 30",
                },
              },
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ]),
          codexFinalText(firstDone),
          codexFinalText(secondDone),
          codexFinalText(draftDone),
        ]);
        gateway = queuedGateway;

        session = await TmuxSession.create({
          cwd: realpathSync(workspace),
          stderrPath,
          width: 124,
          height: 36,
          minimumHistoryLines: 2_000,
          env: seededFakeCodexEnv(home, queuedGateway, {
            FIBER_PERMISSION_MODE: "auto",
            FIBER_MODEL: MODEL,
            FIBER_RECORD: tapePath,
            FIBER_RECORD_INPUT: "1",
            FIBER_TRACE_LOG: tracePath,
            FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt,scroll",
          }),
        });

        await session.waitForComposer(TIMEOUT);
        await session.sendText("Start the queue scrollback stream.");
        await session.waitForText("Running sleep 30", TIMEOUT);
        await session.waitForText(numberedLines.at(-1)!, TIMEOUT);

        await session.sendText(firstQueued);
        await session.sendText(secondQueued);
        await session.waitForPane(
          (pane) =>
            pane.includes(queuedSummaryText(2)) &&
            !pane.includes(firstQueued) &&
            !pane.includes(secondQueued),
          TIMEOUT,
        );
        await session.sendLiteral(draft);
        await session.waitForText(draft, TIMEOUT);

        await session.sendKeys("C-o");
        await Bun.sleep(250);
        await session.sendKeys("C-o");
        await session.waitForText(draft, TIMEOUT);
        if (scenario.resize) {
          await session.resizeWindow(scenario.resize.width, scenario.resize.height);
          await session.waitForText(draft, TIMEOUT);
        }

        await session.sendKeys("C-c");
        await session.waitForPane(
          (pane) =>
            pane.includes("Cancelled sleep 30") &&
            pane.includes("paused") &&
            pane.includes("enter to send"),
          TIMEOUT,
        );
        expect(queuedGateway.requests).toHaveLength(1);

        await session.sendKeys("Enter");
        await session.waitForText(draftDone, TIMEOUT);
        await waitForCondition(
          () => queuedGateway.requests.length === 4,
          "resumed queued prompts and submitted draft",
        );

        const scrollback = await session.captureFullScrollback();
        for (const line of numberedLines) {
          expect(countOccurrences(scrollback, line)).toBe(1);
        }
        for (const text of [
          firstQueued,
          firstDone,
          secondQueued,
          secondDone,
          draft,
          draftDone,
        ]) {
          expect(countOccurrences(scrollback, text)).toBe(1);
        }
        const orderedMarkers = [
          numberedLines[0]!,
          numberedLines.at(-1)!,
          firstQueued,
          firstDone,
          secondQueued,
          secondDone,
          draft,
          draftDone,
        ];
        for (let index = 1; index < orderedMarkers.length; index += 1) {
          expect(scrollback.indexOf(orderedMarkers[index - 1]!)).toBeLessThan(
            scrollback.indexOf(orderedMarkers[index]!),
          );
        }

        expect(queuedGateway.requests[1]!.body).toContain(firstQueued);
        expect(queuedGateway.requests[2]!.body).toContain(secondQueued);
        expect(queuedGateway.requests[3]!.body).toContain(draft);

        const sessionsRoot = join(home, ".fiber", "sessions");
        let eventsPath = "";
        await waitForCondition(() => {
          if (!existsSync(sessionsRoot)) return false;
          const sessionId = readdirSync(sessionsRoot).find((entry) =>
            existsSync(join(sessionsRoot, entry, "events.jsonl"))
          );
          if (!sessionId) return false;
          eventsPath = join(sessionsRoot, sessionId, "events.jsonl");
          return readFileSync(eventsPath, "utf8").includes(draftDone);
        }, "complete queue scrollback session history");
        const events = readFileSync(eventsPath, "utf8");
        for (const marker of [...numberedLines, firstQueued, secondQueued, draft]) {
          expect(events).toContain(marker);
        }

        const trace = readFileSync(tracePath, "utf8");
        expect(
          trace.split("\n").some((line) =>
            line.includes("transcript_anchor_invalidate") &&
            line.includes("atomic_user_prompt_append")
          ),
        ).toBe(false);
        expect(readFileSync(stderrPath, "utf8")).toBe("");
        expect(existsSync(tapePath)).toBe(true);
        expect(
          execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--json"], {
            encoding: "utf8",
          }),
        ).not.toBe("");
        expect(session.isAlive()).toBe(true);
        expect(session.isPaneAlive()).toBe(true);
      },
      TIMEOUT * 3,
    );
  }

  test(
    "post-cancel hidden queue offers Escape to cancel every queued prompt",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-queued-cancel-all-")));
      const home = join(root, "home");
      const workspacePath = join(root, "workspace");
      const tracePath = join(root, "trace.log");
      const stderrPath = join(root, "stderr.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");
      const workspace = realpathSync(workspacePath);
      const hold: HoldState = { started: false, cancelled: false };
      const firstQueued = "Keep ESC_QUEUE_FIRST_SENTINEL pending.";
      const secondQueued = "Keep ESC_QUEUE_SECOND_SENTINEL pending.";
      const queuedGateway = startCodexQueue([
        () =>
          heldCodexResponse(hold, [
            { type: "text-start", id: "answer_1" },
            {
              type: "text-delta",
              id: "answer_1",
              delta: "ACTIVE_ESC_QUEUE_CANCEL_ALL_STARTED\n",
            },
          ]),
      ]);
      gateway = queuedGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, queuedGateway, {
          FIBER_MODEL: MODEL,
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt,interrupt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold the Escape cancel-all turn open.");
      await waitForCondition(
        () => queuedGateway.requests.length === 1 && hold.started,
        "held active request before Escape queue cancellation",
      );
      await session.sendText(firstQueued);
      await session.sendText(secondQueued);
      await session.waitForPane(
        (pane) =>
          pane.includes(queuedSummaryText(2)) &&
          !pane.includes(firstQueued) &&
          !pane.includes(secondQueued),
        TIMEOUT,
      );

      await session.sendKeys("C-c");
      await waitForCondition(() => hold.cancelled, "active request cancellation before queue cancel-all");
      await session.waitForPane(
        (pane) => pane.includes(secondQueued) && pane.includes("paused"),
        TIMEOUT,
      );

      await session.sendKeys("Escape");
      await session.waitForPane(
        (pane) => pane.includes("press esc to cancel all queued"),
        TIMEOUT,
      );
      expect(queuedGateway.requests).toHaveLength(1);

      await session.sendKeys("Escape");
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes(
            "event=queue_review_cancelled_all",
          ),
        "all queued prompts cancelled by Escape",
      );
      await session.waitForPane(
        (pane) =>
          !pane.includes(firstQueued) &&
          !pane.includes(secondQueued) &&
          !pane.includes("press esc to cancel all queued"),
        TIMEOUT,
      );
      await Bun.sleep(250);

      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain("event=queued_prompts_cleared");
      expect(queuedGateway.requests).toHaveLength(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(session.isAlive()).toBe(true);
      expect(session.isPaneAlive()).toBe(true);
    },
    TIMEOUT * 2,
  );

  test(
    "second Ctrl+C exits after active stream cancellation",
    async () => {
      const artifacts = createArtifactRoot();
      const home = join(artifacts, "home");
      const workspace = join(artifacts, "workspace");
      const stderrPath = join(artifacts, "stderr.log");
      const tracePath = join(artifacts, "trace.log");
      const tapePath = join(artifacts, "session.fibertape");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(home, ".fiber", "settings.json"), "{}");

      const hold: HoldState = { started: false, cancelled: false };
      const heldGateway = startCodexQueue([
        () => heldCodexResponse(hold),
      ]);
      gateway = heldGateway;
      session = await TmuxSession.create({
        cwd: realpathSync(workspace),
        remainOnExit: true,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, heldGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "gateway,app,input,interrupt,worker,sse",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText(
        "Write a slow long response in 120 numbered short lines. Start immediately and do not use tools.",
      );
      await waitForCondition(
        () => heldGateway.requests.length === 1 && hold.started,
        "held active stream",
      );
      await session.waitForText("Thinking", TIMEOUT);

      await session.sendKeys("C-c");
      const afterFirst = await session.waitForText("cancelled", TIMEOUT);
      await waitForCondition(() => hold.cancelled, "stream cancellation");
      expect(afterFirst).toContain("cancelled");
      expect(session.isPaneAlive()).toBe(true);

      const scrollbackAfterFirst = await session.captureFullScrollbackEscapes();
      expect(countOccurrences(scrollbackAfterFirst, "cancelled")).toBe(1);

      await session.sendKeys("C-c");
      await waitForCondition(
        () => !session!.isPaneAlive(),
        "pane exit after second Ctrl+C",
        3_000,
      );

      const scrollback = await session.captureFullScrollback();
      const trace = readFileSync(tracePath, "utf8");
      expect(scrollback).toContain("cancelled");
      expect(countOccurrences(scrollback, "cancelled")).toBe(1);
      expect(countOccurrences(trace, "source=input_active_stream")).toBe(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(tapePath)).toBe(true);
      expect(
        execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--json"], {
          encoding: "utf8",
        }),
      ).not.toBe("");
    },
    TIMEOUT,
  );

  test(
    "Ctrl+C exit hint disarms for history recall, bare Escape, and idle expiry",
    async () => {
      const artifacts = createArtifactRoot();
      const home = join(artifacts, "home");
      const workspace = join(artifacts, "workspace");
      const stderrPath = join(artifacts, "stderr.log");
      const tracePath = join(artifacts, "trace.log");
      const tapePath = join(artifacts, "session.fibertape");
      const prompt = "Recall CTRL_C_EXIT_HISTORY_SENTINEL exactly.";
      const finalText = "CTRL_C_EXIT_HISTORY_DONE";
      const exitHint = "press ctrl+c again to exit";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        '{"prompt_history":{"enabled":true}}',
      );

      const ctrlCGateway = startCodexQueue([
        codexFinalText(finalText),
      ]);
      gateway = ctrlCGateway;
      session = await TmuxSession.create({
        cwd: realpathSync(workspace),
        remainOnExit: true,
        stderrPath,
        width: 120,
        height: 40,
        env: seededFakeCodexEnv(home, ctrlCGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
          FIBER_TRACE_LOG: tracePath,
          FIBER_TRACE_SCOPES: "agent,gateway,stream,worker,input,prompt",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText(prompt);
      await session.waitForText(finalText, TIMEOUT);
      await waitForCondition(
        () =>
          existsSync(tracePath) &&
          readFileSync(tracePath, "utf8").includes("event=prompt_finish"),
        "completed prompt before Ctrl+C history recall",
      );

      await session.sendKeys("C-c");
      await session.waitForText(exitHint, TIMEOUT);
      await session.sendKeys("Up");
      const recalledPane = await session.waitForPane(
        (pane) => countOccurrences(pane, prompt) >= 2 && !pane.includes(exitHint),
        TIMEOUT,
      );
      expect(countOccurrences(recalledPane, prompt)).toBeGreaterThanOrEqual(2);
      expect(session.isPaneAlive()).toBe(true);

      await session.sendKeys("C-c");
      const rearmedPane = await session.waitForPane(
        (pane) =>
          countOccurrences(pane, prompt) === 1 &&
          pane.split("\n").some(isEmptyComposerLine) &&
          pane.includes(exitHint),
        TIMEOUT,
      );
      expect(rearmedPane).toContain(exitHint);
      expect(session.isPaneAlive()).toBe(true);

      await session.waitForPane(
        (pane) => !pane.includes(exitHint),
        5_000,
      );
      expect(session.isPaneAlive()).toBe(true);

      await session.sendKeys("C-c");
      await session.waitForText(exitHint, TIMEOUT);
      expect(session.isPaneAlive()).toBe(true);

      const semanticDisarm =
        "event=ctrl_c_exit_disarmed reason=semantic_action";
      const semanticDisarmsBeforeEscape = countOccurrences(
        readFileSync(tracePath, "utf8"),
        semanticDisarm,
      );
      await session.sendKeys("Escape");
      await waitForCondition(
        () =>
          countOccurrences(
            readFileSync(tracePath, "utf8"),
            semanticDisarm,
          ) === semanticDisarmsBeforeEscape + 1,
        "bare Escape semantic disarm",
        1_000,
      );
      await session.waitForPane((pane) => !pane.includes(exitHint), 1_000);
      expect(session.isPaneAlive()).toBe(true);

      await session.sendKeys("C-c");
      await session.waitForText(exitHint, TIMEOUT);
      expect(session.isPaneAlive()).toBe(true);

      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain(semanticDisarm);
      expect(trace).toContain("event=ctrl_c_exit_disarmed reason=timeout");

      await session.sendKeys("C-c");
      await waitForCondition(
        () => !session!.isPaneAlive(),
        "pane exit after valid second Ctrl+C",
        3_000,
      );

      expect(ctrlCGateway.requests).toHaveLength(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(existsSync(tapePath)).toBe(true);
      expect(
        execFileSync(FIBER_BIN, ["debug", "replay", tapePath, "--json"], {
          encoding: "utf8",
        }),
      ).not.toBe("");
    },
    TIMEOUT,
  );

  test(
    "canonical interleaved tool streams preserve ordering and lifecycle identity",
    async () => {
      const stage = lifecycleStage();
      const observed = await runCanonicalLifecycleFixture(stage);
      const normalizedPane = normalizedPaneText(observed.pane);

      expect(observed.fixtureSha256).toBe(CANONICAL_A_B_SHA256);
      expect(observed.wrapperAliveAtCapture).toBe(true);
      expect(observed.childAliveAtCapture).toBe(false);
      expect(observed.wrapperStatus).toBe(0);
      expect(observed.sttyAfter).toBe(observed.sttyBefore);

      if (stage === "baseline-silent" || stage === "fatal-reported") {
        expect(observed.childStatus).toBe(1);
        expect(observed.requestCount).toBe(1);
        expect(countTraceEvent(observed.trace, "before_tool_execution")).toBe(0);
        expect(observed.trace).toContain("LifecycleReconciliationCollision");
        expect(observed.pane).toContain("● Reading");
        expect(observed.pane).toContain(`Searching ${CANONICAL_GREP_PATTERN}`);
        expect(normalizedPane).not.toContain(CANONICAL_PRE_TOOL_TEXT);
        expect(observed.stderr).toBe(
          stage === "baseline-silent"
            ? ""
            : "fiber: LifecycleReconciliationCollision\n",
        );
        return;
      }

      expect(observed.reachedFinal).toBe(true);
      expect(observed.helpVisible).toBe(true);
      expect(observed.childStatus).toBe(0);
      expect(observed.requestCount).toBe(2);
      expect(observed.requestCountAfterHelp).toBe(2);
      expect(observed.stderr).toBe("");
      expect(observed.trace).not.toContain("LifecycleReconciliationCollision");
      if (stage === "corrected") {
        expect(
          countOccurrences(normalizedPane, CANONICAL_PRE_TOOL_TEXT),
        ).toBe(1);
        expect(normalizedPane.indexOf(CANONICAL_PRE_TOOL_TEXT)).toBeLessThan(
          normalizedPane.indexOf(CANONICAL_READ_PATH),
        );
        expect(normalizedPane.indexOf(CANONICAL_PRE_TOOL_TEXT)).toBeLessThan(
          normalizedPane.indexOf(CANONICAL_GREP_PATTERN),
        );
      }
      expect(
        countOccurrences(normalizedPane, `├ Read ${CANONICAL_READ_PATH}`),
      ).toBe(1);
      expect(
        countOccurrences(
          normalizedPane,
          `└ Searched ${CANONICAL_GREP_PATTERN}`,
        ),
      ).toBe(1);
      expect(countOccurrences(normalizedPane, CANONICAL_FINAL_TEXT)).toBe(1);

      const resultIds = collectToolResultIds(observed.parsedRequests[1]).sort();
      expect(resultIds).toEqual(["grep_b", "read_a"]);
      expect(
        collectTypedToolResults(observed.parsedRequests[1]).sort((a, b) =>
          a.toolCallId.localeCompare(b.toolCallId)
        ),
      ).toEqual([
        {
          toolCallId: "grep_b",
          toolName: "grep_files",
          outputType: "text",
        },
        {
          toolCallId: "read_a",
          toolName: "read_file",
          outputType: "text",
        },
      ]);
      expect(countTraceEvent(observed.trace, "before_tool_execution", "read_a"))
        .toBe(1);
      expect(countTraceEvent(observed.trace, "before_tool_execution", "grep_b"))
        .toBe(1);
      for (
        const sentinel of [
          "FIBER_MODEL_TEXT_SENTINEL",
          "FIBER_FINAL_RESPONSE_SENTINEL",
          "FIBER_PATH_SENTINEL",
          "FIBER_PATTERN_SENTINEL",
        ]
      ) {
        expect(observed.trace).not.toContain(sentinel);
      }
    },
    60_000,
  );

  test(
    "parallel read lifecycle updates preserve current grouped scrollback",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-status-scrollback-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const pre_tool_lines = Array.from(
        { length: 10 },
        (_, index) => `SCROLL_PRE_${String(index + 1).padStart(2, "0")}`,
      );
      const final_text = "SCROLLBACK_FINAL_SENTINEL";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({}),
      );
      writeFileSync(join(workspace, "one.txt"), "first fixture\n");
      writeFileSync(join(workspace, "two.txt"), "second fixture\n");

      const scrollback_gateway = startCodexQueue([
        codexSse([
          { type: "text-start", id: "scrollback_text" },
          {
            type: "text-delta",
            id: "scrollback_text",
            delta: `${pre_tool_lines.slice(0, 5).join("\n")}\n`,
          },
          {
            type: "text-delta",
            id: "scrollback_text",
            delta: `${pre_tool_lines.slice(5).join("\n")}\n`,
          },
          { type: "text-end", id: "scrollback_text" },
          {
            type: "tool-call",
            toolCallId: "scrollback_read_one",
            toolName: "read_file",
            input: { path: "one.txt" },
          },
          {
            type: "tool-call",
            toolCallId: "scrollback_read_two",
            toolName: "read_file",
            input: { path: "two.txt" },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        codexFinalText(final_text),
      ]);
      gateway = scrollback_gateway;
      session = await TmuxSession.create({
        cwd: workspace,
        width: 64,
        height: 16,
        minimumHistoryLines: 200,
        stderrPath,
        env: seededFakeCodexEnv(home, scrollback_gateway, {
          FIBER_PERMISSION_MODE: "auto",
          FIBER_MODEL: MODEL,
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Read both fixtures.");
      await session.waitForText(final_text, TIMEOUT);
      await Bun.sleep(250);
      const scrollback = await session.captureFullScrollback();

      let previous_index = -1;
      for (const line of pre_tool_lines) {
        expect(countOccurrences(scrollback, line)).toBe(1);
        const line_index = scrollback.indexOf(line);
        expect(line_index).toBeGreaterThan(previous_index);
        previous_index = line_index;
      }
      expect(scrollback).toContain("├ Read one.txt");
      expect(scrollback).toContain("└ Read two.txt");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "launch-row release preserves complete history during a large table append",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-launch-history-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const tapePath = join(root, "launch-history.fibertape");
      const prefillMarkers = Array.from(
        { length: 5_000 },
        (_, index) =>
          `PREFILL_HISTORY_ROW_${String(index + 1).padStart(4, "0")}`,
      );
      const tableMarkers = Array.from(
        { length: 27 },
        (_, index) => `TABLE_HISTORY_ROW_${String(index + 1).padStart(2, "0")}`,
      );
      const intro = "TABLE_HISTORY_INTRO";
      const tail = "TABLE_HISTORY_TAIL";
      const response = [
        intro,
        "",
        "| Document | Author |",
        "| --- | --- |",
        ...tableMarkers.map((marker) => `| ${marker}.md | Walter |`),
        "",
        tail,
      ].join("\n");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(workspace, "docs"), { recursive: true });
      for (let index = 1; index <= 27; index += 1) {
        writeFileSync(
          join(workspace, "docs", `source-${String(index).padStart(2, "0")}.md`),
          `source row ${index}\n`,
        );
      }
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({
          sandbox: "none",
          permission_mode: "yolo",
          permission: {},
          startup_scrollback: false,
          statusLine: { context: true },
          yolo_acknowledged: true,
        }),
      );
      writeFileSync(stderrPath, "");

      const tableGateway = startCodexQueue([
        codexSerializedToolCall(
          "launch-history-list",
          "glob_files",
          JSON.stringify({ pattern: "*", path: "." }),
          "I'll inspect the docs and determine their authorship.",
        ),
        codexSerializedToolCall(
          "launch-history-command",
          "shell",
          JSON.stringify({
            request: {
              action: "run",
              yield_time_ms: 30_000,
              timeout_ms: 600_000,
              command:
                "for i in $(seq -w 1 27); do printf 'docs/source-%s.md\\tWalter (1)\\n' \"$i\"; done",
            },
          }),
        ),
        codexFinalText(response),
      ]);
      gateway = tableGateway;
      const launchScript = [
        `i=1; while [ "$i" -le ${prefillMarkers.length} ]; do printf "PREFILL_HISTORY_ROW_%04d\\n" "$i"; i=$((i + 1)); done`,
        `exec ${FIBER_BIN}`,
      ].join("; ");
      session = await TmuxSession.create({
        cmd: `/bin/sh -c '${launchScript}'`,
        cwd: workspace,
        width: 210,
        height: 60,
        minimumHistoryLines: 10_000,
        stderrPath,
        env: seededFakeCodexEnv(home, tableGateway, {
          FIBER_MODEL: MODEL,
          FIBER_RECORD: tapePath,
          FIBER_RECORD_INPUT: "1",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Render the launch-history table.");
      await session.waitForText(tail, TIMEOUT);
      await session.waitForPane(hasEmptyComposer, TIMEOUT);
      await Bun.sleep(100);

      const scrollback = await session.captureFullScrollback();
      const escapedScrollback = await session.captureFullScrollbackEscapes();
      let previousIndex = -1;
      for (const marker of [...prefillMarkers, intro, ...tableMarkers, tail]) {
        expect(countOccurrences(scrollback, marker)).toBe(1);
        const index = scrollback.indexOf(marker);
        expect(index).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      const introIndex = scrollback.indexOf(intro);
      const firstTableIndex = scrollback.indexOf(tableMarkers[0]!);
      expect(scrollback.slice(introIndex, firstTableIndex)).not.toMatch(
        /(?:Thinking \(|\(↑\d)/,
      );
      expect(escapedScrollback).toContain(prefillMarkers[0]!);
      expect(escapedScrollback).toContain(tableMarkers.at(-1)!);
      expect(existsSync(tapePath)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test(
    "dynamic MCP approval shows exact arguments and preserves deny once and session scope",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-mcp-approval-")));
      const dynamicToolName = "mcp_fixture_echo";
      const argumentSentinel = "FXC194_ARGUMENT_SENTINEL";
      const secondArgumentSentinel = "FXC194_SECOND_ARGUMENT_SENTINEL";
      for (const decision of ["deny", "allow", "session"] as const) {
        const runRoot = join(root, decision);
        const home = join(runRoot, "home");
        const workspace = join(runRoot, "workspace");
        const stderrPath = join(runRoot, "stderr.log");
        mkdirSync(join(home, ".fiber"), { recursive: true });
        mkdirSync(workspace, { recursive: true });
        writeFileSync(
          join(home, ".fiber", "settings.json"),
          JSON.stringify({}),
        );
        const fixture = writeDelayedMcpFixture(runRoot, home, 0);
        const finalText = `FXC194_${decision.toUpperCase()}_COMPLETE`;
        const mcpGateway = startCodexQueue([
          codexSse([
            {
              type: "tool-call",
              toolCallId: `select_approval_mcp_${decision}`,
              toolName: "mcp_select_tool",
              input: { name: dynamicToolName },
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ]),
          codexSse([
            {
              type: "tool-call",
              toolCallId: `call_approval_mcp_${decision}`,
              toolName: dynamicToolName,
              input: { text: argumentSentinel },
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            },
          ]),
          ...(decision === "session"
            ? [codexSse([
              {
                type: "tool-call",
                toolCallId: "call_approval_mcp_session_second",
                toolName: dynamicToolName,
                input: { text: secondArgumentSentinel },
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
              },
            ])]
            : []),
          codexFinalText(finalText),
        ]);
        gateway = mcpGateway;

        try {
          session = await TmuxSession.create({
            cwd: workspace,
            width: 100,
            height: 28,
            stderrPath,
            env: seededFakeCodexEnv(home, mcpGateway, {
              FIBER_PERMISSION_MODE: "ask",
              FIBER_MODEL: MODEL,
            }),
          });

          await session.waitForComposer(TIMEOUT);
          await session.sendText("Run the MCP fixture with the exact sentinel.");
          const approval = await session.waitForText(
            "Allow this MCP tool call?",
            TIMEOUT,
          );
          expect(approval).toContain("MCP tool");
          expect(approval).toContain("Arguments for this request");
          expect(approval).toContain("Allow once");
          expect(approval).toContain("Allow this MCP tool for this session");
          expect(approval).toContain("Deny");
          expect(approval).toContain(dynamicToolName);
          expect(approval).toContain(`{"text":"${argumentSentinel}"}`);
          expect(existsSync(fixture.callStartedPath)).toBe(false);

          await session.sendLiteralText(
            decision === "deny" ? "3" : decision === "session" ? "2" : "1",
          );
          await session.waitForText(finalText, TIMEOUT);
          if (decision === "deny") {
            expect(existsSync(fixture.callStartedPath)).toBe(false);
          } else {
            const calls = readDelayedMcpCalls(fixture.callStartedPath);
            expect(calls).toHaveLength(decision === "session" ? 2 : 1);
            expect(calls[0]?.arguments).toEqual({ text: argumentSentinel });
            if (decision === "session") {
              expect(calls[1]?.arguments).toEqual({ text: secondArgumentSentinel });
            }
          }
          expect(readFileSync(stderrPath, "utf8")).toBe("");
        } finally {
          await session?.kill();
          session = null;
          mcpGateway.stop();
          gateway = null;
        }
      }
    },
    90_000,
  );

  test(
    "dynamic MCP approval ellipsizes overlong arguments in a narrow terminal",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-narrow-mcp-approval-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const dynamicToolName = "mcp_fixture_echo";
      const argumentTail = "FXC194_OVERLONG_TAIL";
      const overlongText = `FXC194_OVERLONG_HEAD_${"x".repeat(5_000)}\u001b[31m${argumentTail}`;
      const finalText = "FXC194_NARROW_DENY_COMPLETE";
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({}),
      );
      const fixture = writeDelayedMcpFixture(root, home, 0);
      const mcpGateway = startCodexQueue([
        codexSse([
          {
            type: "tool-call",
            toolCallId: "select_narrow_approval_mcp",
            toolName: "mcp_select_tool",
            input: { name: dynamicToolName },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        codexSse([
          {
            type: "tool-call",
            toolCallId: "call_narrow_approval_mcp",
            toolName: dynamicToolName,
            input: { text: overlongText },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        codexFinalText(finalText),
      ]);
      gateway = mcpGateway;

      session = await TmuxSession.create({
        cwd: workspace,
        width: 44,
        height: 28,
        stderrPath,
        env: seededFakeCodexEnv(home, mcpGateway, {
          FIBER_PERMISSION_MODE: "ask",
          FIBER_MODEL: MODEL,
          FIBER_SOUND: "0",
        }),
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Run the MCP fixture with overlong arguments.");
      const approval = await session.waitForText(
        "Allow this MCP tool call?",
        TIMEOUT,
      );
      expect(approval).toContain(dynamicToolName);
      expect(approval).toContain("FXC194_OVER");
      expect(approval).toContain("…");
      expect(approval).not.toContain(argumentTail);
      expect(approval.split("\n").every((line) => [...line].length <= 44)).toBe(true);
      expect(existsSync(fixture.callStartedPath)).toBe(false);

      await session.sendLiteralText("3");
      await session.waitForText(finalText, TIMEOUT);
      expect(readDelayedMcpCalls(fixture.callStartedPath)).toHaveLength(0);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    60_000,
  );

  test(
    "current compact view keeps unsupported tool failures visible with supported calls",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-unsupported-tool-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const stderrPath = join(root, "stderr.log");
      const resumedStderrPath = join(root, "resumed-stderr.log");
      const tracePath = join(root, "fiber-trace.log");
      const tapePath = join(root, "session.fibertape");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({}),
      );

      const unsupportedCallId = "unsupported_compat_call";
      const unsupportedToolName = "mcp__filesystem__read_text_file";
      const supportedCallId = "supported_after_unknown";
      const supportedCommand = "printf SUPPORTED_AFTER_UNKNOWN";
      const finalText = "UNSUPPORTED_TOOL_PROBE_FINAL";
      const unsupportedGateway = startCodexQueue([
        codexSse([
          {
            type: "tool-call",
            toolCallId: unsupportedCallId,
            toolName: unsupportedToolName,
            input: { path: "README.md" },
          },
          {
            type: "tool-call",
            toolCallId: supportedCallId,
            toolName: "shell",
            input: { request: { action: "run", yield_time_ms: 30_000, timeout_ms: 600_000, command: supportedCommand } },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        codexFinalText(finalText),
      ]);
      gateway = unsupportedGateway;

      const gatewayEnv = seededFakeCodexEnv(home, unsupportedGateway, {
        FIBER_PERMISSION_MODE: "auto",
        FIBER_MODEL: MODEL,
        FIBER_TRACE_LOG: tracePath,
        FIBER_TRACE_SCOPES: "tool",
      });
      session = await TmuxSession.create({
        cwd: workspace,
        width: 100,
        height: 30,
        stderrPath,
        env: {
          ...gatewayEnv,
          FIBER_RECORD: tapePath,
        },
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Run the supported call after the unknown call.");
      await session.waitForText(finalText, TIMEOUT);
      const header = "● 2 tool calls · 2 commands · 1 failed";
      const failedRow = `├ Failed ${unsupportedToolName}`;
      const completedRow = `└ Ran ${supportedCommand}`;
      const compact = await session.captureFullScrollback();
      expect(compact).toContain(`${header}\n${failedRow}\n${completedRow}`);
      expect(countOccurrences(compact, `Failed ${unsupportedToolName}`)).toBe(1);
      expect(countOccurrences(compact, `Ran ${supportedCommand}`)).toBe(1);
      expect(compact).not.toContain(`Running ${unsupportedToolName}`);

      await session.resizeWindow(72, 24);
      const resized = await session.waitForText(header, TIMEOUT);
      expect(resized).toContain(`Failed ${unsupportedToolName}`);
      expect(resized).toContain(`Ran ${supportedCommand}`);

      await session.sendKeys("C-o");
      const full = await session.waitForText(
        `├ Failed ${unsupportedToolName}`,
        TIMEOUT,
      );
      expect(full).toContain(`├ Failed ${unsupportedToolName}`);
      expect(full).toContain(`└ Ran ${supportedCommand}`);
      expect(countOccurrences(full, `Failed ${unsupportedToolName}`)).toBe(1);
      expect(countOccurrences(full, `Ran ${supportedCommand}`)).toBe(1);
      await session.sendKeys("C-o");
      await session.waitForText(header, TIMEOUT);
      expect(unsupportedGateway.requests).toHaveLength(2);
      expect(
        countOccurrences(
          unsupportedGateway.requests[1].body,
          `Unsupported tool: ${unsupportedToolName}`,
        ),
      ).toBe(1);
      const trace = readFileSync(tracePath, "utf8");
      expect(trace).toContain(
        `event=execution_result turn_id=1 step_id=1 call_id=${unsupportedCallId} name=${unsupportedToolName} result_kind=unsupported`,
      );
      expect(
        trace.split("\n").some((line) =>
          line.includes("event=execution_start") &&
          line.includes(`call_id=${unsupportedCallId}`)
        ),
      ).toBe(false);
      expect(trace).toContain(
        `event=execution_start turn_id=1 step_id=1 call_id=${supportedCallId} name=shell`,
      );
      expect(existsSync(tapePath)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await session.sendText("/quit");
      expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
      await session.kill();
      session = null;

      session = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: workspace,
        width: 100,
        height: 30,
        stderrPath: resumedStderrPath,
        env: gatewayEnv,
      });
      await session.waitForText(finalText, TIMEOUT);
      const resumed = await session.capturePane();
      expect(resumed).toContain(`${header}\n${failedRow}\n${completedRow}`);
      expect(countOccurrences(resumed, `Failed ${unsupportedToolName}`)).toBe(1);
      expect(countOccurrences(resumed, `Ran ${supportedCommand}`)).toBe(1);
      expect(unsupportedGateway.requests).toHaveLength(2);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );

  test(
    "current compact command summaries hide no-op cwd prefixes and abbreviate the active workspace path",
    async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "fiber-tui-command-summary-")));
      const home = join(root, "home");
      const workspace = join(
        root,
        "Users",
        "jeffsee",
        "code",
        "worktrees",
        "vercel",
        "smart-spruce",
      );
      const nested = join(
        workspace,
        "vercel",
        "packages",
        "cli",
        "test",
        "fixtures",
        "unit",
        "commands",
        "git",
        "connect",
        "unlink",
      );
      const stderrPath = join(root, "stderr.log");
      const resumedStderrPath = join(root, "resumed-stderr.log");
      const tracePath = join(root, "fiber-trace.log");
      mkdirSync(join(home, ".fiber"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(home, ".fiber", "settings.json"),
        JSON.stringify({}),
      );

      const firstCommand = "cd . && printf TOOL_SUMMARY_FIRST_COMMAND";
      const firstDisplayCommand = "printf TOOL_SUMMARY_FIRST_COMMAND";
      const nestedCommand = `cd ${nested} && pwd`;
      const thirdCommand = "printf TOOL_SUMMARY_THIRD_COMMAND";
      const finalText = "TOOL_SUMMARY_FINAL";
      const summaryGateway = startCodexQueue([
        codexSse([
          {
            type: "tool-call",
            toolCallId: "tool_summary_first",
            toolName: "shell",
            input: { request: { action: "run", yield_time_ms: 30_000, timeout_ms: 600_000, command: firstCommand } },
          },
          {
            type: "tool-call",
            toolCallId: "tool_summary_nested",
            toolName: "shell",
            input: { request: { action: "run", yield_time_ms: 30_000, timeout_ms: 600_000, command: nestedCommand } },
          },
          {
            type: "tool-call",
            toolCallId: "tool_summary_third",
            toolName: "shell",
            input: { request: { action: "run", yield_time_ms: 30_000, timeout_ms: 600_000, command: thirdCommand } },
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
          },
        ]),
        codexFinalText(finalText),
      ]);
      gateway = summaryGateway;

      const gatewayEnv = seededFakeCodexEnv(home, summaryGateway, {
        FIBER_PERMISSION_MODE: "auto",
        FIBER_MODEL: MODEL,
        FIBER_TRACE_LOG: tracePath,
        FIBER_TRACE_SCOPES: "tool",
      });
      const withoutWorkspaceStatusline = (text: string): string =>
        text.split("\n").filter((line) =>
          !(line.includes(workspace) && line.includes(" · "))
        ).join("\n");

      session = await TmuxSession.create({
        cwd: workspace,
        width: 120,
        height: 30,
        stderrPath,
        env: gatewayEnv,
      });

      await session.waitForComposer(TIMEOUT);
      await session.sendText("Run the prepared command summary fixture.");
      await session.waitForText(finalText, TIMEOUT);

      const compact = await session.captureFullScrollback();
      expect(compact).toContain("● 3 tool calls · 3 commands");
      expect(compact).toContain(
        "Ran cd ./vercel/packages/cli/test/fixtures/unit/commands/git/connect/unlink && pwd",
      );
      expect(withoutWorkspaceStatusline(compact)).not.toContain(workspace);
      expect(countOccurrences(compact, `Ran ${firstDisplayCommand}`)).toBe(1);
      expect(compact).not.toContain(`Ran ${firstCommand}`);
      expect(countOccurrences(compact, `Ran ${thirdCommand}`)).toBe(1);

      await session.resizeWindow(80, 24);
      await session.waitForText("● 3 tool calls · 3 commands", TIMEOUT);
      await session.sendKeys("C-o");
      const fullAtTail = await session.waitForText(finalText, TIMEOUT);
      let fullAtNested = fullAtTail;
      for (let page = 0; page < 10 && !fullAtNested.includes(
        "├ Ran cd ./vercel/packages/cli/test/fixtures/unit/commands/git/connect/unlink",
      ); page += 1) {
        await session.sendKeys("PPage");
        fullAtNested = await session.capturePane();
      }
      expect(fullAtNested).toContain(
        "├ Ran cd ./vercel/packages/cli/test/fixtures/unit/commands/git/connect/unlink",
      );
      expect(fullAtTail).toContain(`└ Ran ${thirdCommand}`);
      expect(withoutWorkspaceStatusline(fullAtTail)).not.toContain(workspace);

      for (let page = 0; page < 10; page += 1) {
        await session.sendKeys("PPage");
      }
      const fullAtFirst = await session.waitForText(firstDisplayCommand, TIMEOUT);
      expect(fullAtFirst).toContain(`├ Ran ${firstDisplayCommand}`);
      expect(fullAtFirst).not.toContain(`Ran ${firstCommand}`);
      expect(withoutWorkspaceStatusline(fullAtFirst)).not.toContain(workspace);

      const trace = readFileSync(tracePath, "utf8");
      for (const callId of [
        "tool_summary_first",
        "tool_summary_nested",
        "tool_summary_third",
      ]) {
        expect(
          countOccurrences(trace, `event=execution_start turn_id=1 step_id=1 call_id=${callId}`),
        ).toBe(1);
        expect(
          countOccurrences(trace, `event=execution_result turn_id=1 step_id=1 call_id=${callId}`),
        ).toBe(1);
      }
      expect(summaryGateway.requests).toHaveLength(2);
      expect(readFileSync(stderrPath, "utf8")).toBe("");

      await session.sendKeys("C-o");
      await session.waitForText("● 3 tool calls · 3 commands", TIMEOUT);
      await session.sendText("/quit");
      expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
      await session.kill();
      session = null;

      session = await TmuxSession.create({
        cmd: `${FIBER_BIN} continue`,
        cwd: workspace,
        width: 120,
        height: 30,
        stderrPath: resumedStderrPath,
        env: gatewayEnv,
      });
      await session.waitForText(finalText, TIMEOUT);
      const resumed = await session.captureFullScrollback();
      expect(resumed).toContain("● 3 tool calls · 3 commands");
      expect(resumed).toContain(
        "Ran cd ./vercel/packages/cli/test/fixtures/unit/commands/git/connect/unlink && pwd",
      );
      expect(resumed).toContain(`Ran ${firstDisplayCommand}`);
      expect(resumed).not.toContain(`Ran ${firstCommand}`);
      expect(withoutWorkspaceStatusline(resumed)).not.toContain(workspace);
      expect(summaryGateway.requests).toHaveLength(2);
      expect(readFileSync(resumedStderrPath, "utf8")).toBe("");
    },
    TIMEOUT * 2,
  );
});
