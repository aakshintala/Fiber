# Event stream and stdin protocol prior art

Survey of how pi RPC mode, Claude Code `stream-json`, and Codex `exec --json` plus `app-server` shape machine-readable event streams and stdin command channels. Filed against [aakshintala/Fiber#148](https://github.com/aakshintala/Fiber/issues/148). Fiber already persists a durable `events.jsonl` log (`src/core/session/session_event.zig`). That log is not a live embed protocol. This note is about designing Fiber's versioned JSONL event stream and stdin command channel.

Versions read: pi-coding-agent 0.85.1 at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`; Claude Code 2.1.270 (`claude --version`); Codex CLI 0.154.0 (`codex --version`). Codex GitHub paths are `openai/codex` `main` as fetched on 14 September 2026.

## Summary

1. Treat the durable session log, the live event stream, and the stdin command channel as three contracts. Pi's RPC stdout is live events plus command responses, while the session file is a different tree of entries (`docs/rpc.md`, `docs/session-format.md`). Claude's stdout is not the session `.jsonl` file, and that mismatch produced duplicate history writes ([anthropics/claude-code#5034](https://github.com/anthropics/claude-code/issues/5034)). Codex `exec --json` is a lossy projection of app-server items (`codex-rs/exec/src/event_processor_with_jsonl_output.rs`). Fiber should not pretend stdout lines equal persisted lines unless it designs one log for both.

2. Put a type discriminator and correlation ids on every line. Claude puts `type`, `uuid`, and `session_id` on most SDK messages ([TypeScript SDK message types](https://code.claude.com/docs/en/agent-sdk/typescript)). Codex app-server uses JSON-RPC `method` plus `id` for requests and `threadId`/`turnId`/`itemId` on notifications ([app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)). Pi RPC events often carry only `type` (`docs/rpc.md` lines 855 to 883). Missing request ids hung pi clients ([earendil-works/pi#5868](https://github.com/earendil-works/pi/issues/5868)).

3. Advertise capabilities, do not sniff version strings. Claude's `system/init` `capabilities` array is an open set: ignore unknown values ([headless docs](https://code.claude.com/docs/en/headless), [SDKSystemMessage](https://code.claude.com/docs/en/agent-sdk/typescript)). Codex matches schema dumps to the binary you generated (`codex app-server generate-json-schema`). Pi versions the session file (`version: 3`) but not the RPC event wire (`docs/session-format.md`, `docs/rpc.md`). Silent format replacement is what Codex did when `--json` became `--experimental-json` ([openai/codex#4525](https://github.com/openai/codex/pull/4525), [openai/codex#5028](https://github.com/openai/codex/issues/5028)).

4. Stream deltas; treat the completed message or item as authoritative. Pi had to drop cumulative `message` snapshots from `message_update` because they grew quadratically ([CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md) citing [#7290](https://github.com/earendil-works/pi/issues/7290)). Claude wraps raw Anthropic `content_block_delta` events and still emits a complete `assistant` message per content block ([streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)). Codex app-server does `item/started` then item-specific deltas then `item/completed`.

5. Keep two tool identities: a harness-stable item or call id, and the provider `tool_use` / `call_id`. Pi passes the provider id through, then rewrites it when talking to another API (`pi-ai` `normalizeToolCallId` in `anthropic-messages.js` and `openai-responses-shared.js`). Claude uses Anthropic `tool_use.id` and joins subagents with `parent_tool_use_id`. Codex exec remints `item_N` and maps away the app-server item id (`event_processor_with_jsonl_output.rs` `started_item_id`).

6. Build a real stdin command channel with acknowledgements. `codex exec --json` reads a prompt from stdin and has no steer, cancel, or permission reply (`codex exec --help`). Claude and Codex app-server overlay request/response on the same JSONL: Claude `control_request` / `control_response` with `request_id`; Codex JSON-RPC requests that the client must answer. Permission and elicitation replies must echo that request id. A missing reply can block the turn forever (Claude `canUseTool` docs: permission prompts do not time out).

7. Tag child work on the same stream. Claude inlines subagent messages with `parent_tool_use_id`, and text forwarding is opt-in (`--forward-subagent-text`, Claude Code v2.1.211+, nested depth from v2.1.219). Codex app-server uses `collabToolCall` and `subAgentActivity` items plus child `threadId`s. Pi has no built-in subagents ([README philosophy](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md)).

8. Type tool outcomes as structured status, not only error strings. Codex `commandExecution.status` is `inProgress` | `completed` | `failed` | `declined` plus optional `exitCode`. Claude `BashOutput` has `interrupted` and timeout fields but no numeric `exit_code` in the published SDK type. Pi bash tool throws on non-zero exit, which becomes `isError: true` on `tool_execution_end`. Fiber should keep exit code, signal or abort, and error flag as separate fields.

## Pi RPC mode

Local sources: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`, `docs/json.md`, `docs/session-format.md`, `dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/rpc-mode.js`. Official copies live under [earendil-works/pi packages/coding-agent](https://github.com/earendil-works/pi).

Start with `pi --mode rpc`. Framing is strict LF JSONL. Split on `\n` only. Node `readline` is not compliant because it also splits on U+2028 and U+2029 (`docs/rpc.md` lines 28 to 37; CHANGELOG for [#1911](https://github.com/badlogic/pi-mono/issues/1911)).

### Envelope fields

There is no common envelope on every line.

- Commands on stdin: `type` plus optional `id` (`rpc-types.d.ts` `RpcCommand`).
- Command replies: `type: "response"`, `command`, `success`, optional `id`, `data`, or `error` (`rpc-types.d.ts` `RpcResponse`; `rpc-mode.js` lines 31 to 38).
- Agent events: `type` only in most cases. Docs say events do not generally include `id`. The exception is `bash_execution_update`, which echoes the originating `bash` command `id` (`docs/rpc.md` lines 855 to 857).
- No event-level timestamp, session id, or schema version on the RPC wire. Session id appears only if the client calls `get_state` (`docs/rpc.md` `get_state`). Message objects inside events can carry `timestamp` Unix milliseconds (`docs/rpc.md` UserMessage / AssistantMessage examples).
- JSON print mode (`pi --mode json`) emits a session header as the first stdout line: `{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}` (`docs/json.md` lines 69 to 73). RPC mode documentation does not describe that header on stdout. UNVERIFIED whether RPC emits it.

### Event taxonomy

From `docs/rpc.md` "Event Types" (lines 859 to 883) and `docs/json.md`:

- Run and turn lifecycle: `agent_start`, `agent_end` (includes `messages`, `willRetry`), `agent_settled`, `turn_start`, `turn_end` (`message`, `toolResults`), `message_start`, `message_end`, `queue_update`.
- Assistant text and deltas: `message_update` with `assistantMessageEvent` of `text_start` | `text_delta` | `text_end` | `thinking_start` | `thinking_delta` | `thinking_end` | `toolcall_start` | `toolcall_delta` | `toolcall_end`.
- Tool lifecycle: `tool_execution_start`, `tool_execution_update` (accumulated `partialResult`, not a delta), `tool_execution_end`. Direct RPC bash also emits `bash_execution_update`.
- Permission and approval: none in core. Pi's README states "No permission popups" and leaves confirmation to extensions.
- Elicitation and user input: `extension_ui_request` / `extension_ui_response` for `select`, `confirm`, `input`, `editor` (dialogs) and fire-and-forget `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` (`docs/rpc.md` Extension UI Protocol).
- Usage: nested on `message_update.usage`, assistant messages, tool results, compaction results. Not a standalone event kind.
- Errors: failed command `response` with `success: false`; `extension_error`; `auto_retry_*`; `summarization_retry_*`; compaction `errorMessage`. Parse failures use `command: "parse"` (`rpc-mode.js` lines 604 to 612).

### Tool-call ids

Provider passthrough, then per-API rewrite.

Anthropic streaming copies `event.content_block.id` onto the tool call (`pi-ai` `anthropic-messages.js` around line 459). Results go back as `tool_use_id: msg.toolCallId` (same file around line 917). When ids would be illegal for Anthropic, `normalizeToolCallId` strips non `[a-zA-Z0-9_-]` and truncates to 64 characters (same file lines 896 to 899).

OpenAI Responses concatenates `call_id` and item `id` as `${item.call_id}|${item.id}` (`openai-responses-shared.js` around line 368) and splits on `|` when sending results (around line 211).

RPC `tool_execution_*` events correlate with `toolCallId`. `toolcall_start` includes `id` and `toolName`. A changelog entry records a bug where those fields were omitted ([#7953](https://github.com/earendil-works/pi/pull/7953)).

Session entry ids are harness-minted 8-char hex from UUID (`session-manager.js` `generateId`). Those are not tool-call ids.

### Tool outcomes

- LLM tool results: `ToolResultMessage` with `isError: boolean`, `content` blocks, optional `details` and nested `usage` (`docs/session-format.md`, `docs/rpc.md`).
- `tool_execution_end`: `result` plus `isError` (`docs/rpc.md` around line 1042).
- Built-in bash tool: non-zero `exitCode` (and not `null`) throws `Command exited with code ${exitCode}`, which surfaces as an error result (`dist/core/tools/bash.js` lines 263 to 266). `exitCode` can be `null` if the process was killed (`bash.d.ts` `BashOperations.exec`). Abort and timeout throw `"Command aborted"` and `"Command timed out after N seconds"`.
- Direct RPC `bash` command: `BashResult` with `output`, `exitCode`, `cancelled`, `truncated`, optional `fullOutputPath` (`docs/rpc.md` lines 489 to 518). That path does not go through the LLM until the next `prompt`.

No POSIX signal number appears on the documented RPC types.

### Stdin command set

Typed in `rpc-types.d.ts` `RpcCommand`:

- Prompt: `prompt` with `message`, optional `images`, optional `streamingBehavior: "steer" | "followUp"`. If the agent is streaming and `streamingBehavior` is omitted, the command errors (`docs/rpc.md` lines 56 to 65).
- Steer: `steer` (also reachable via `prompt` + `streamingBehavior: "steer"`). Delivered after the current assistant turn finishes its tools, before the next LLM call.
- Follow-up: `follow_up`. Delivered when the agent is idle.
- Cancel: `abort` waits until idle. `abort_bash`, `abort_retry`, `clear_queue`.
- Permission reply: none as a first-class command. Extension dialogs use `extension_ui_response` with matching `id`, plus `value`, `confirmed`, or `cancelled: true`.
- Elicitation reply: same `extension_ui_response`. Dialogs with `timeout` auto-resolve on the agent side. Fire-and-forget methods expect no reply.
- Close: no `close` command. Stdin `end` triggers shutdown (`rpc-mode.js` lines 641 to 644). SIGTERM also shuts down.

Every command (except unmatched `extension_ui_response`) produces a `response`. Success means accepted, queued, or handled, not that the agent finished (`docs/rpc.md` lines 71 to 76). Unknown `type` returns `success: false`, `error: "Unknown command: …"`, and now echoes `id` ([#5868](https://github.com/earendil-works/pi/issues/5868); `rpc-mode.js` default branch around line 570). Invalid JSON returns `command: "parse"` with no request id (`rpc-mode.js` line 610). Unmatched `extension_ui_response` ids are dropped with no error (`rpc-mode.js` lines 614 to 625).

### Versioning

- Session files: `version` 1 linear, 2 tree, 3 `hookMessage` renamed to `custom`. Loaded sessions migrate to v3 (`docs/session-format.md` lines 19 to 27).
- RPC wire: no schema version field, no negotiation, no documented unknown-event policy. Clients that do not understand a `type` must ignore it or fail. UNVERIFIED whether the implementation drops unknown events or crashes a typed client.
- Breaking RPC churn: `message_update` lost cumulative `message` ([#7290](https://github.com/earendil-works/pi/issues/7290)); `get_commands` replaced `location`/`path` with `sourceInfo` ([#1734](https://github.com/earendil-works/pi/issues/1734)); slash command source `"template"` renamed to `"prompt"`. Framing changed from `readline` to LF-only JSONL ([#1911](https://github.com/badlogic/pi-mono/issues/1911)).

### Subagent and child events

None. README: "No sub-agents." `new_session` can record `parentSession` as a file path. That is session lineage, not a child event stream.

### Persistence versus stdout

Session JSONL is a tree of entries (`session`, `message`, `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`) with `id` / `parentId` / ISO `timestamp` (`docs/session-format.md`).

RPC stdout is live `AgentSessionEvent` objects plus `response` and `extension_ui_request`. Streaming `message_update` lines are not session entries. `pending` stop reason is reserved for partial messages and "should never appear in session JSONL" (`docs/session-format.md`). Stdout lines do not equal persisted lines.

`get_entries` with `since` is the durable cursor for clients that want the session file shape over RPC.

### Known complaints

- Unknown-command responses omitted `id`, so `RpcClient` hung 30 seconds ([#5868](https://github.com/earendil-works/pi/issues/5868)).
- `message_update` snapshots caused quadratic output ([#7290](https://github.com/earendil-works/pi/issues/7290)).
- `toolcall_start` omitted id and name ([#7953](https://github.com/earendil-works/pi/pull/7953)).
- `abort` reported success without cancelling compaction ([#8920](https://github.com/earendil-works/pi/issues/8920)).
- Unexpected stdout from the process used to corrupt JSONL until redirected to stderr ([#2388](https://github.com/badlogic/pi-mono/issues/2388)).

## Claude Code stream-json

Official docs: [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input), [TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript). Wire types from `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` (unpkg `@latest` on 14 September 2026).

Invoke print mode with `--output-format stream-json`. `--verbose` is required for the full event stream. `--include-partial-messages` adds `stream_event` token deltas. `--input-format stream-json` reads NDJSON on stdin. `--replay-user-messages` re-emits stdin user messages on stdout as acknowledgement ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

### Envelope fields

Most stdout messages share:

- `type` discriminator (`assistant`, `user`, `result`, `system`, `stream_event`, plus many `system` subtypes).
- `uuid` on emitted messages. Optional on inbound `SDKUserMessage`.
- `session_id`.
- `parent_tool_use_id`: `null` on the main conversation; the spawning `Agent` `tool_use` id on subagent messages.
- `timestamp` optional ISO 8601 on assistant messages. Docs say do not order by it ([SDKAssistantMessage](https://code.claude.com/docs/en/agent-sdk/typescript)).
- No protocol schema version number on each line. `SDKSystemMessage` carries `claude_code_version` and `capabilities?: string[]` (Claude Code v2.1.205+).

Control frames on the same stream:

- `{ type: "control_request", request_id, request }` (`sdk.d.ts` `SDKControlRequest` around line 4571).
- `{ type: "control_response", response }` with `subtype: "success" | "error"` and echoed `request_id` (`ControlResponse` / `ControlErrorResponse` around lines 295 to 327).
- `control_cancel_request` withdraws an in-flight request (`sdk.d.ts` around line 3576).

Unknown `capabilities` values must be ignored ([headless](https://code.claude.com/docs/en/headless) "Read session metadata").

### Event taxonomy

`SDKMessage` union ([TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript) around "Message Types"):

- Run and turn lifecycle: `system` / `init`; `result` with `subtype` `success` | `error_max_turns` | `error_during_execution` | `error_max_budget_usd` | `error_max_structured_output_retries`; `system` / `compact_boundary`; `system` / `worker_shutting_down`; `SDKSessionStateChangedMessage`; `SDKConversationResetMessage`; `SDKTask*` and `SDKBackgroundTasksChangedMessage`.
- Assistant text and deltas: `assistant` (complete content block, Anthropic `BetaMessage`); `stream_event` wrapping `BetaRawMessageStreamEvent` (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`). One API turn can yield several `assistant` messages that share `message.id`.
- Tool lifecycle: `tool_use` blocks inside `assistant`; `tool_result` inside `user`; `SDKToolProgressMessage`; `SDKToolUseSummaryMessage`; `SDKLocalCommandOutputMessage`.
- Permission and approval: `control_request` with `subtype: "can_use_tool"` (`tool_name`, `input`, `tool_use_id`, optional `agent_id`); `system` / `permission_denied` (best-effort; `result.permission_denials` is authoritative).
- Elicitation and user input: `AskUserQuestion` arrives as `can_use_tool`; MCP `subtype: "elicitation"`; `request_user_dialog`.
- Usage: on `result.usage` / `modelUsage` / `total_cost_usd`; `SDKRateLimitEvent`; `SDKThinkingTokensMessage`; `context_usage` on some assistant messages.
- Errors: `result` error subtypes; `assistant.error`; `SDKAPIRetryMessage` (`system` / `api_retry` in [headless](https://code.claude.com/docs/en/headless)); `SDKMirrorErrorMessage`; `SDKInformationalMessage`.

Hook, plugin, auth, and prompt-suggestion messages exist (`SDKHook*`, `SDKPluginInstallMessage`, `SDKPromptSuggestionMessage`). `--include-hook-events` is required for most hook events; `SessionStart` and `Setup` are always included ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Users still report missing PreToolUse frames ([anthropics/claude-code#94275](https://github.com/anthropics/claude-code/issues/94275)).

### Tool-call ids

Anthropic Messages API `tool_use.id`, passed through. Streaming `content_block_start` for `tool_use` carries that id ([streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)). Permission requests repeat it as `tool_use_id`. Subagent messages join on `parent_tool_use_id` equal to the parent `Agent` tool_use id. User-message `uuid` is client-minted and optional; Claude echoes it on results only if you set it (`user_message_uuid` docs).

Claude Code does not remint a second harness tool-call id on the public stream. UNVERIFIED whether internal bookkeeping uses another id.

### Tool outcomes

- Generic tool result: Anthropic `tool_result` block, often with `is_error`. Structured copy on `SDKUserMessage.tool_use_result` (typed `unknown`; shapes under Tool Output Types).
- Bash: `BashOutput` with `stdout`, `stderr` (tool notices, not process stderr), `interrupted`, optional `timedOutAfterMs`, `backgroundTaskId`, `returnCodeInterpretation`. The published type has no numeric `exit_code` ([TypeScript SDK BashOutput](https://code.claude.com/docs/en/agent-sdk/typescript)). [Tools reference](https://code.claude.com/docs/en/tools-reference) special-cases exit 1 as success for `grep`, `rg`, `find`, `diff`, `test`, `[`, `git diff`, `git grep`.
- Agent tool: `AgentOutput` with `status: "completed"` and counts.
- Permission deny: `behavior: "deny"` plus `message` returned to the model ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)).
- Hook process: `SDKHookResponseMessage.outcome` `success` | `error` | `cancelled` and optional `exit_code`.

### Stdin command set

User turns (streaming input):

```json
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
```

Optional `uuid`, `session_id`, `shouldQuery: false` (append without starting a turn), `origin` ([SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript)). Images use Anthropic content blocks.

Control requests the client sends include `interrupt` (optional `cancel_queued`), `initialize`, `set_permission_mode`, `set_model`, MCP helpers, `cancel_async_message`, and many session-management subtypes (`SDKControlRequestInner` in `sdk.d.ts` around line 4582).

Server-to-client requests the client must answer:

- `can_use_tool`: reply `control_response` echoing `request_id`, or return a `PermissionResult` from `canUseTool`. Allow with `updatedInput` (required before v2.1.207). Deny with `message`. Optional `updatedPermissions` to persist a rule.
- `elicitation` / `request_user_dialog`: reply with the same `request_id`.
- Returning `null` from `canUseTool` without sending `control_response` leaves the tool blocked. Prompts do not time out ([user input](https://code.claude.com/docs/en/agent-sdk/user-input), SDK `requestId` docs). `PreToolUse` `defer` is the documented way to persist and resume.

Close: SDK `close()` / abort controller. Docs: the SDK closes stdin and waits about two seconds, then SIGTERM. Host SIGTERM exits 143 after `SessionEnd` hooks ([headless](https://code.claude.com/docs/en/headless)).

Acknowledgements: `--replay-user-messages` re-emits user messages. `interrupt` on capable CLIs returns `still_queued` / `cancelled` uuids (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`). Malformed control subtypes produce `control_response` `subtype: "error"` with `error` string (`ControlErrorResponse`). UNVERIFIED how malformed stdin JSON is reported on the CLI (stderr versus a `result` error).

`--max-turns` with stream-json: from v2.1.205 a message sent while Claude is working stays queued as its own turn. Before that, Claude discarded it ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

### Versioning

- No numeric schema field on each line.
- `capabilities` on `system/init` for feature detection. Ignore unknown strings.
- Frequent additive fields gated by Claude Code / Agent SDK versions (examples: `user_message_uuid` v0.3.216 to v0.3.265, `forward-subagent-text` v2.1.211, nested forwarding v2.1.219).
- Control error subtype documents "unknown subtype, invalid arguments, or an error while handling it".
- TypeScript V2 session API was removed ([typescript-v2-preview](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)).

### Subagent and child events

Same stdout stream. `parent_tool_use_id` is the join key. Default: only subagent `tool_use` and `tool_result`. `--forward-subagent-text` / `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` also emits text and thinking (v2.1.211+). Nested subagents from v2.1.219. `stream_event.parent_tool_use_id` is always `null`; token deltas are main-session only ([streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)). Permission denials can carry `agent_id`.

### Persistence versus stdout

Sessions persist under `~/.claude/projects/` unless `--no-session-persistence`. Stdout `stream-json` is a live projection. [Issue #5034](https://github.com/anthropics/claude-code/issues/5034) reports that `--input-format stream-json` rewrote the whole conversation into the session file on each turn, duplicating entries. Resume still worked. `SDKWorkerShuttingDownMessage` is live-oriented; resumed sessions replay past instances and clients should ignore them. `stream_event` deltas are live-only.

### Known complaints and churn

- Duplicate session JSONL with stream-json input ([#5034](https://github.com/anthropics/claude-code/issues/5034)).
- Hook events missing for PreToolUse and others despite `--include-hook-events` ([#94275](https://github.com/anthropics/claude-code/issues/94275)).
- Third-party parsers crashed when `uuid` or `session_id` were omitted on `stream_event` wrappers (Elixir SDK changelog on [hexdocs](https://hexdocs.pm/claude_agent_sdk/changelog.html)).
- Drain-before-exit wait: before v2.1.214 a slow consumer could lose the tail of a large stream (capped at about two seconds; now 30 seconds) ([headless](https://code.claude.com/docs/en/headless)).
- `canUseTool` allow without `updatedInput` was a validation deny before v2.1.207.
- Dummy-hook workaround required in Python to keep the stream open for `can_use_tool` ([user input](https://code.claude.com/docs/en/agent-sdk/user-input)).

## Codex exec JSON and app-server

Official docs: [CLI reference](https://developers.openai.com/codex/cli/reference.md), [app-server](https://developers.openai.com/codex/app-server) (also [learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server)), [codex-rs/app-server/README.md](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md). Source: [exec_events.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs), [event_processor_with_jsonl_output.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs), [sdk/typescript/src/events.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts). Local help: `codex exec --help`, `codex app-server --help` (0.154.0).

`codex exec --json` prints JSONL events. `--json` is an alias of former `--experimental-json`. Stdin is the prompt (or `-`), not a command protocol. `codex app-server` is the bidirectional JSON-RPC protocol used by the VS Code extension. Schema dumps: `codex app-server generate-ts` and `generate-json-schema` match that binary.

### Envelope fields

Exec JSONL (`ThreadEvent` in `exec_events.rs`):

- `type` tag: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`.
- `thread.started` has `thread_id`. Later events in the TypeScript SDK types do not repeat `thread_id`, timestamps, or a schema version (`events.ts`).
- Items carry harness `id` such as `item_0`.

App-server JSON-RPC 2.0 with `"jsonrpc":"2.0"` omitted on the wire ([README Protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)). Requests have `method`, `id`, `params`. Notifications have `method` and `params` (no `id`). Clients must `initialize` then send `initialized`. Requests before handshake get `"Not initialized"`. Duplicate initialize gets `"Already initialized"`. Overloaded ingress: `-32001` `"Server overloaded; retry later."`.

### Event taxonomy

Exec (lossy subset):

- Run and turn: `thread.started`, `turn.started`, `turn.completed` (`usage`), `turn.failed` (`error.message`).
- Assistant text: `item.completed` with `type: "agent_message"` and `text`. Exec mapper drops `phase` ([openai/codex#30190](https://github.com/openai/codex/issues/30190)). No token deltas on exec.
- Tool lifecycle: `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `collab_tool_call` (exec `CollabToolCallItem`), `todo_list`, `error` items. `item.started` is omitted for agent messages and reasoning; those appear only as `item.completed` (`map_started_item` in the processor).
- Permission: none on exec JSON. Headless runs use `--dangerously-bypass-approvals-and-sandbox` or auto review (`codex exec --help`).
- Elicitation: none on exec.
- Usage: `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`).
- Errors: top-level `type: "error"`; `turn.failed`; `item` type `error`. Serialize failures also emit `type: "error"`.

App-server (full):

- Turn: `turn/started`, `turn/completed` (`status` `completed` | `interrupted` | `failed`), `turn/diff/updated`, `turn/plan/updated`.
- Items: `item/started`, `item/completed`, deltas `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, and others listed under "Turn events" in the README.
- Item kinds include `userMessage`, `agentMessage` (with `phase`, `delivery`, `questions`), `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `collabToolCall`, `subAgentActivity`, `webSearch`, `imageGeneration`, `plan`, `contextCompaction`, review mode markers.
- Permission: server-initiated `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`. Client replies `{ decision: ... }`. Then `serverRequest/resolved` and `item/completed`.
- Elicitation: `item/tool/requestUserInput`; `mcpServer/elicitation/request` (`form` | `openaiForm` | `url`).
- Usage: `thread/tokenUsage/updated` (accumulated, persisted). `rawResponse/completed` is live-only when `experimentalRawEvents` is on.
- Errors: `error` notification with `codexErrorInfo` enum (`ContextWindowExceeded`, `UsageLimitExceeded`, HTTP variants, `ActiveTurnNotSteerable`, …). Categories are open-ended. Misalignment details are live-only and stripped from persisted rollout errors.

### Tool-call ids

Exec: harness-minted monotonic `item_N` (`next_item_id`). Internal app-server item ids are stored in `raw_to_exec_item_id` and not emitted. On complete, the map entry is removed (`completed_item_id`). Unfinished started items are synthesized as `item.completed` at turn end (`reconcile_unfinished_started_items`).

App-server: `item.id` is the join key for deltas (`itemId`). MCP and function calls also have provider `call_id` in injected Responses items (`thread/inject_items` notes a standalone `function_call_output` can omit `call_id` when `name` is nonempty). Ordinary paired function-call outputs are "not emitted separately" as thread items (README Items list). UNVERIFIED how app-server `item.id` relates to OpenAI Responses `call_id` on every tool type.

### Tool outcomes

Exec `CommandExecutionItem`: `status` `in_progress` | `completed` | `failed` | `declined`; optional `exit_code`; `aggregated_output` (`exec_events.rs`, TypeScript `items.ts`). File changes: `completed` | `failed` (exec maps app-server `declined` to `failed`). MCP: `status` plus optional `result` / `error.message`.

App-server `commandExecution`: same status enum, `exitCode`, `durationMs`, `commandActions`. Outputs are redacted display values, not executable commands (README). File change and MCP statuses include `declined` where approval was refused.

No POSIX signal field in the exec or README command item. UNVERIFIED whether a killed process is only `failed` without a signal number.

### Stdin command set

Exec: prompt only. No steer, interrupt-with-message, permission reply, or close command. Process exit ends the run. `--output-last-message FILE` writes the final agent text.

App-server (selected, from README API overview):

- Prompt: `turn/start` with `threadId` and `input`. Optional `clientUserMessageId` echoed on `userMessage.clientId`.
- Steer: `turn/steer` on an in-flight regular turn. Review and compaction turns reject it (`ActiveTurnNotSteerable`).
- Queue: `thread/queue/*` for FIFO when idle.
- Cancel: `turn/interrupt` by `(thread_id, turn_id)`; empty `{}` then `turn/completed` with `status: "interrupted"`.
- Permission reply: JSON-RPC response to `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`. Decisions: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel`.
- Elicitation reply: `{ action: "accept"|"decline"|"cancel", content }` to `mcpServer/elicitation/request`; user-input replies to `item/tool/requestUserInput`. `isBlocking` says whether to wait. `autoResolutionMs` is deprecated.
- Close: `thread/unsubscribe`. Last subscriber plus idle delay (default 60s) unloads, runs `SessionEnd` hooks, emits `thread/closed`.

Requests are acknowledged with JSON-RPC responses. Notifications are not. Pagination on stores that lack item paging returns `-32601` (README around `thread/items/list`). Parent-owned Multi-Agent V2 subagents reject most direct input with `-32600` `"direct app-server input is not allowed for multi-agent v2 sub-agents"`. Unknown `optOutNotificationMethods` names are accepted and ignored. UNVERIFIED the exact error payload for a completely unknown `method` string; JSON-RPC `-32601` is the documented code for at least one unimplemented method.

### Versioning

- Exec: no per-line schema version. The `--json` shape replaced the legacy nested `msg` format without a handshake ([PR 4525](https://github.com/openai/codex/pull/4525)).
- App-server: handshake `initialize` / `initialized`; `capabilities` including `experimentalApi` and MCP extension ads; generated TS/JSON Schema pinned to the running binary. Experimental fields require the capability. `historyMode` `paginated` vs `legacy`. Deprecated `thread/rollback`, `compacted` item, detached reviews.
- Unknown item or error categories: README tells clients to ignore result types they do not understand (web search) and treats error categories as open-ended.

### Subagent and child events

Exec maps a subset of `CollabAgentToolCall` into `collab_tool_call` items (`SpawnAgent`, `SendInput`, `Wait`, `CloseAgent`). Several Multi-Agent V2 tools return `None` and vanish from exec JSON (`SendMessage`, `FollowupTask`, `InterruptAgent`, `ListAgents`; interrupted collab status also dropped).

App-server: `collabToolCall` with `senderThreadId` / `receiverThreadId` / `newThreadId`; `subAgentActivity` (`started`, `interacted`, `interrupted`, `completed`). Child completion can arrive after the parent `turn/completed`. `thread/list` can filter `parentThreadId` / `ancestorThreadId`. Subagent sessions inherit the MCP extension profile. Direct stdin to those children is rejected as above.

### Persistence versus stdout

Exec JSON is a live stdout projection. Session files still write unless `--ephemeral`. Exec lines are not the rollout format.

App-server persists a JSONL "rollout" per thread. README marks live-only events: `model/safetyBuffering/updated`, `rawResponse/completed`, misalignment explanation details, auto-approval review notifications described as UNSTABLE. `item/completed` is the authoritative execution result. `turn/completed` carries only a summary fallback agent message. History APIs (`thread/turns/list`, `thread/items/list`, `thread/timeline/list`) read the store, not a replay of every notification.

Stdout notifications therefore do not equal persisted lines.

### Known complaints and churn

- `--json` replaced the old format and dropped tool arguments and results that the previous `msg` stream had ([#5028](https://github.com/openai/codex/issues/5028), [PR 4525](https://github.com/openai/codex/pull/4525)).
- Exec still drops agent message `phase` (`commentary` vs `final_answer`) even though app-server v2 has it ([#30190](https://github.com/openai/codex/issues/30190)).
- App-server README labels several notifications UNSTABLE (`item/autoApprovalReview/*`) and marks `app-server` experimental in `codex --help`.
- Early exec JSON explicitly did not stream tokens; programmatic UIs were told to use MCP instead ([PR 1603](https://github.com/openai/codex/pull/1603)). App-server later added deltas; exec did not grow a matching delta channel.

## Comparison

| Topic | Pi RPC 0.85.1 | Claude Code stream-json 2.1.270 | Codex exec --json 0.154.0 | Codex app-server |
| --- | --- | --- | --- | --- |
| Wire | LF JSONL commands in, events and responses out | NDJSON messages and control frames on the same streams | JSONL events out; prompt on stdin | JSON-RPC JSONL, `jsonrpc` key omitted |
| Envelope on every line | `type`; optional command `id` | `type`, usually `uuid` and `session_id` | `type`; `thread_id` only on start | `method` plus JSON-RPC `id` on requests; `threadId`/`turnId`/`itemId` on many notifications |
| Schema version | Session file `version` 3; none on RPC events | `capabilities` strings, not a number | None; format was replaced in place | Binary-matched generated schema; initialize handshake |
| Text deltas | `message_update` delta-only after #7290 | Opt-in `stream_event` wrapping Anthropic SSE | No | `item/agentMessage/delta` |
| Tool id | Provider id, rewritten per API | Anthropic `tool_use.id` | Reminted `item_N` | App-server `item.id`; provider `call_id` kept internally |
| Shell outcome | Throw on non-zero; RPC bash has `exitCode` | `BashOutput` without numeric exit in SDK type | `status` + optional `exit_code` | `status` + `exitCode` + duration |
| Prompt | `prompt` | `type: "user"` | CLI argument or stdin text | `turn/start` |
| Steer | `steer` / `streamingBehavior` | Queue another user message | No | `turn/steer` |
| Cancel | `abort` | `control_request` `interrupt` | Kill the process | `turn/interrupt` |
| Permission reply | Extension UI `id` only | `control_response` to `can_use_tool` | No | JSON-RPC reply to `requestApproval` |
| Elicitation reply | Extension UI `id` | `elicitation` / AskUserQuestion | No | `requestUserInput` / MCP elicitation |
| Close | stdin end | abort / SIGTERM | process exit | `thread/unsubscribe` then unload |
| Command ack | `type: "response"` | `control_response`; optional user replay | none | JSON-RPC response |
| Malformed input | `command: "parse"` or unknown-command error | `control_response` error subtype | UNVERIFIED | JSON-RPC errors (`-32601`, `-32001`, `-32600` documented for specific cases) |
| Subagents | None | Inline `parent_tool_use_id`; text opt-in | Partial collab items | Child threads + collab / subAgentActivity |
| Stdout equals session file | No | No (and #5034 duplicated the file) | No | No; some notifications are live-only |

## Implications for Fiber

Keep `events.jsonl` as the durable log. Add a versioned live stream that can omit deltas and control chatter from disk. Put `kind`, `schema_version` or a capabilities list, `session_id`, `turn_id`, and `request_id` on the wire from day one. Mint Fiber item ids and store provider tool ids beside them. Require stdin commands to be acknowledged, including parse and unknown-kind errors that echo the request id. Do not ship an exec-style JSON dump as the embed API; Codex already showed that a one-way event stream cannot grow steer, interrupt, and approval later without a second protocol.
