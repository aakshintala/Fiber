## The turn: how pi, codex and Claude Code run one pass of the agent loop

This is research for ticket #112 ("The turn: what one run of the agent loop does"). It looks at how three
reference coding agents run one turn, from primary sources only: pi's TypeScript source (unminified,
installed at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`), codex's Rust source
(sparse-cloned from `https://github.com/openai/codex`, `codex-rs` only), and Claude Code's compiled binary
(`strings` output only, since there is no source access).

A word on vocabulary before the findings, because the three projects use "turn" differently:

- In this document, a turn is the whole run from a user's input to the point where the agent stops on its
  own (no more tool calls, no more queued input). A step is one request-stream-execute-results cycle inside
  a turn. This matches Fiber's own vocabulary in `docs/events.md` and `docs/architecture.md`.
- pi's own event names invert this: pi emits `turn_start`/`turn_end` around each step, and
  `agent_start`/`agent_end` around the whole run. Where this document says "pi turn" it means the whole run
  (pi's "agent"); where it says "pi step" it means one `turn_start`-to-`turn_end` cycle.
- codex's own naming matches this document: `run_turn` is the whole run, and each iteration inside it
  builds a `step_context` and calls `run_sampling_request` once.
- Claude Code's `--max-turns` flag talks about "turns", but its own description ("early exit the
  conversation after the specified number of turns") and the fact that a single turn can contain tool calls
  strongly suggests it is counting steps, not whole runs, in this document's sense. Strings alone don't
  prove this beyond doubt, so it is flagged as an inference, not a confirmed fact.

Codex's source, as cloned, is not the small original codex-rs: it now includes an internal review layer
("guardian"), plugins, connectors and multi-agent spawning. The turn loop findings below are drawn from
the actual current source, not from memory of an older, smaller codex.

### Comparison table

| Question | pi | codex | Claude Code |
|---|---|---|---|
| 1. Order of work in a step | Compaction/`prepareNextTurn` check → drain steering queue → `turn_start` → declare queued/prepared messages → `prepareRequest` hook → stream response → check tool calls → run them (parallel by default) → append results → `finishTurn` decision → `turn_end` → drain steering again | Drain pending input → run turn-start hooks → capture step context (tools/model for this step) → build prompt from cloned history → stream response, handling output items as they arrive, spawning tool futures concurrently → `Completed` event → check `needs_follow_up` / pending input → loop or run stop hooks and break | Not traceable step-by-step from strings; publicly documented order (batch tool calls, run concurrently, results returned before next request) is consistent with what strings show (a "batch of tool calls" resolves before the next model request) |
| 2. When a turn ends; step/turn limit | No hard step limit in `pi-agent-core`; the loop runs until no tool calls and no queued messages remain, or a host's `finishTurn` returns `"end"`. Unconditional auto-continue is called out in the docs as something that "can loop" if a host does not guard it | No hard step limit found in `codex-rs` for the core loop; it runs until the model responds with no follow-up needed and no pending input. Ends on: no follow-up + no pending input (normal stop), `Stop` hook decision, cancellation (`TurnAborted`), or an unrecovered error | Yes: `--max-turns <turns>` / `CLAUDE_CODE_MAX_TURNS` early-exits a non-interactive (`--print`) run after N turns, reporting partial output. Interactive sessions have no such limit. A separate, unrelated cap exists for hook-driven subagents: "Agent hook did not complete within 50 turns" |
| 3. Output-token-limit truncation; mid-argument tool call; empty response | Whole response marked `stopReason: "length"`. Every tool call in that message is failed outright (none executed) with a fixed error text telling the model to re-issue the call. Compaction can also select a "compact and retry" recovery attempt when a `"length"` stop appears early | The stream event `response.incomplete` (server-reported `incomplete_details.reason`, e.g. `max_output_tokens`) is turned into a retryable stream error, retried up to 5 times (`stream_max_retries`, exponential backoff), and if retries are exhausted the whole request fails as a turn error. No mid-argument salvage: the entire response is discarded and re-requested, not repaired | Not found in enough detail to state the exact mechanism. Telemetry constants (`tengu_max_tokens_reached`, `response.model_output_truncated`) show the condition is detected and logged; no model-facing recovery string was found in strings output. A related but distinct feature auto-adjusts `max_tokens` before sending a request whose input + max_tokens would exceed the context window ("max_tokens overflow adjustment") |
| 4. Unknown tool name; bad/unparseable arguments | Unknown tool: error tool result `Tool ${toolCall.name} not found`. Schema validation failure: error tool result starting `Validation failed for tool "<name>":` followed by per-field messages and the raw arguments. Both are immediate, per-call errors; the turn continues | Unknown tool: error tool result `unsupported call: <name>` (or `unsupported custom tool call: <name>` for custom tools). JSON parse failure: error tool result `failed to parse function arguments: <serde error>`. Both are `FunctionCallError::RespondToModel`, i.e. a normal tool-result error; the turn continues | Unknown tool: model-facing error `Error: No such tool available: <name>` (wrapped in `<tool_use_error>...</tool_use_error>`), also seen as `Unknown tool: <name>` / `Unknown tool "<name>" is not a valid tool name.` in different code paths. Bad JSON: `<name> was called with input that could not be parsed as JSON. You sent (first N chars)... Common causes: unescaped backslashes in file paths (use / or \\), unescaped control characters, or truncated output. Retry with valid JSON.` (`InputValidationError: JSON parse failed (...)`) |
| 5. Denied tool call: siblings, turn continuation, model-facing text | A `beforeToolCall` hook can return `{ block: true, reason }`; this produces an immediate error tool result with that reason (example extension text: `"Blocked by user"`). It does not cancel sibling calls in the same step (each call is prepared independently) and does not end the turn unless every call in the batch is marked `terminate: true` | Denial (`ReviewDecision::Denied`) becomes `ToolError::Rejected(reason)`, surfaced to the model as a normal tool-result error (example text: `"rejected by user"`, normalised per tool to e.g. `"exec command rejected by user"`, `"patch rejected by user"`). This does not affect sibling calls (each call's approval and dispatch is independent) and does not abort the turn. Only a distinct `Abort` decision (not the same as denying one call) ends the turn with `TurnAborted` | Model-facing text on rejection: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` (a variant appends the user's stated reason). Whether siblings still run and the turn continues was not directly confirmed from strings, but the wording ("STOP what you are doing") is an instruction to the model, not evidence the harness itself halts the batch |
| 6. Parallel or sequential tool execution | Parallel by default (`toolExecution: "parallel"`); forced sequential only if the batch contains a tool declared `executionMode: "sequential"`, or the host sets sequential mode. Parallel mode dispatches every call, then `Promise.all`s the deferred ones; results are still returned in the original call order | Concurrent: each tool call is dispatched via `tokio::spawn`, gated by a reader/writer lock (`parallel_execution`) — calls that support parallel execution take a read lock (run together), calls that don't take a write lock (run exclusively). Results are collected via `FuturesOrdered`, so they resolve in call order even though execution overlaps | Not directly provable from strings, but the system prompt text instructs the model to "make all independent tool calls in parallel" in "a single response", and a hook fires "once after every tool call in a batch has resolved, before the next model request" — consistent with (but not proof of) concurrent execution of one batch |
| 7. Queued input while idle / several queued at once | Two independently configurable queues, "steering" (delivered after the current step) and "follow-up" (delivered only once the agent would otherwise stop), each with a mode: `"one-at-a-time"` (default) delivers one queued message per drain, `"all"` delivers every queued message as one batch | `InputQueue::get_pending_input` drains the whole pending-input list at once (`split_off(0)`) into the next step — so everything queued by the time of the drain joins as one batch on the next request. The very first message that starts a turn while fully idle was not traced in enough depth to say for certain how a race between two near-simultaneous idle submissions resolves | Confirmed only that queuing exists ("Hit Enter to queue up additional messages while Claude is working"). Whether multiple queued messages become one batch or separate turns was not confirmed from strings |
| 8. How the request's conversation is rebuilt | `SessionManager` is "authoritative for finalized model context"; it owns a persisted (JSONL) or in-memory entry tree, and reconstructing the model context means walking the active branch and applying compaction each time. Within one live process this walk is driven from the in-memory tree; that tree can itself be rebuilt from the persisted JSONL log when a session is opened or a branch is restored | Live in-memory: `clone_history()` clones an in-memory `ContextManager`, and each step's prompt is built from `sess.clone_history().await.for_prompt(...)`. On resume, `reconstruct_history_from_rollout` rebuilds that in-memory `ContextManager` from the persisted rollout (JSONL) file | Persisted transcripts are JSONL (`agent-<id>.jsonl` under a session directory); one string shows a fallback path that reads those files directly when a live copy can't be fetched ("...so there is nothing to resume. Fallback: Read the agent-<id>.jsonl files in ..."), and another confirms an in-memory mirror during a run ("in-memory messages mirrored during the run"). Consistent with the same live-in-memory / rebuild-from-JSONL-on-resume pattern as pi and codex, though the exact mechanism is not as fully traceable as the other two |
| 9. Repetition / doom-loop detection | None found in the core loop. The extensions doc explicitly warns the opposite: an unconditional `continue: true` from a `turn_end`/`agent_before_settle` handler "can loop" — guarding against loops is left to the extension author | None found. No `finish_reason`/repetition-detection string or function turned up anywhere in `codex-rs` | None found for the general tool/turn loop. A narrow, unrelated mechanism exists for a specific "structured output" subagent feature: it detects "no progress" across repeated attempts and gives up after a fixed number of stalled attempts, but this is a retry policy for one tool's sub-feature, not a general doom-loop guard on the main loop |

### 1. Order of work inside one step

pi: `runLoop` in
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
(lines 79-208) is the whole step machine. Per iteration: `config.prepareNextTurn?.()` runs first (this is
where compaction happens, per `docs/compaction.md`: "Pi compacts during `prepareNextTurn`, then performs the
existing catch-up steering poll before `turn_start`"), then a steering-message poll if the first poll came
back empty, then `turn_start` is emitted, then prepared and queued messages are declared onto the context
(`declareToolChanges`, line 116) before the request is built. `config.prepareRequest?.()` runs next (a hook
point), then `streamAssistantResponse` (line 141) does the actual request/stream. After the stream settles,
tool calls are extracted and executed (`executeToolCalls`, line 165), results are appended to context and
`newMessages` (lines 168-171), `config.finishTurn?.()` decides whether to end or continue, `turn_end` is
emitted, and steering messages are polled again for the next iteration (line 186).

Queued user input joins in two places: steering messages join right after the current step finishes (drained
into `pendingMessages` at line 186, folded into the next iteration's declared messages at line 116);
follow-up messages join only once the agent has stopped calling tools and has no more steering queued (line
192, `config.getFollowUpMessages?.()`).

codex: `run_turn` in
`/private/tmp/claude-501/-Users-aakshintala-work-fiber/eb1943e5-7a6b-4861-9ed4-153e9d1bb887/scratchpad/codex/codex-rs/core/src/session/turn.rs`
(function starts at line 163) runs pre-sampling compaction first (`run_pre_sampling_compact`, line 183),
then works out which MCP servers and plugins the input needs, captures the first step context (line 258),
runs any pending session-start hooks and turn-start hooks (`run_hooks_and_record_inputs`, line 366), then
enters the per-step loop at line 424: drain pending input (line 428), run hooks over that pending input, capture
(or reuse) the step context, clone history into a prompt (line 514-520), and call `run_sampling_request`
(line 522). Inside `try_run_sampling_request` (line 2499), each `OutputItemDone` for a tool call spawns a
tool future (`in_flight.push_back(tool_future)`, line 2757) while the response keeps streaming; a `Completed`
event (line 2913) ends the step and reports whether the model wants a follow-up.

Queued input in codex is drained wholesale at the top of each step (`sess.input_queue.get_pending_input`,
line 428-435; the implementation is `split_off(0)` in
`core/src/session/input_queue.rs` line 321/340), so everything queued since the last drain joins the very
next step as one batch, before the next prompt is built.

Claude Code: no source, so the exact order of work inside one step could not be traced. The hook
documentation strings show turn-shaped boundaries consistent with the other two agents — a hook that fires
"After a batch of tool calls resolves" ("Fires once after every tool call in a batch has resolved, before
the next model request") and one that fires "After auto mode classifier denies a tool call" — but the
precise ordering (compaction check, steering, hook, request, stream, execute, append) could not be confirmed
from strings.

### 2. When a turn ends; step or turn limit

pi: a step ends every time `finishTurn` is called (agent-loop.js line 179); the whole run (pi's "agent") ends
when, after a step with no tool calls, there are no queued steering or follow-up messages left and no host
`"continue"` decision is pending (lines 190-206). There is no built-in maximum step count in
`pi-agent-core`. `docs/extensions.md` line 109 explicitly warns that a `turn_end`/`agent_before_settle`
handler returning `continue: true` unconditionally "can loop" — the responsibility for capping continuations
sits with whoever writes that handler, not with the core loop.

codex: the per-step loop in `run_turn` breaks when `!needs_follow_up` (turn.rs line 647), after running any
`Stop` hooks (`run_turn_stop_hooks`, line 649) — a hook can force one more step by blocking with a
follow-up prompt (line 666-683: "Stop hook requested continuation" path), or force a real stop
(`stop_outcome.should_stop`, line 694: `break;`). No hard step-count ceiling was found anywhere in
`codex-rs` for this loop (a grep for `max_turn`/`max_step`/`turn_limit` across the whole source only turned
up unrelated things: a TUI "read N most recent turns" tool limit, a recap-history display cap, and an
`environment_selection.rs` byte-length constant).

Claude Code: `--max-turns <turns>` / `CLAUDE_CODE_MAX_TURNS` is documented in the CLI's own `--help` text as
"Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the
specified number of turns. (only works with --print)". Hitting it produces telemetry events
`error_max_turns` / `max_turns_reached` / `hit_max_turns`, and a message template: "Reached maximum number
of turns (<N>)". Adjacent strings ("The text below is PARTIAL output; treat it as incomplete. It was still
calling tools and had produced no report." and "-turn limit before finishing.") show the run is cut off with
its partial output flagged incomplete, not silently truncated. This is documented as a print/SDK-mode-only
feature; interactive sessions were not found to have an equivalent cap. Separately, a fixed cap of 50 turns
applies to hook-driven subagents specifically ("Agent hook did not complete within 50 turns",
`tengu_agent_stop_hook_max_turns`), and "no turn limit is enforced in a cloud session yet" suggests cloud/background
sessions currently have neither cap.

### 3. Output-token-limit truncation, mid-argument tool calls, empty responses

pi: `streamAssistantResponse` (agent-loop.js lines 260-332) finishes with whatever `stopReason` the provider
reports; `runLoop` checks `message.stopReason === "length"` at line 163. When true, every tool call
in that message goes through `failToolCallsFromTruncatedMessage` (lines 340-360) instead of being executed.
The comment at lines 160-162 states why: "A 'length' stop means the output was cut off by the token limit,
so every tool call in the message may carry truncated arguments. Fail them all instead of executing
potentially borked calls." The exact text sent back to the model for each such call is:

> Tool call "<name>" was not executed: the response hit the output token limit, so its arguments may be
> truncated. Re-issue the tool call with complete arguments.

(agent-loop.js line 351). Separately, `docs/compaction.md` (lines 37-39) says an early `stopReason: "length"`
can trigger one "compact and retry" recovery attempt, and that "Length responses with tool calls retain
their synthetic failed tool results and follow the ordinary tool/queue scheduler rather than forcing the run
to end" — i.e. the failed-tool-call path above is what actually runs; compaction is a secondary reaction
for freeing context, not a substitute for it. No handling specific to an empty response (no text, no tool
calls) was found; it would simply fall through with `hasMoreToolCalls = false` and the run would stop if
nothing else is queued.

codex: the wire-level SSE parser
(`/private/tmp/claude-501/-Users-aakshintala-work-fiber/eb1943e5-7a6b-4861-9ed4-153e9d1bb887/scratchpad/codex/codex-rs/codex-api/src/sse/responses.rs`,
lines 417-427) turns a `response.incomplete` event into an error, reading the reason out of
`incomplete_details.reason` (e.g. `max_output_tokens`):

> Incomplete response returned, reason: <reason>

wrapped as `ResponsesEventError::Api(ApiError::Stream(message))`. This is a `CodexErrorDetails::Stream`
error, which `protocol/src/error.rs` (line 413) marks retryable (as opposed to the large "terminal, no
retry" branch at lines 386-412 that covers things like `ContextWindowExceeded` or `InvalidRequest`).
`handle_response_stream_error` (`core/src/responses_retry.rs`, from line 52) retries with backoff up to
`stream_max_retries()` (`model-provider-info/src/lib.rs` line 497-501, default 5, provider-configurable up
to 100). So codex does not salvage a truncated tool call at all: the whole response is thrown away and the
entire request is retried from scratch, up to 5 times, before it becomes a hard turn error. No handling
specific to an empty (no text, no tool call) but *complete* response was found in the reviewed code.

Claude Code: telemetry-only evidence. `strings` shows `tengu_max_tokens_reached!` and a tracing field
`response.model_output_truncated`, which confirms the condition is detected and logged, but no exact
model-facing recovery text (equivalent to pi's "Re-issue the tool call" message, or codex's incomplete-retry
path) was found. A related but different feature was found: before sending a request, Claude Code appears to
adjust `max_tokens` down when input length plus the requested `max_tokens` would exceed the model's context
limit (strings: `input length and \`max_tokens\` exceed context limit: (\d+) + (\d+) > (\d+)`, `max_tokens
overflow adjustment made no progress`, `tengu_max_tokens_context_overflow_adjustment`). That is a pre-request
guard against a context-window error, not a description of what happens to a tool call truncated mid-stream.
This document states plainly: not found, for the specific mid-argument-truncation recovery mechanism in
Claude Code.

### 4. Unknown tool name; arguments that fail to parse or fail the schema

pi: unknown tool is checked first in `prepareToolCall` (agent-loop.js lines 479-487):

> Tool ${toolCall.name} not found

Schema validation happens in `validateToolArguments`
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js`,
lines 280-308), which throws:

> Validation failed for tool "<name>":
>   - <path>: <message>
>   ...
>
> Received arguments:
> <pretty JSON>

Both errors are caught in `prepareToolCall`'s `catch` block (agent-loop.js lines 531-537) and turned into an
immediate error tool result — they do not throw out of the step; the turn continues normally to the next
model request with that tool result in context.

codex: unknown tool is handled in `ToolRegistry::dispatch_any_with_state`
(`core/src/tools/registry.rs`, lines 570-593), via `unsupported_tool_call_message` (lines 857-862):

> unsupported call: <name>

or, for a custom tool call:

> unsupported custom tool call: <name>

Argument parsing failures go through the shared helper `parse_arguments` (`core/src/tools/handlers/mod.rs`,
lines 86-93):

> failed to parse function arguments: <serde_json error>

Both are `FunctionCallError::RespondToModel(message)` (`tools/src/function_call_error.rs`), which is
explicitly the non-fatal variant — only `FunctionCallError::Fatal` aborts the call chain outright (see
`core/src/tools/registry.rs` around line 588, where a payload/kind mismatch does use `Fatal`). A
`RespondToModel` error becomes a normal tool-result error; the turn continues.

Claude Code: unknown tool, from strings, appears in at least three phrasings depending on the code path:

> Error: No such tool available: <name>

(wrapped in `<tool_use_error>...</tool_use_error>`), plus:

> Unknown tool: <name>

and:

> "<name>" is not a valid tool name.

Bad/unparseable JSON arguments produce a longer, more instructive message aimed at getting the model to
retry correctly:

> <name> was called with input that could not be parsed as JSON. You sent (first <N> ... not shown).
> Common causes: unescaped backslashes in file paths (use / or \\), unescaped control characters, or
> truncated output. Retry with valid JSON.

with an associated tag `InputValidationError: JSON parse failed (...)`. Whether the turn always continues
after these was not directly provable from strings, but the message design (a fixable-by-the-model
correction, not a run-ending error) strongly implies it does, matching pi and codex.

### 5. A denied tool call

pi: a host's `beforeToolCall` hook can return `{ block: true, reason }` (agent-loop.js lines 505-515); this
produces an immediate error tool result with `result.content` set to that reason, and only sets
`terminate: true` if the hook explicitly asks for it. The bundled example extension
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/permission-gate.ts`,
line 28) shows the reason text a real extension would use:

> Blocked by user

Because `executeToolCallsParallel`/`executeToolCallsSequential` prepare each tool call independently (the
`prepareToolCall` call per tool, agent-loop.js lines 411-450), a block on one call has no effect on siblings
in the same step — they still run. The whole batch only stops the turn if every result in it carries
`terminate: true` (`shouldTerminateToolBatch`, line 463-465); an ordinary single denial does not meet that
bar, so the turn continues.

codex: a user, hook, or the "guardian" review layer can deny a tool call. `ApprovalResolution::into_tool_result`
(`core/src/tools/approvals.rs`, lines 444-475) turns `ReviewDecision::Denied { rejection }` into
`ToolError::Rejected(rejection)`, with example reason text at line 461: `"rejected by user"`. This is
distinct from `ReviewDecision::Abort`, which becomes `CodexErr::TurnAborted` (line 472) — that is, "deny
this one call" and "abort the whole turn" are different decisions with different consequences. Downstream,
`ToolError::Rejected` is turned into the model-facing tool result in `core/src/tools/events.rs` (lines
449-469), which normalises the generic "rejected by user" text per tool kind:

> exec command rejected by user

> patch rejected by user

Because each tool call's approval and dispatch is independent (`ToolCallRuntime::handle_tool_call_with_source`,
`core/src/tools/parallel.rs` lines 124-292, one `tokio::spawn` per call), denying one call does not cancel or
block its siblings, and the turn is not ended by a denial — only an `Abort` decision (`CodexErr::TurnAborted`)
ends it.

Claude Code: the model-facing text on a rejected tool use is:

> The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file
> edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell
> you how to proceed.

with a second variant that appends the user's own words when they gave a reason ("...To tell you how to
proceed, the user said:"). This is an instruction embedded in the tool result telling the model to stop, not
proof that the harness itself halts sibling calls in the same batch or ends the turn — that mechanical
detail could not be confirmed from strings alone. State plainly: not confirmed either way for Claude Code.

### 6. Parallel or sequential tool execution

pi: `Agent.toolExecution` defaults to `"parallel"` (agent.js line 143). `executeToolCalls` (agent-loop.js
lines 364-370) only forces the sequential path if the config says so or if any tool call in the batch names
a tool declared `executionMode: "sequential"` on `currentContext.tools`. In parallel mode
(`executeToolCallsParallel`, lines 409-462), every call is prepared up front, deferred ones are collected as
async closures, then run with a single `Promise.all` (line 451) — so they execute concurrently — but the
results array (`orderedFinalizedCalls`) preserves the original call order because `Promise.all` preserves
array position regardless of completion order.

codex: `ToolCallRuntime::handle_tool_call_with_source` (`core/src/tools/parallel.rs`, lines 124-242) spawns
each call with `tokio::spawn` (line 194) and gates entry with a `RwLock` (line 202-206): a call whose tool
supports parallel execution takes a read lock (so any number of parallel-capable calls run together), a call
whose tool does not takes a write lock (so it runs exclusively, blocking every other call until it finishes).
The comment at line 226 makes the ordering guarantee explicit: "The sampling loop collects results in order
only after its stream ends" — results are gathered through a `FuturesOrdered` in `try_run_sampling_request`
(turn.rs line 2566, `in_flight.push_back(tool_future)` at line 2757), so execution can overlap while output
order still matches call order.

Claude Code: the system prompt instructs the model itself to batch independent calls:

> You can call multiple tools in a single response. If you intend to call multiple tools and there are no
> dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool
> calls where possible to increase efficiency. However, if some tool calls depend on previous calls to
> inform dependent values, do NOT call these tools in parallel and instead call them sequentially.

and a hook is documented to fire "once after every tool call in a batch has resolved, before the next model
request" — both consistent with running one batch's calls together and waiting for all of them before the
next request, matching pi and codex's model. Neither string proves the harness actually executes them
concurrently versus sequentially-but-batched; that mechanical detail was not directly confirmed.

### 7. Input arriving while idle, or several inputs queued at once

pi: two independent queues exist on the `Agent` class (`agent.js` lines 96-97, 137-138):
`steeringQueue` (delivered mid-run, after the current step) and `followUpQueue` (delivered only once the
run would otherwise stop). Each has its own drain mode, set via `steeringMode`/`followUpMode`
(`PendingMessageQueue`, lines 60-86): `"one-at-a-time"` (the default for both) returns only the oldest
queued message per drain; `"all"` returns every queued message as one array. So whether "several queued
messages" become one turn or several separate turns is a configuration choice pi exposes to its host, not a
fixed behaviour — the default is one-at-a-time.

codex: `InputQueue::get_pending_input`
(`core/src/session/input_queue.rs`, lines 328-360) drains the turn-local pending list with
`items.split_off(0)` (line 340), which empties the whole list into the returned vector in one call — there
is no per-message pacing here, so everything queued by the moment of the drain becomes one batch that joins
the very next step. What happens when two user messages arrive in quick succession while completely idle
(no turn running at all yet) was not traced far enough to say with confidence whether the second one starts
its own new turn or gets folded into the first's pending input; this document does not claim an answer for
that specific race.

Claude Code: the only confirmed fact from strings is that queuing exists during a run:

> Hit Enter to queue up additional messages while Claude is working.

Whether several queued messages are delivered as one batch or as separate turns was not confirmed from
strings.

### 8. How the request's conversation is rebuilt

pi: `docs/sdk.md` (lines 38-40) states plainly that `SessionManager` "is authoritative for finalized model
context" and owns "the persisted or in-memory entry tree"; "When Pi reconstructs model context, the manager
selects the active branch and applies compaction." Line 40 adds a specific warning: "Assigning
`session.agent.state.messages` does not replace persisted context" — i.e. the in-memory array the low-level
`Agent` class holds is not itself the source of truth; the `SessionManager`'s branch walk (over the
persisted JSONL log, or an equivalent in-memory tree via `SessionManager.inMemory()`) is. `docs/how-pi-works.md`
(line 31) confirms this for compaction specifically: "Model context is reconstructed from the active
branch."

codex: within a live run, each step's prompt is built from an in-memory clone —
`sess.clone_history().await.for_prompt(...)` (`core/src/session/turn.rs` line 515-517), backed by
`Session::clone_history` (`core/src/session/mod.rs` line 4519-4521), which clones an in-memory
`ContextManager`. On resuming a persisted session, `reconstruct_history_from_rollout`
(`core/src/session/rollout_reconstruction.rs`, function starting line 169, invoked from `session/mod.rs`
lines 1570/1618/1714) rebuilds that same in-memory `ContextManager` from the persisted rollout (JSONL) file.
So the live answer is "in-memory", and the in-memory state is itself sourced from the persisted log at
session open/resume time.

Claude Code: `strings` shows conversation transcripts are persisted as JSONL (`agent-<id>.jsonl`), with an
explicit fallback path for rebuilding from them:

> ... is not on disk, and this session cannot fetch a remote copy, so there is nothing to resume. Fallback:
> Read the agent-<id>.jsonl files in ...

and a separate string confirms an in-memory mirror exists during an active run ("in-memory messages
mirrored during the run"). This is consistent with the same pattern as pi and codex (live in-memory state,
rebuilt from a persisted JSONL log on resume), but the exact mechanism — what triggers a rebuild versus
reading the in-memory mirror during one live process — could not be traced as precisely as for pi or codex.

### 9. Repetition or doom-loop detection

pi: none found. The one relevant statement is a warning, not a safeguard: `docs/extensions.md` line 109
says a `turn_end`/`agent_before_settle` handler that returns `continue: true` unconditionally "can loop" and
tells extension authors to "guard continuation conditions" themselves.

codex: none found. A search across the whole `codex-rs` tree for repetition/doom-loop/loop-detection
language, and for `finish_reason`-style signals that might feed one, turned up nothing relevant.

Claude Code: no general mechanism found for the main tool/turn loop. A narrow, separate feature exists for a
specific "structured output" subagent workflow (strings: `stalled (no progress)`, `agent stalled on all
<N> attempts (no progress for <ms> each)`, `agent abandoned after <N> attempts`) — this detects lack of
progress across repeated attempts at getting valid structured output from a subagent and gives up after a
fixed number of attempts, but it is a retry policy scoped to that one feature, not a general safeguard
against the main agent repeating the same tool call over and over.

### Sources

- pi: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`,
  `.../dist/agent.js`,
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js`,
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/{how-pi-works,compaction,extensions,sdk}.md`,
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/permission-gate.ts`.
- codex: sparse clone of `https://github.com/openai/codex` (`codex-rs` only) at
  `/private/tmp/claude-501/-Users-aakshintala-work-fiber/eb1943e5-7a6b-4861-9ed4-153e9d1bb887/scratchpad/codex/codex-rs`,
  files `core/src/session/turn.rs`, `core/src/tools/{parallel,registry,approvals,events}.rs`,
  `core/src/tools/handlers/mod.rs`, `core/src/session/input_queue.rs`,
  `core/src/session/rollout_reconstruction.rs`, `codex-api/src/{common,sse/responses}.rs`,
  `protocol/src/error.rs`, `model-provider-info/src/lib.rs`, `tools/src/function_call_error.rs`.
- Claude Code: `strings -a ~/.local/share/claude/versions/2.1.283`, filtered by grep for the phrases quoted
  above. No source access; findings are limited to what a literal string in the binary shows.
