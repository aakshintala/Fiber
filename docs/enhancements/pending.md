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
