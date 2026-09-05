# Pending enhancements

Work deferred out of the Fiber transition for being net-new capability rather
than reshaping of inherited behavior.

The transition ends at Phase 6. It is step one, not the release. Fiber is
stamped `0.0.1` only once the product matches what it should be, and the items
below are part of that gap. Deferring them is not a decision to drop them.

Everything here was scoped, argued, and deliberately postponed during Phase 3
contract planning on September 4, 2026. The reasoning is recorded so the work
does not have to be re-derived.

## Why these are not transition work

The transition has a definition: reach a Fiber-shaped surface on inherited
behavior. Renaming `--cursor` to `--continuation`, exposing an existing
`deleteCommittedSession` through the CLI, and reconnecting
`addPermissionRule` to a command are all reshaping — the behavior exists and
the transition changes its spelling or its reachability.

Building token accounting that nothing computes today is not. Every item that
survives the reshaping test is an argument for the transition never ending.

## Context occupants

`/context` ships in the transition with usage only: tokens used, the model's
window, the percentage. The design also asked for **occupants** — the
per-component breakdown of what fills the window.

Nothing in the tree computes it. The only per-component accounting that exists
is for history: `estimateHistoryTurnTokens` and `selectBudgetedHistoryTurns`
(`src/core/session/session.zig:2470,3260`) and
`historyContextBudgetTokensForCapabilities`
(`src/core/agent/runtime/prompt_context.zig:12`). Nothing counts the system
prompt, tool definitions, MCP tool schemas, or skills.

Target: a full breakdown — system prompt, tools, MCP schemas, skills, history,
files — which means per-component token accounting across the prompt assembly
path. A coarse version (history versus everything else, by subtraction) was
considered and rejected: the residual inherits every error in the history
estimate, and the reason to run `/context` is to know what to evict.

Related: surfacing context usage in `fiber ask --json` and `fiber session show`.
The numbers exist (`session_usage.zig:1352 LiveContextSnapshot`); the plumbing
into those two payloads does not.

## `/background`

Interactive inspection and termination of processes the agent started in the
background. Unlike everything else in this file, this was not designed as
new work — the product-transition doc lists `/background` as though it
reconnects existing behavior: "Keep `/background` for interactive
background-process inspection and termination."

It doesn't reconnect anything. `/background` is fully unregistered today
(confirmed: rejected as unknown, absent from welcome text) with no backing
registry — nothing tracks a spawned background command's id, PID, or log
path after it starts. The one thing that exists is an approval gate
(`ApprovalReason.background_process` in `command_effect.zig`) deciding
whether running a command in the background needs sign-off; nothing after
that gate.

A real implementation existed upstream: `src/core/background/` carried
`background_runtime.zig` (4,250 lines), `background_store.zig` (1,479),
`process_supervisor.zig` (1,362), plus `background_commands.zig`,
`background_launch_identity.zig`, `background_launch_output.zig`,
`background_record_liveness.zig`, `background_record_restore.zig`,
`server_detection.zig`, and `execution/background_process_provider.zig` —
roughly 9,000 lines total, present as of the `fx` `v0.0.7` tag. It was
deleted in `3f59a59d` ("Unify command execution under shell", 2026-09-01)
**before** Fiber's fork (`4308bd43`), so Fiber never had it. That commit's
message claims the capability survived as "one managed shell lifecycle"
with "Ctrl-X visibility... preserved through the existing runtime
boundaries" — but what actually made it into the tree Fiber forked from is
only the start half (`terminal.start`, the one lifecycle op in the tool
registry). There is no `terminal.list` or `terminal.stop`, and the
`ctrl_x_manager_byte` constant that commit promised
(`src/core/app/app_input_runtime.zig:82`) is declared but never dispatched
anywhere — dead code, not a working entry point.

So this is not "expose an existing capability" and not "build genuinely
net-new capability" either — it's a migration that shipped half-finished
upstream, before Fiber existed. Deferred here pending a decision on how
much of the deleted subsystem is worth rebuilding versus what a minimal
`/background` could get away with. Not scoped or sized yet.

## `fiber debug trace`

`debug replay` moved under the new hidden `debug` parent cleanly in the
transition (`fiber debug replay <tape>` calls the same `cli_replay.run`
the bare command always called — pure reachability change). `debug trace`
does not, for a structural reason `replay` never had: its only backing
function has no non-interactive data source.

`/trace` (the interactive slash command) exists to answer "something's
wrong with *this conversation right now*" — `buildTraceReport`
(`src/core/app/app_commands.zig:1953`) reads live in-memory `App` state:
current turn history (`app.session.agent.history.items`), live permission
mode, the `fast_mode` flag, the current workspace. It was designed
exclusively for a live interactive session and was never meant to run
outside one.

A one-shot `fiber debug trace` CLI invocation has no live `App` to read.
The natural fix is reworking `buildTraceReport`'s input to read the most
recently saved session from disk instead (the same `session_store` read
path `session show`/`session recover` already use) and building the same
report shape from that session's history — but that's redesigning what
the function draws from, not exposing something that already works
headless. Not scoped or sized yet.

## `fiber mcp doctor`

Opening MCP transports to check that configured servers actually answer. The
design originally paired this with removing `mcp list --connect`, and the
removal already happened — `mcp list` rejects the flag at
`src/core/cli/cli_surface.zig:1590`. So the diagnostic is gone with nothing
replacing it.

Net-new: no command opens transports for a health check today. Renaming
`mcp auth` to `mcp login` is transition work and ships in Phase 3; `doctor` is
not.

## `fiber usage --session <id>`

A new query dimension on `usage`. Today only `--period <24h|7d|30d>` exists,
reporting profile windows. Per-session accounting is a different aggregation,
not a rename.

## Multi-provider

`ProviderId` has one variant today (`src/core/config/model_provider.zig:4`),
one `CredentialSource`, and `provider_set.select()` ignores its argument
(`src/core/gateway/provider_set.zig:48`). The seam is deliberately retained —
the deleted Grok provider is the template for how a second one attaches.

The transition ships auth surfaces **shaped** for several providers and
implemented against the one that exists: arrays rather than scalars, provider
arguments required or picked rather than assumed. Actually attaching a second
provider — catalog merge across providers, per-provider credential resolution,
an active-provider concept that is not hardcoded to `.codex` — is enhancement
work.

## Testing story

Phase 5 owns the transition's own testing revisit. What belongs here instead is
whatever that revisit decides Fiber needs beyond restoring inherited coverage.

Two known inputs:

- The session-recovery harness needs rebuilding on a non-ACP crash-injection
  path. The boundary hooks are generic and live in
  `src/core/session/session_log.zig:2218,3296`; only the wiring was ACP's. The
  16 cases that suite proved are transcribed in the transition plan.
- The end-to-end suite will be substantially stale by the end of Phase 3, by
  decision: the JSON envelope changes 13 payload shapes, and only the Zig unit
  tests in `output_contracts.zig` are updated as slices land.

## ACP

Deleted in the transition. Recorded here only so the decision is findable:
nobody drives Fiber through an ACP client, and `src/acp/prompt.zig` was a
second full agent host, 4,659 lines on the same session store and permissions
as the CLI, doubling the cost of every contract change.

If an editor integration is ever wanted, this is a re-implementation against a
then-current protocol, not a revert. The deletion is recorded in
`../transition/demolition-inventory.md`.
