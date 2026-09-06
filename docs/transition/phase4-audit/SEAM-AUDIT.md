# Slice 26: implementation-seam audit

Closes the audit the inventory opened. The old blanket layering premise stays
withdrawn; this replaces it with measurements.

## What is actually in the tree

| Seam kind | Count | Note |
| --- | --- | --- |
| Hand-rolled Fiber vtables | **0** | see below |
| Callback tables (structs with >=2 function-pointer fields) | 36 | |
| Types named `Provider` | 4 | |
| `ProviderId` variants | 1 (`codex`) | already collapsed; retained by owner decision |

**There are no hand-rolled vtable seams left to collapse.** Every `vtable`
occurrence in `src/` is a Zig 0.16 `std.Io.Reader` / `std.Io.Writer`
implementation -- `.vtable = &.{ .drain = drain }` and friends -- which the
standard library requires. They are not optional Fiber plumbing and step 5 does
not apply to them.

## The four `Provider` seams

Steps 1-3 of the audit, measured by counting assignments to each interface's
distinctive function-pointer field.

| Seam | Production adapters | Unavailable | Test adapters |
| --- | --- | --- | --- |
| `workspace/context_contract.Provider` | 1 (`builtins/context.zig:44`) | 0 | **17** |
| `execution/process_provider.Provider` | 1 (`tools/shell/process_provider.zig`) | 1 (in `core/execution`) | 3 |
| `notifications/notification_contract.Provider` | 1 (`builtins/hooks/notifications.zig`) | 0 | -- |
| `session/prompt_history_provider.Provider` | 1 (`app/prompt_history_runtime.zig`) | 0 | -- |

Step 4, the boundary each protects, and step 6, the evidence to retain it:

Every one of these has exactly one production adapter, which by the letter of
"collapse one-implementation vtables" reads like a fossil. It is not. Step 5 says
to collapse when no real variation **or effect boundary** remains, and each of
these is an effect boundary in the strict sense -- filesystem reads for project
context, process spawning, OS notification delivery, prompt-history storage --
and each is substituted by test doubles rather than by a second production
implementation. `context_contract.Provider` alone has **17** test adapters across
`cli_ask.zig`, `cli_surface.zig`, `app_agent_runtime.zig`, `app_entry_runtime.zig`,
`tool_runtime.zig`, `tool_flow.zig`, and its own tests.

Collapsing them would not delete a guess about a provider set that does not
exist; it would force seventeen tests to touch the real filesystem. **Retained,
with the counts above as the evidence step 6 asks for.**

This is a different situation from the provider seam the owner ruled on. That one
was plumbing shaped for Gateway, Grok, and Vercel -- deleted vendors. These four
are I/O boundaries that would exist under any vendor set.

## `core -> builtins` imports

The inventory asks to resolve "the existing production `core -> builtins`
imports". Measured with test blocks stripped:

- **11 are already test-guarded** as `if (builtin.is_test) @import(...) else struct {}`, so production never imports builtins through them. Nothing to resolve.
- **18 import sites remain unguarded**, but 4 of those are in `core/agent/runtime/tests/`, which are test-support modules that merely lack a `test {}` wrapper.
- That leaves roughly **14 genuine production sites across 10 files**: `assistant_stream.zig`, `tool_presentation.zig`, `tool_preparation.zig`, `app_agent_runtime.zig`, `app_commands.zig`, `app_mcp_menu_runtime.zig`, `app_session_runtime.zig`, `model_cache_runtime.zig`, `cli_surface.zig`, `command_router.zig`, and `command_specs.zig`.

Moving those to `main.zig` composition or a typed dependency is a real
architectural refactor of ten files, not cleanup, and the shape it should take
(constructor injection vs a registry passed down) is a design decision.
**Left for the owner**, with the site list above as the worklist. Note the
boundary is much closer to being real than the inventory assumed: two thirds of
what looked like a violation is already either test-guarded or test-support code.

## Inherited measurements, all now closed

**`host.Capabilities.terminal`** (from Slice 15c) -- **retain**. `TerminalSupport`
is two-valued and the field is read at `tool_dispatch.zig:65` to gate terminal
tool availability, with a test at `:1505` constructing `.unsupported` to exercise
that gate. Production always resolves `.supported` because
`terminalSupportForOs` takes a **runtime** `os_tag`, which the platform slices
established is live code rather than a comptime branch.

**`LoginPollDeps.poll_device_token`** (from Slice 16b) -- **retain, and the
original characterisation was wrong**. It was recorded as a defaulted function
pointer with one overriding caller. It has no default at all
(`login_flow.zig:413` is a plain `*const fn`) and two production assignments:
`login_flow.zig:735` in the runtime deps builder and `chatgpt_oauth.zig:89` with
`pollBrowserToken`. That is real variation across a genuine boundary. This closes
the last thread from the Slice 16b correction.

**The model-catalog field question** (from Slice 16) -- **retain**, already
settled by the owner decision quoted in the inventory: `modelProviderRank`,
`modelTierRank`, `featured_picker_families`, and the `ModelProviderFilter` enum
stay whole because those rows are inert but observable.

**The subagent relationship index** (from Slice 21) -- **retain, owner
question.** Production reads `relationship-index.bin` at
`session_store.zig:3053`; the only writer in the repository is a test fixture at
`:10368`. `encodePage` has no reference at all. Git archaeology is inconclusive:
the codec predates the fork point, so Fiber may never have written the file.
The reader is harmless -- the file never exists, so it takes the not-found path
and continues -- and by the inert-versus-observable bar it does not render, rank,
or mislead. Deleting ~330 lines of codec plus its reader is a product call about
whether the subagent relationship index is a feature to finish or to drop.
**Not cleanup. Owner decides.**

**`reportTurnControl`** (from Slice 23) -- **retain, owner question.** Production
wires `turn_control_sink` at `tool_runtime.zig:740` and the orchestrator acts on
the result at `orchestrator.zig:8485`, but no tool calls the reporter, so
`turn_control` is always null and that branch never runs. This is a complete
extension seam missing only its callers. Whether a tool should be able to end a
turn is a product question.

## Summary

Nothing in this slice was collapsed, and that is the finding. The plumbing the
owner ruled on -- one-arm switches, threaded `ProviderId` parameters,
one-implementation wrappers -- was already removed by Slices 10 through 15c and
the sweeps. What remains under the word "seam" is four I/O effect boundaries with
seventeen-to-one test-to-production adapter ratios, a `ProviderId` deliberately
kept at one variant, and two unfinished features. Each is retained with its
measurement recorded, which is what step 6 requires.
