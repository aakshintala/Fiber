# Deferred within the transition

Small cleanups found while executing a slice that belong to a *later phase of
this transition*, not to the slice that found them. Each was left alone
deliberately so a slice would not widen past its spec.

This is not `docs/enhancements/pending.md`. That file holds net-new capability
deferred **out** of the transition. Everything here is transition work with a
known phase.

Line numbers were verified at the commit that added the entry. Re-verify before
acting; the demolition moves lines constantly.

## Phase 4: Simplification

| Site | What | Why deferred |
|---|---|---|
| `src/core/mcp/elicitation.zig:934` | `parseTitledChoices` takes `allow_description: bool`, passed `false` at both call sites (`:827`, `:921`). It existed only to express `wire == .acp`. The branch it guards is dead. | Same shape as the one-element-seam collapses Phase 4 already owns. Slice 22 created it and correctly did not widen to fix it. |

## Phase 5: Repair and verification

Recorded in `plan.md`, not duplicated here:

- Session-recovery harness — `plan.md`, "Session-recovery harness: what the deleted suite proved".
- Four retained ACP-driven E2E cases — `plan.md`, "ACP-driven cases retained for conversion". Each still spawns the deleted `fiber acp` subcommand and is red until converted.

## Phase 6: Documentation and naming

All inert. None affects behavior; none is covered by any slice's exit search.
This is the complete `grep -rni acp src/` residue as of `HEAD`.

**Misleading names**

| Site | What |
|---|---|
| `src/builtins/modes.zig:27` | Test named "built-in modes register exact ACP order and permission policy". It asserts `all` is exactly `{code, ask}` in order — mode registration, nothing ACP-specific. Test is correct; the name is not. |

**Stale doc comments**

- `src/core/tooling/tool_mcp_runtime.zig:155` — "the unique outbound ACP elicitation id"
- `src/core/tooling/tool_runtime.zig:152` — "e.g. ACP hosts prompt over JSON-RPC"
- `src/core/tooling/tool_runtime.zig:202` — "running outside an interactive TUI (e.g. ACP)"
- `src/core/hosts/native_keychain.zig:94` — "ACP clients launched by GUI editors"
- `src/core/mcp/elicitation.zig:1067` — "ignored ACP fields"
- `src/builtins/gateway.zig:21` — "used by ACP/CLI test configurations"

**Inert strings and one dead assertion**

- `src/core/slash_commands/command_specs.zig:1085` — negative assertion that the
  help text does not contain `"Supported for interactive, resume, ask, ACP, PR,
  and issue launches"`. Vacuous: that string can no longer be produced. It sits
  in a wall of identically-shaped absence guards, so deleting one line is churn
  — fold it into the Phase 6 pass or drop the whole guard.
- `src/core/images/image_attachments.zig:493,497` — temp-file template
  `"image-{d}.acp-source.{x}"` and debug label `"capture_acp_source"` in
  `captureInlineImageBytes`. ACP-derived (commit `45d6d24a`), but an internal
  temp-filename discriminator, not a contract.
- `src/core/agent/runtime/tests/tool_flow.zig:3776` — fixture
  `.transport_id = "acp-call-write"`. Arbitrary label.
- `src/core/mcp/mcp_runtime.zig:14771` — `"acp-early"`, a fake completion id
  returned by a test double inside the test at `:14738`.
