# Feedback from the failed pi GUI integration

Status: initial observations and audit, under discussion

Priority: input to the Fiber product transition and to session traversal

Last updated: September 5, 2026

## Why this document exists

A GUI front end (pane) was built on top of the pi coding agent and the integration
failed in ways that cost real debugging time. The eight observations below are the
firsthand lessons from that failure. They are recorded as received: they are missing a
lot of context about pi's internals, and they name pi-specific symbols
(`message_end`, `createToolResultMessage`, `OrdinalProjection`, `disableStrictTools`)
whose exact meanings were not verified. Treat them as a failure signature, not as a
specification.

Each observation is paired with an audit of fiber's current code, so the lessons are
grounded in what fiber actually does rather than in what the source harness did. The
audit was performed in September 2026 against `main` at commit `6fc7bdd7`.

A side artifact from the same effort is a Databricks model catalog plugin for pi
(single-file TypeScript extension). It is kept as reference evidence for the provider
shape: its core mechanic is per-model routing, where each discovered model carries its
own wire API, base URL, and metadata. That matches the routing constraint already
decided in [Providers](providers.md), where the routing key is the model, not the
provider.

## Decision summary

Most of the lessons already hold in fiber. The two that do not are unknown-config
rejection and the live tool path's provisional-to-authoritative identity
reconciliation. Both are candidates for the transition's deferred list rather than
drive-by fixes, because both intersect the cutover and the session traversal design.

## The eight observations, with audit findings

### 1. Stable id at emit, shared by live and durable

Observation: a live frame and its durable form should share one id, assigned before
first emit, so persisting is an idempotent merge rather than a reconciliation. The
claimed payoff is deleting live message authoring, later stamping, and read-back.

Audit: fiber satisfies this on the durable side and violates it on the live tool path.

- Durable events get their identity exactly once at append. The envelope carries
  `log_generation`, `seq`, and `event_id` assigned in `appendEventImpl`
  (`src/core/session/session_log.zig`, around line 3068), and the same envelope is
  encoded, stored, and replayed. The log is append-only, so there is no merge and no
  read-back.
- The live tool path uses provisional ids that are later reconciled:
  `authoritative_started.reconciles_provisional_call_id`
  (`src/core/shared/types.zig` around line 150), `ToolCall.provisional_id`
  (around line 620), and a late `final_identity` reconciliation. This is the same
  stamping pattern the observation warns about.
- Live transcript entries use a UI-local `entry_id: u32` counter
  (`src/core/output/transcript_presentation.zig` around line 31) that shares no key
  with durable events; streaming deltas carry no id at all. Resume rebuilds the
  transcript by replaying history, not by keying on shared ids. The only join key is
  the optional `work_id` on `HistoryTurnCommitted`.

Finding: no action needed on the durable log. If live and durable identity are ever
unified, the reconciliation machinery (`reconciles_provisional_call_id`,
`provisional_id`, `final_identity`) and the UI-local counters are what would be
deleted. That is a transition-scale change, not a small fix.

### 2. Monotonic per-session ordinal assigned by the producer

Observation: if a since-bounded backfill cursor is wanted, the producer assigns the
ordinal at emit. Never make clients reconstruct order by scanning. The named failure
was an O(N²) ordinal projection.

Audit: satisfied. `seq` is assigned as `through_seq + 1` at append, a
`SequenceValidator` rejects non-contiguous sequences and generation changes
(`src/core/session/session_event.zig`), and `replayFromCheckpoint` resumes mid-log
from `ReductionStart{generation, next_seq}` with checkpoint cursors anchored in the
projection manifest. No consumer rescans from byte zero.

### 3. Stable session identity; lineage as explicit parent links

Observation: do not rotate the session id on clear or fork. Fork should be a new
session with a parent pointer. The claimed failure was a pane-id to backend-id mapping
layer that existed only because ids rotated.

Audit: satisfied today, with one design flag for session traversal.

- Ids are never mutated in place. `/clear` parses as `/new`
  (`src/core/slash_commands/command_router.zig` around line 152): the old session is
  retired untouched and a fresh session with a fresh id begins.
- The only re-id is corruption recovery, which mints a new id and records both
  `source_session_id` and the recovered id. That is already a new session derived
  from a source.
- There is no pane-id to backend-id mapping layer anywhere in `src/ui/` or
  `src/core/hosts/`.
- Subagent children carry an explicit durable `parent_id`
  (`src/core/subagent/child_state.zig` around line 181) plus a slot-indexed
  relationship index.

Flag: `DurableSessionState` has no `parent_id` field. When fork is designed in
[Session traversal](session-traversal.md), add the parent link as a first-class field
rather than following the recovery precedent of carrying both ids only in a transient
result.

### 4. Terminal events carry their own id and full payload

Observation: pi's `message_end` carried no id, and the live tool projection was
poorer than the durable tool result created later, which forced read-back and a
persist-suppression rule. Emit the complete payload once, on a self-identifying
terminal event.

Audit: mostly satisfied.

- `ToolLifecycleEvent.terminal` carries its own id and the result and result memory,
  and the durable record is built from the same values at the same emit point through
  `makePersistedToolResult` (`src/core/agent/execution_memory.zig`). No read-back and
  no persist-suppression rule exist.
- Thin spot: denied and deferred terminals emit `result: null`, and the durable side
  reconstructs content from a sentinel string instead of a payload.

### 5. Explicit typed durable-versus-transient discriminant

