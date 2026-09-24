# Compaction: how the reference agents handle an overflowing session

This note is the evidence behind
[Compaction: when a session outgrows its context](https://github.com/aakshintala/fiber/issues/24).
It reads three reference agents from primary sources only: pi 0.87 as shipped
plus pi's rewrite-in-progress on GitHub, codex's Rust source, and Claude Code
2.1.282 read with `strings` and its own session logs. Every claim below cites
a file, a line range, a binary string, or a doc URL.

## pi

pi ships two relevant things: the released 0.87 agent
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`, unminified)
and a rewrite in progress on `earendil-works/pi` on GitHub that has not shipped.
They disagree on whether the model can trigger its own context restart, so
they are covered separately.

### pi 0.87, as shipped

**Trigger.** Auto-compaction fires when
`contextTokens > contextWindow - reserveTokens`, checked after each turn's
tools finish and again before a new user prompt
(`docs/compaction.md:29-37`). `reserveTokens` defaults to 16,384 and
`keepRecentTokens` defaults to 20,000, both configurable in
`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`
(`docs/compaction.md:417-435`). Per-model overrides exist
(`compaction.modelOverrides`), keyed by exact `provider/modelId`
(`docs/compaction.md:439-463`). Manual trigger is `/compact [instructions]`,
where the instructions focus the summary (`docs/compaction.md:41`).
`enabled: false` turns auto-compaction off entirely; manual `/compact` still
works (`docs/compaction.md:437`).

**Cut.** Valid cut points are user messages, assistant messages,
`BashExecution` messages, and custom messages; a tool result is never a cut
point, it must stay with its tool call (`docs/compaction.md:128-136`). Pi
walks backwards from the tail accumulating tokens until `keepRecentTokens` is
reached, then everything before that point is summarized
(`docs/compaction.md:43-49`). If a single user-message span (a user message
plus every turn up to the next user message) is itself bigger than
`keepRecentTokens`, the cut lands inside that span at an assistant message —
a "split user-message span" — and pi generates two summaries and merges them
(`docs/compaction.md:100-127`). Repeated compaction re-summarizes from the
*previous* compaction's kept boundary, not from the compaction entry itself,
so messages that survived an earlier compaction get folded into the next
summary too (`docs/compaction.md:83`).

**Summary.** The session's own model writes the summary by default, but an
extension can substitute any registered model, including a different,
cheaper one (`examples/extensions/custom-compaction.ts:27-32`, using
`gemini-2.5-flash`). The summarization call sets
`cacheRetention: "none"` and a fresh `sessionId` — it is an isolated call,
not a request that shares the ongoing cached prefix
(`examples/extensions/custom-compaction.ts:79-88`; `docs/compaction.md:23`:
"Summarization requests disable prompt-cache writes because these one-off
prompts are unlikely to be reused"). Prompt structure: the default summary
has sections for Goal, Constraints & Preferences, Progress (Done/In
Progress/Blocked), Key Decisions, Next Steps, and Critical Context, plus
appended `<read-files>`/`<modified-files>` lists (`docs/compaction.md:236-274`,
described here, not quoted). There is no hard size limit documented for the
summary itself, but the *source* text fed to the summarizer is bounded: tool
results are truncated to 2,000 characters during serialization before being
sent for summarization (`docs/compaction.md:290`). The previous summary is
passed back in as iterative context on the next compaction
(`docs/compaction.md:47`, `examples/extensions/custom-compaction.ts:46`).

**Record.** A `CompactionEntry` is appended to the session log:
`{ type: "compaction", summary, firstKeptEntryId, tokensBefore, usage?,
fromHook?, details? }` (`docs/compaction.md:145-156`). On resume, pi's
context builder walks the branch to find the newest applicable entry and
rebuilds context as summary + everything from `firstKeptEntryId` onward
(`docs/compaction.md:49`, diagram at `docs/compaction.md:74-81`).

**Overflow.** A provider context-overflow error, or an early final
`stopReason: "length"`, can select one compact-and-retry recovery attempt
(`docs/compaction.md:39`). The recovery order is: persist the final response,
run `turn_end`/`agent_end`, append `context_edit` omissions for the failed
attempt, run `session_before_compact` and append a compaction on success,
then start the retry as a fresh run (`docs/compaction.md:85-98`). If recovery
compaction itself fails or is cancelled, pi keeps the omission edits but
appends no compaction and schedules no retry
(`docs/compaction.md:98`).

**UI / headless.** `session_before_compact` and `session_compact_failed`
extension events exist and carry `reason: "manual" | "threshold" | "overflow"`
and a `willRetry` flag (`docs/compaction.md:296-383`); these are the events a
headless/RPC consumer would hook. No further UI-specific behaviour is
documented in this file.

**Model-triggered restart.** Not present in 0.87. The only "handoff" in the
shipped product is `examples/extensions/handoff.ts`, a `/handoff <goal>`
*user* slash command: it serializes the current branch (compaction summary +
kept tail, via `getHandoffMessages()`, `handoff.ts:57-78`), asks the model to
write a self-contained prompt for a *new* session
(`handoff.ts:20-40`, described not quoted), and opens that new session with
the generated prompt pre-filled in the editor for the user to review and
submit (`handoff.ts:177-183`). It is manual, out-of-band, and starts a
different session rather than restarting the current one. Nothing in
`dist/` grep-matches `handoff` as a tool-result field, and `addTools` does
not appear anywhere in `dist/` — the ToolControl shape described below for
the rewrite is not implemented in 0.87.

**Non-summary shortening.** `context_edit` entries: `{ type: "context_edit",
targetId, replacement }`, where `replacement: null` omits the target entry
from context and a non-null `replacement` swaps in different messages while
keeping the original entry's role/metadata (`docs/session-format.md:142`,
`:231`). These are used by overflow recovery to omit a failed attempt without
summarizing it away permanently — the raw entry is retained in storage,
only excluded from the next provider request.

### pi's rewrite (earendil-works/pi, not shipped)

The rewrite has two relevant specs: `packages/agent/docs/harness.md`
("AgentHarness", the currently-implemented lower layer — work package WP05
is marked complete) and `packages/durable/docs/pico-v5.md` ("Pico5", a
higher-level host-facing API the doc itself says is "not implemented yet...
implementations must expose this shape rather than inventing a different
facade during package 24", `pico-v5.md:244-246`).

**harness.md (implemented layer).** Compaction and branch/navigation
summaries share one state machine keyed by a `boundary`:
`resume_checkpoint` (threshold or overflow mid-run), `finish` (standalone
`/compact`), or `commit_navigation` (summarized `/tree` navigation)
(`harness.md:802-810`). Every compaction entry stores a complete
`retainedTail: AgentMessage[]` (`[]` when empty) and **context never reads
past a compaction** — a compaction is a self-contained checkpoint, not a
pointer into older history (`harness.md:454`, `harness.md:511`: "Reverse to
oldest-first. If a compaction terminated the scan, the context is its
`summary`, then its `retainedTail`, then every entry after it. Nothing
earlier is read."). This is a stronger guarantee than 0.87's
`firstKeptEntryId` pointer scheme: `retainedTail` is a copy, not a reference,
so a later storage-level rewrite (the "precise rewrite", `harness.md:580`)
can erase what came before without corrupting live context. An old-format
(v3) compaction's `firstKeptEntryId` is resolved once at import time and
materialized as `retainedTail` (`harness.md:1457`). Structural summary
requests force `cacheRetention: "none"` and a fresh request identity
(`harness.md:814`), matching 0.87's behaviour. Overflow inside a run
normalizes the response to `error` + usage, enters
`summary.deciding{boundary: resume_checkpoint{need_assistant(true)}}`, and on
success commits the compaction entry, selected queued items, and
`assistant.ready` in one transaction; `overflowRecoveryUsed: true` prevents a
second compaction loop in the same run, and a second overflow terminal-fails
the run (`harness.md:818`). Tool results in the *current implementation*
support only `terminate?: true` (a "submit final result" tool in place of
structured output, `harness.md:794`) — there is no `handoff` field on tool
results in `harness.md`.

**pico-v5.md (not implemented, future host API).** This is where a
model-triggered restart is actually designed. `ToolControl` is
`{ addTools?, terminate?: true, handoff?: string }`
(`pico-v5.md:1436-1440`), and: "A tool result may request `addTools`,
`terminate`, or `handoff`. Post-tools applies added tool names to configured
loadout, uses a final boundary for terminate/handoff, and writes a headed
handoff entry when requested" (`pico-v5.md:1555-1557`). Pico5's context model
is built on entries with an optional `head` marker: "A head on an entry
changes subsequent context; it does not remove older entries from storage"
(`pico-v5.md:217-218`), and compaction itself works by "appending a summary
entry with a head" (`pico-v5.md:1714`). A handoff entry uses the same
mechanism — it is a headed entry whose content is whatever string the tool
result supplied, so the *model* (via the tool call it chose to make, and
whatever text the tool call put in `handoff`) can write the string that
becomes the new visible context start, with no second LLM call required to
summarize it. Separately, `Conversation.reset(handoff: string | undefined,
context)` is a host-callable API: "`reset()` durably admits a passive
self-head reset or handoff write and then resolves" (`pico-v5.md:379`,
`:522-526`) — this is a host/application-level reset, not a model tool call,
and is the closest analogue to 0.87's user-triggered `/handoff`. There is
also `Conversation.collapse(instructions, context)`, which "returns the
newly admitted background collapse task ID" and performs "select a
transcript range, summarize, append a headed summary" — effectively
pico-v5's name for compaction (`pico-v5.md:378`, `:522`, `:1696`), with a
`beforeCollapse` hook (`pico-v5.md:1428`).

Because the whole pico-v5 document is explicitly unimplemented, and `dist/`
in the shipped 0.87 package has zero occurrences of `handoff` as a
tool-result field or of `addTools`, this model-triggered handoff is a
**design, not a shipped feature**, in any pi version read for this note.

## codex

Source: sparse-cloned `openai/codex` (`codex-rs/`), depth 1,
`codex-rs/core/src/compact*.rs`, `codex-rs/core/src/tasks/compact.rs`,
`codex-rs/core/src/session/context_window.rs`,
`codex-rs/core/src/state/auto_compact_window.rs`,
`codex-rs/hooks/src/events/compact.rs`, `codex-rs/prompts/templates/compact/`,
and test snapshots under `codex-rs/core/tests/suite/snapshots/`.

**Trigger.** codex tracks context usage per "auto-compact window"
(`core/src/state/auto_compact_window.rs`). The trigger formula
(`core/src/session/context_window.rs:98-117`) is:

```
buffered_auto_compact_limit = auto_compact_scope_limit + fallback_buffer_tokens
token_limit_reached =
    auto_compact_scope_tokens >= buffered_auto_compact_limit
    OR active_context_tokens >= full_context_window_limit
```

`auto_compact_scope_limit` comes from `model_auto_compact_token_limit`
(configurable) or the model's own `auto_compact_token_limit()`
(`context_window.rs:61-74`); its *scope* — whether it counts total tokens or
only tokens added after the initial prefix — is itself configurable via
`AutoCompactTokenLimitScope::Total | BodyAfterPrefix`
(`app-server-protocol/schema/typescript/AutoCompactTokenLimitScope.ts`).
`full_context_window_limit = context_window * effective_context_window_percent
/ 100` (`context_window.rs:84-86`). A separate
`model_post_turn_compact_threshold_percent` setting drives
`turn_end_compaction_threshold_reached`, an end-of-turn check independent of
the hard limit (`context_window.rs:111-117`). Manual trigger is the
`compact` slash command / `CompactTask`
(`core/src/tasks/compact.rs`); codex also exposes `compact/start` over its
app-server RPC (`app-server-protocol/schema/typescript/v2/ThreadCompactStartParams.ts`).
No custom-instructions parameter was found on manual compaction (unlike pi's
`/compact [instructions]`). A `Feature::TokenBudget` flag switches
compaction to a different implementation entirely — no LLM summarization,
just "installs a fresh context window instead"
(`core/src/compact_token_budget.rs:19-23`) — while still running the same
pre/post-compact hooks and emitting the same `ContextCompaction` turn item.

**Cut.** Unlike pi, codex compaction is not "summarize the old, keep a
verbatim tail of N tokens". The default ("Memento" strategy,
`CompactionStrategy::Memento`, `core/src/compact.rs:477`) replaces the
*entire* history with: up to `COMPACT_USER_MESSAGE_MAX_TOKENS` (20,000,
`compact.rs:59`) worth of the user's own recent messages, most-recent-first,
truncated if the last one doesn't fit, plus one summary message
(`compact.rs:667-744`). It genuinely can cut mid-turn: a test snapshot shows
compaction running after a tool call/result inside the same turn, with the
compaction request including the tool call and its output, and the
*continuation* request replacing both with just the summary
(`core/tests/suite/snapshots/all__suite__compact__mid_turn_compaction_shapes.snap`).
Mid-turn compaction re-injects "initial context" (world state) just above
the last real user message so the model still sees it as the newest item
(`InitialContextInjection::BeforeLastUserMessage`, `compact.rs:67-69`);
pre-turn/manual compaction does not re-inject it inline and instead lets the
next ordinary turn re-add it fully (`compact.rs:61-66`).

**Summary.** Written by the session's own model, in-band — the compaction
prompt is sent as an ordinary turn on the same session/thread (not marked
`cacheRetention: none`, unlike pi), so this is billed and cached like a
normal turn, not an isolated side call. Prompt structure
(`prompts/templates/compact/prompt.md`, described not quoted): it frames
itself as producing a handoff summary for another LLM that will resume the
task, and asks for progress/decisions, important context or constraints,
remaining next steps, and any critical data or references needed to
continue. There is a separate `summary_prefix.md` used to introduce that
summary back into history, telling the resuming model it is looking at
another language model's summary and to build on it rather than duplicate
work. On a context-window-exceeded error *during* the compaction call
itself, codex trims the oldest history item and retries, preferring to
"preserve cache (prefix-based)" by trimming from the front
(`compact.rs:314-326`). After every successful compaction it emits a
user-visible warning: repeated compactions can make the model less accurate,
suggesting a new thread ("Heads up: Long threads and multiple compactions
can cause the model to be less accurate...", `compact.rs:400-403`).

**Record.** `ContextCompactionItem` turn items and `ResponseItem::Compaction
/ ContextCompaction` history items (`compact.rs:256`, `:633`); analytics
records (`CodexCompactionEvent`) carry trigger, reason, implementation,
phase, strategy, status, before/after token counts, cached/cache-write token
counts (`compact.rs:407-494`). `AutoCompactWindowIds` chains
`first_window_id -> previous_window_id -> window_id` across repeated
compactions (`state/auto_compact_window.rs:4-20`, `:77-85`). Resume finds the
compaction in force the same way any resumed history is read: the replaced
history *is* the history — codex does not keep pre-compaction turns
addressable in the live context at all, only in rollout/history storage.

**Overflow.** Inside an ordinary (non-compaction) turn, a
`ContextWindowExceeded` provider error is *not* silently retried: codex marks
total tokens as "full" and returns the error up to the caller
(`session/turn.rs:1659-1661`). Auto-compaction is instead checked and run
*before* each new turn starts (`PreTurn` phase,
`session/turn.rs:344-353`, `CompactionReason::ContextLimit`), so overflow is
prevented pre-emptively rather than recovered from reactively in the common
case. Mid-turn overflow (after a tool result) uses the `PostTurn`/mid-turn
compaction path described above. No evidence was found in these files of
codex deliberately dropping only some of a batch of parallel tool results to
fit a window — the Memento strategy handles overflow by discarding *all*
non-recent-user-message history at once via full compaction, not by
selectively trimming individual tool results.

**UI / headless.** TUI snapshot tests show distinct states for
"compaction running" (including a narrow-width variant), "compaction
completed", and "manual compaction pending", plus a "compact queues user
messages" state (`tui/src/chatwidget/snapshots/`,
`tui/src/chatwidget/tests/compaction_tests.rs`) — while compacting, new user
input is queued rather than interleaved. Headless/RPC consumers get
`ContextCompaction` turn-item start/complete events over the same event
stream as any other turn item, plus (deprecated but still generated)
`ContextCompactedNotification { threadId, turnId }`
(`app-server-protocol/schema/typescript/v2/ContextCompactedNotification.ts`).

**Model-triggered restart.** Not found. No tool-result field or "handoff"
tool was found in `codex-rs/core/src` analogous to pi's planned
`ToolControl.handoff`. The word "handoff" appears only inside the
compaction/summary *prompt text* itself (describing the summary as a
handoff document for the next model to read), not as an API the model can
invoke to restart context on demand.

**Cache.** codex explicitly tracks `cached_input_tokens` and
`cache_write_input_tokens` for each compaction attempt in its analytics
event (`compact.rs:420-425`), and the retry-by-trimming behaviour on
context-window-exceeded during compaction is explicitly justified as
preserving the prefix cache (`compact.rs:316`: "Trim from the beginning to
preserve cache (prefix-based) and keep recent messages intact"). Unlike pi,
the compaction request itself is not forced to an isolated/no-cache call —
it runs as an ordinary prompt on the session, so it can hit the existing
cached prefix.

**Non-summary shortening.** Codex's hook system
(`codex-rs/hooks/src/events/compact.rs`, `ClaudeHooksEngine`) implements
`PreCompact`/`PostCompact` hooks whose JSON I/O schema
(`hooks/schema/generated/pre-compact.command.input.schema.json`) matches
Claude Code's own hook shape almost field-for-field: `hook_event_name:
"PreCompact"`, `trigger: "manual" | "auto"`, `session_id`, `transcript_path`,
`model`, plus a codex-specific `turn_id` extension. This is a direct
compatibility choice, not parallel invention — codex is deliberately
speaking Claude Code's hook protocol.

## Claude Code

No source is available; findings come from `strings` on the shipped binary
(`~/.local/share/claude/versions/2.1.282`, Mach-O arm64, 652,230 string
lines extracted) and from this machine's own session logs
(`~/.claude/projects/**/*.jsonl`).

**Trigger.** An `autoCompactThreshold` is computed per-session; a UI string
found verbatim in the binary states the rule plainly: "This command
configures when auto-compaction happens. The actual threshold is the
minimum of this setting and your model's maximum context window." The
setting itself (`/autocompact [auto|<tokens>]`, argument hint string
`"[auto|<tokens>]"`, `userFacingName(): "autocompact"`) can come from, in
order of precedence, the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment
variable, `settings.json`, an "auto" value tuned per model (the
strongly-recommended default), or an unrecognized-model fallback — the
binary distinguishes these five sources by string (`"env"`, `"settings"`,
`"unknown-model"`, `"model-default"`, `"auto"`) and shows the active source
in the `/autocompact` dialog. Auto-compaction can be disabled: a boolean
`autoCompactEnabled` setting (toggled from the same dialog, string
`"Auto-compact"`), and separately `DISABLE_AUTO_COMPACT` /
`DISABLE_COMPACT` environment variables (string: "Whether auto-compact is
enabled on the worker (autoCompactEnabled setting + DISABLE_AUTO_COMPACT /
DISABLE_COM[PACT])"). Trigger reasons are distinguished in telemetry event
names: `compact_auto` (proactive, threshold-based) vs `compact_reactive`
(driven by an actual overflow — see Overflow below) vs `compact_manual`.

**Cut.** Session logs (this machine's own `~/.claude/projects/**/*.jsonl`,
`type: "system", subtype: "compact_boundary"` records) show a
`compactMetadata` object with `preservedSegment: { headUuid, anchorUuid,
tailUuid }` and `preservedMessages: { anchorUuid, uuids: [...], allUuids:
[...] }` — i.e. Claude Code keeps an explicit, addressable kept tail by
message UUID, conceptually the same shape as pi's `firstKeptEntryId`/
`retainedTail`. The same record carries `preTokens`, `postTokens`, and
`cumulativeDroppedTokens` (a running total across repeated compactions in
the session, confirmed present in real session data:
`~/.claude/projects/-Users-aakshintala-work-cursor-delegate/aa9da102-3884-4980-9f5c-4c31820bce28.jsonl`).
Beyond full compaction, the binary has a distinct, lighter "microcompact"
path (strings: `microcompact`, `microcompact_boundary`,
`tengu_time_based_microcompact`, `compact_micro_keep_recent`,
`compact_kept_tail_announcements`) — a time-based, keep-recent mechanism
separate from the LLM-summarized `compact_boundary` path. No source was
available to confirm exactly what microcompact drops (most likely old tool
results, by naming convention, but this is inferred from strings, not
confirmed from code).

**Summary.** `executePreCompactHooks` / `executePostCompactHooks` strings
confirm the documented `PreCompact` hook runs around compaction, and a
hook can evidently block it (`compact_blocked_by_hook`,
`tengu_compact_replaced_by_hook`). `preCompactDiscoveredTools` is a real
field in a session log's `compactMetadata` (seen in the sample above),
suggesting the pre-compact pass records which tools were in play, similar
to codex's `PreCompact` hook payload. Usage of the compaction call itself is
tracked in detail: `compactionCacheCreationTokens`,
`compactionCacheReadTokens`, `compactionInputTokens`,
`compactionOutputTokens`, `compactionTotalTokens` are all distinct fields in
the binary's strings, alongside `postCompactTokenCount` /
`truePostCompactTokenCount`. A `compact_no_model_fallback_env` /
`compact_no_allowed_fallback` pair of strings suggests a configurable
fallback model for summarization exists, analogous to pi's ability to pick a
different model, but no source confirms the exact mechanism. No prompt text
was recoverable from `strings` (it is assembled at runtime from many small
string fragments in the minified bundle), so no prompt structure can be
described here beyond what the record fields imply.

**Record.** Confirmed directly from a real session log entry
(`~/.claude/projects/-Users-aakshintala-work-cursor-delegate/aa9da102-3884-4980-9f5c-4c31820bce28.jsonl`,
fields only, no content):

```
{ type: "system", subtype: "compact_boundary", content, level,
  compactMetadata: {
    trigger: "manual" | "auto",
    preTokens, postTokens, cumulativeDroppedTokens, durationMs,
    preCompactDiscoveredTools: [...],
    preservedSegment: { headUuid, anchorUuid, tailUuid },
    preservedMessages: { anchorUuid, uuids: [...], allUuids: [...] }
  },
  uuid, timestamp, userType, entrypoint, cwd, sessionId, version,
  gitBranch, slug }
```
Nine session logs across five different projects on this machine contain at
least one such record, with both `trigger` values observed. Resume finding
"the one in force" is, by the presence of `has_compact_boundary` and
`transcriptMayContainCompactBoundary` strings in the binary, evidently a
scan-for-newest-boundary approach, the same shape as pi and codex, but this
inference is from string names only — no source confirms the exact resume
algorithm.

**Overflow.** The string set distinguishes proactive from reactive
compaction clearly: `compact_auto` / `compact_auto_prefix_overflow` /
`compact_auto_rapid_refill_breaker` (threshold-based, checked before it's
strictly needed) vs `compact_reactive` / `reactive_compact_retry` /
`tengu_reactive_compact_triggered` / `tengu_reactive_compact_remote`
(triggered by an actual rejected/overflowing request). A circuit breaker
exists: `tengu_auto_compact_circuit_breaker` with a "consecutive failures"
warning path, implying repeated compaction failures stop being retried
automatically after some count. Claude Code also appears to *precompute*
compaction speculatively before it's needed and swap it in when required —
strings `compact_precomputed`, `precomputed_compact_swap`,
`tengu_precomputed_compact_armed / consumed / discarded / rehydrated /
rearm_capped` — which would let a reactive overflow resolve near-instantly
by using an already-generated summary rather than blocking on a fresh LLM
call. This is a materially different design from pi and codex, both of
which generate the summary synchronously once overflow is detected.

**UI / headless.** `compactionPct` / `compactionPctText` /
`"${Je}% until auto-compact"` strings confirm the TUI status line shows a
live percentage countdown to the next auto-compact. `isShowingCompactMessage`
/ `isCompacting` / `Compacting` strings back a visible "Compacting…" state.
No RPC/headless event names specific to compaction were confidently isolated
from the string dump (the minified names are too generic to attribute with
confidence), so this axis is not fully resolved for Claude Code from
`strings` alone.

**Model-triggered restart.** No evidence found. Every `handoff`-named string
in the binary (there are dozens) is about *process/terminal* handoff —
raw-mode terminal control, background process exit handoff, login/consent
handoff, bridge/desktop handoff — none of it relates to conversation
context. No tool name, no `ToolResult` field, nothing resembling pi's
planned `control.handoff` was found. Nothing suggests the model can trigger
compaction or a context restart itself; every compaction path found
(`compact_auto`, `compact_manual`, `compact_reactive`, `microcompact`) is
driven by the harness's own token accounting or by the user's `/compact` /
`/autocompact`.

**Cache.** As noted above, Claude Code tracks `compactionCacheCreationTokens`
and `compactionCacheReadTokens` as first-class fields, distinct from
`compactionInputTokens`/`compactionOutputTokens` — meaning cache
reads/writes on the compaction request are measured and presumably reported,
unlike pi (which forces `cacheRetention: "none"` on summarization requests,
explicitly to avoid paying for a cache write that will not be reused). This
suggests Claude Code's compaction call is not necessarily an isolated,
never-cached side request; strings `tengu_compact_cache_prefix`,
`tengu_compact_cache_sharing_fallback`, and
`tengu_compact_cache_sharing_success` further suggest an explicit attempt to
share the existing cached prefix with the compaction request, with a
fallback path when that sharing fails. This could not be confirmed further
without source.

**Non-summary shortening.** Confirmed: `microcompact` /
`microcompact_boundary` / `tengu_time_based_microcompact` /
`compact_micro_keep_recent` is a distinct, lighter-weight, time-triggered
mechanism from full LLM-summarized compaction. No confirmation of tool-result
clearing specifically (i.e. dropping old tool outputs while keeping the rest
of a turn) was found by name in the string set; `tengu_declared_tools_dropped_at_compaction`
exists but names tool *declarations* being dropped at compaction time, not
an independent mid-session tool-result-clearing mechanism.

## Comparison table

| | pi 0.87 (shipped) | pi rewrite (unshipped design) | codex | Claude Code 2.1.282 |
|---|---|---|---|---|
| 1. Trigger | `contextTokens > contextWindow - reserveTokens` (default reserve 16,384, keep 20,000); manual `/compact [instructions]`; per-model overrides; `enabled: false` disables | same shape, formalised as `resume_checkpoint`/`finish`/`commit_navigation` boundaries | `auto_compact_scope_tokens >= limit + fallback_buffer` OR `active_context_tokens >= context_window * pct`; separate end-of-turn percent check; manual via `compact` task / RPC; `TokenBudget` feature swaps in a no-LLM strategy; `DISABLE_*` env vars found in CC only, not codex | `min(configured window, model max context)`; window source is env var, settings, per-model "auto", or unrecognized-model default; manual `/compact` and `/autocompact [auto\|<tokens>]`; `autoCompactEnabled` + `DISABLE_AUTO_COMPACT`/`DISABLE_COMPACT` disable it |
| 2. Cut | Message boundaries only, never at a tool result; verbatim tail sized by `keepRecentTokens` (token-measured); can split mid-user-span at an assistant message | same message-boundary rule; tail is a copied `retainedTail`, not a pointer; context never reads past a compaction | Can cut mid-turn, including after a tool call/result; default strategy keeps only up to 20,000 tokens of recent *user* text (not a full verbatim tail) plus one summary — closer to "replace everything" than "keep a tail" | Kept tail is explicit and UUID-addressed (`preservedSegment`, `preservedMessages`); a lighter "microcompact" also exists, keep-recent, non-LLM |
| 3. Summary | Session's own model by default, swappable via hook; isolated call (`cacheRetention: "none"`, fresh session id); structured sections (Goal/Constraints/Progress/Decisions/Next Steps/Critical Context); previous summary folded in | same isolation rule (`cacheRetention: "none"`, fresh identity) at the harness layer | Session's own model, in-band as an ordinary turn (not forced no-cache); prompt frames itself as a "handoff summary for another LLM"; asks for progress, context/constraints, next steps, critical references; no custom-instructions param found | Model and isolation not confirmed from strings; usage of the compaction call itself is tracked in detail including cache tokens; prompt text not recoverable from strings |
| 4. Record | `CompactionEntry{summary, firstKeptEntryId, tokensBefore, usage?, fromHook?, details?}` appended to session log | `retainedTail` copied inline in the compaction entry; "context never reads past a compaction" | `ContextCompactionItem`/`ResponseItem::Compaction` replace history directly; chained `AutoCompactWindowIds`; no pre-compaction turns stay addressable in live context | `type:"system", subtype:"compact_boundary"` with `compactMetadata{trigger, preTokens, postTokens, cumulativeDroppedTokens, preservedSegment, preservedMessages, preCompactDiscoveredTools}` — confirmed from real session logs on this machine |
| 5. Overflow | One compact-and-retry recovery attempt per run; keeps `context_edit` omissions even if recovery compaction fails; no evidence of selective tool-result dropping | same recovery shape; `overflowRecoveryUsed` blocks a second loop in one run | Normal-turn overflow is *not* auto-retried inline (marks tokens "full", returns the error); pre-turn auto-compact prevents most overflow pre-emptively; mid-turn overflow uses the mid-turn compaction path; compaction-of-the-compaction-call overflow trims from the front and retries | Distinguishes `compact_auto` (proactive) from `compact_reactive` (overflow-driven); has a circuit breaker after repeated failures; appears to precompute a summary speculatively and swap it in on overflow for near-instant recovery |
| 6. UI / headless | `session_before_compact`/`session_compact_failed` extension events carry `reason` and `willRetry` | same events, same shape, at the harness layer | TUI states for running/completed/pending compaction; queues new input while compacting; RPC gets `ContextCompaction` turn items plus deprecated `ContextCompactedNotification` | TUI shows a live "N% until auto-compact" countdown and a "Compacting…" state; no RPC/headless event names confidently isolated from strings |
| 7. Model-started restart | Not present; only a user-triggered `/handoff` extension that starts a *new* session with a generated prompt | Designed, not implemented: `ToolControl.handoff?: string` on a tool result causes Post-tools to write a "headed handoff entry" *within the same conversation*, no second LLM call required; also a host-level `Conversation.reset(handoff)` | Not found; "handoff" appears only in the compaction prompt's own wording, not as an invocable mechanism | Not found; every `handoff` string in the binary is process/terminal handoff, unrelated to conversation context |
| 8. Cache | Summarization forced to `cacheRetention: "none"` — explicitly a non-cached, non-reused call | same rule, explicit in both the docs and the harness spec | Compaction call is an ordinary in-band turn; explicitly trims from the front on retry "to preserve cache (prefix-based)"; tracks cache tokens per compaction attempt | Tracks `compactionCacheCreationTokens`/`compactionCacheReadTokens` as distinct fields; strings suggest active cache-prefix sharing with a fallback path, unconfirmed from source |

## Open contradictions and things that may cut against assumption

- **pi 0.87 does not ship a model-triggerable handoff**, despite shipping an
  example extension literally named `handoff.ts`. That extension is a user
  slash command that starts a brand-new session; it is not the model
  deciding to restart its own context. The genuinely model-triggerable
  version (`ToolControl.handoff` in `pico-v5.md`) exists only as an
  unimplemented design in the rewrite repository, confirmed absent from the
  shipped `dist/` by direct grep. If the ticket assumed pi 0.87 ships a
  working model-driven handoff, that assumption does not hold.

- **Claude Code does not let the model compact or hand off**, as far as
  `strings` and session logs show. Every compaction path found is driven by
  the harness's token accounting or the user's own command. If the ticket
  assumed otherwise, that assumption does not hold either — though this is a
  negative result from `strings`, not from source, so it is weaker evidence
  than the pi/codex source-level negatives.

- **codex's compaction is not "keep a verbatim tail"** the way pi's is. The
  default strategy discards essentially all prior turns and keeps only
  recent *user* text (capped at 20,000 tokens) plus a generated summary.
  Anyone assuming all three agents use a pi-style sliding kept-tail would be
  wrong about codex specifically.

- **codex speaks Claude Code's hook protocol on purpose.** codex's
  `PreCompact`/`PostCompact` hook JSON schema matches Claude Code's
  documented hook shape closely enough (`hook_event_name`, `trigger:
  "manual"|"auto"`, `transcript_path`, `session_id`, `model`) that this
  reads as deliberate compatibility, not convergent naming. Worth knowing if
  Fiber ever designs a hook surface: there may already be a de facto
  standard here.

- **Cache treatment diverges sharply.** pi and its rewrite both force
  compaction summarization to be an isolated, never-cached call. codex does
  the opposite by default (in-band turn, cache-aware retry-by-trimming) and
  explicitly measures cache tokens for the compaction call. Claude Code's
  strings suggest it tries to share the cache prefix and falls back when
  that fails. These are three different answers to the same design question,
  not one converged-on approach — worth a deliberate choice for Fiber rather
  than picking whichever is default in the library used for reference.

- **Claude Code appears to precompute compaction speculatively** (strings:
  `compact_precomputed`, `precomputed_compact_swap`,
  `tengu_precomputed_compact_armed`/`rehydrated`), which neither pi nor
  codex's read source does. If true, this changes the "what does overflow
  recovery cost" analysis materially: a precomputed swap is much cheaper
  than pi's or codex's synchronous compact-then-retry. This is inferred from
  string names only; no source confirms the mechanism.