Observation: the event schema should mark durable versus transient with a typed
discriminant, not an inferred one. The named trap was a tagged union where durability
had to be inferred from shape (delta-only meant transient).

Audit: satisfied structurally, with one inference-shaped violation.

- Durability is a closed ten-variant `Kind` union; unknown kinds are rejected at
  decode. Transient events live in separate types (`stream_provider.Event`,
  `ToolLifecycleEvent`, `assistant_presentation.Event`) that cannot enter the log.
- Violation: `isDeferredToolResult` and `isContextDeferredToolResult`
  (`src/core/shared/types.zig` around line 839) recover whether a persisted tool
  result was actually executed by string-matching sentinel output ("Not executed").
  The typed information already exists on the live `ToolOutcome` (`.deferred`) but is
  lost at persistence and re-inferred on read. Carrying the outcome kind through to
  `PersistedToolResult` would replace the string matching.

### 6. Reject unknown configuration; never silently ignore

Observation: a configuration field that does not exist was silently dropped, so a
user's setting did nothing (an all-zero usage signature) and cost real debugging.
Unknown field should be a hard error.

Audit: violated, and the silent behavior is enshrined in a test.

- Unknown top-level keys are silently dropped. The test "legacy sandbox keys are inert
  unknown data" (`src/core/config/config_runtime.zig` around line 3044) asserts that a
  nonexistent key produces zero diagnostics.
- The fix is close: profile-only keys in project config already produce loud
  `ConfigDiagnostic`s surfaced at startup, in CLI output, and in `fiber doctor`, and
  `context_limits` already rejects unknown sub-keys. Emitting an unknown-key
  diagnostic from the same parse path would use plumbing that exists end to end.
- A hard error may be too strong for forward compatibility across versions; a loud
  diagnostic naming the unknown key and its layer satisfies the lesson's intent.
  This decision should be made explicitly, not inherited from the current test.

### 7. Explicit, validated plugin lifecycle phases

Observation: in pi, only `registerTool` was legal at load and action methods threw,
which meant the lifecycle was not legible. Make phases first-class.

Audit: fiber has no third-party plugin system, so the failure cannot occur. The two
nearest analogues already do the discipline the lesson wants:

- Internal hooks have a register-then-freeze contract with a typed
  `error.RuntimeFrozen` after freeze (`src/core/hooks/`).
- MCP servers have phased, policy-driven lifecycle: a pure admission function, protocol
  negotiation, schema validation, and generation-checked access revalidated at call
  time rather than trusting load-time registration.

Residual gap: the phase ordering is encoded in code, not stated as a legible contract,
and the main MCP runtime file is very large. If executable extensions are ever built
(see [Builtin customization and extensions](builtin-customization-and-extensions.md)),
the hooks freeze pattern is the template, and phase legibility should be part of the
contract from the start.

### 8. Keep durability and supervision harness-agnostic behind a clean frame protocol

Observation: the death-net, journal, and reconnect-resync of the GUI front end should
not be re-litigated per backend. Design the frame wire as the neutral contract from
day one.

Audit: largely holds.

- The terminal recording tape (`src/core/workspace/record_tape.zig`) is a byte-tagged
  frame protocol with a symmetric parser, fed identically by the tmux and native
  terminal backends, with replay tooling in the CLI.
- The session log is event-sourced with sequence validation, recovery staging, and
  checkpoint replay. Provider transport never leaks into the log; committed turns are
  generic.
- Residual: these are two separate frame protocols with separate replay tooling, and
  the session event vocabulary is fiber-product-specific rather than neutral. That is
  a deliberate, versioned schema choice, not accidental entanglement, and it is
  acceptable.

## Summary table

| # | Lesson | Verdict in fiber |
| --- | --- | --- |
| 1 | Stable id at emit | Durable log: satisfied. Live tool path: provisional-to-authoritative reconciliation exists |
| 2 | Producer-assigned monotonic ordinal | Satisfied |
| 3 | Stable session identity, parent links | Satisfied; add `parent_id` when fork is designed |
| 4 | Terminal events carry id and full payload | Mostly satisfied; deferred terminals reconstruct from sentinels |
| 5 | Typed durable-versus-transient discriminant | Satisfied except deferred-result string matching |
| 6 | Reject unknown config | Violated; silent drop is tested-in as intended |
| 7 | Explicit plugin lifecycle phases | No plugin system; hooks and MCP analogues already do it right |
| 8 | Harness-agnostic frame protocol | Largely holds |

## Suggested follow-ups

- Record the two actionable findings in the transition's deferred list: unknown-key
  diagnostics (observation 6) and carrying the deferred outcome as a typed field
  instead of sentinel string matching (observation 5). Both are small once scheduled,
  and both intersect the cutover.
- Carry one constraint into the session traversal design: durable parent links on
  derived sessions (observation 3).
- Do not act on observation 1 now. Unifying live and durable identity is a
  transition-scale redesign and the current reconciliation machinery works; revisit
  only if the reconciliation cost becomes visible in product bugs.

## Related

- [Fiber product transition](fiber-product-transition.md) — the cutover that owns the
  durable log and identity formats
- [Session traversal](session-traversal.md) — where the fork and lineage decision lands
- [Providers](providers.md) — the per-model routing shape the Databricks plugin
  evidence supports
- [Builtin customization and extensions](builtin-customization-and-extensions.md) — the
  decision that governs whether a plugin lifecycle ever exists in fiber
