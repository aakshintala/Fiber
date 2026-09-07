# Deferred within the transition

Small cleanups found while executing a slice that belong to a *later phase of
this transition*, not to the slice that found them. Each was left alone
deliberately so a slice would not widen past its spec.

This is not `docs/enhancements/pending.md`. That file holds net-new capability
deferred **out** of the transition. Everything here is transition work with a
known phase.

Line numbers were verified at the commit that added the entry. Re-verify before
acting; the demolition moves lines constantly.

Each phase opens by clearing its own section here, and that clearing is written
into that phase's exit criteria in `plan.md`. This file is deleted at the end of
Phase 6 with the rest of the transition documents, and unlike them it is not
harvested first — it carries work, not rationale. A section still holding
entries at that point means a phase closed without finishing.

## Phase 3: Contract shaping

Cleared 2026-09-04 (folded into Slice 8's commit): `cli_ask.zig`'s `testConfig()`
synthetic `command_usage` string was updated to match the real `ask` usage
string in `commands.zig` (it had drifted through Slices 2b and 4c — stale
`--no-color`, and stale `--auto|--yolo`/`--prompt-permissions` from before
`--permission-mode`). One line, no behavior; nothing asserted on its content.

## Phase 4: Simplification

Cleared 2026-09-05 into
[`simplification-inventory.md`](simplification-inventory.md) Slice 7, which now
carries `parseTitledChoices(allow_description)` (`elicitation.zig:938`, callers at
`:827`, `:921`) alongside the single-variant enums the Phase 4 audit found. Phase 4
opens with this section empty, as `plan.md` requires.

## Phase 5: Repair and verification

Recorded in `plan.md`, not duplicated here:

- Session-recovery harness — `plan.md`, "Session-recovery harness: what the deleted suite proved".
- Four retained ACP-driven E2E cases — `plan.md`, "ACP-driven cases retained for conversion". Each still spawns the deleted `fiber acp` subcommand and is red until converted.

Added 2026-09-06 from the Phase 4 residue:

- **Merged-settings `credential_source` is parsed and never read.**
  `config_runtime.zig:1355` parses it; nothing reads it. It is a documented user
  setting that selects a preferred credential source and has no effect on which
  credential is resolved. Inherited, not caused by the transition — the value
  died at the callee before Slice 9 deleted the plumbing that carried it
  (`phase4-audit/CORRECTIONS.md`, "The `credential_source` setting is now
  write-only"). Phase 5 owns it because it is a behavior question this phase's
  suite may answer directly: either honor the setting or remove it and its
  documentation. Do not close Phase 5 by deleting the field silently — it is a
  documented setting, so removing it is a user-visible change.

## Phase 6: Documentation and naming

All inert. None affects behavior; none is covered by any slice's exit search.
This is the complete `grep -rni acp src/` residue as of `HEAD`.

**Output that outlived its capability** (added 2026-09-06 from the first E2E run)

- **`mcp list` prints fields it can no longer fill.** Every server line still
  carries `state=`, `auth=`, `protocol=`, `tools=`, `resources=`, `templates=`,
  `prompts=`, `cache=`, `subscription=`, `discovery=`, and each is now
  permanently a placeholder — `disconnected`, `unavailable`, `unknown`,
  `pending` — because `mcp list` no longer opens transports. **Owner decided
  2026-09-06: stop printing the fields it cannot fill.** This is a source change
  in the `mcp list` renderer; the E2E assertions follow it rather than the
  reverse. Phase 5 owns it because it is observable output, not a comment.
  Related: `../enhancements/pending.md`, `fiber mcp doctor`, which is the
  deferred replacement that would fill them again.

- **`fiber upgrade` advertises a release channel it does not have.** Both the
  subcommand help and the top-level command list say "Upgrade fiber on the
  selected release channel" (`src/builtins/commands.zig:190,260`), while
  `--channel` is rejected and the usage line is bare `upgrade [--json]`. Found
  while auditing a deleted E2E case for the dev update channel (Slice 19).
  Text only, no behavior: Phase 6.

**Deferred cleanup**

- **The `src/ui` non-interruptible convenience wrappers.** Added 2026-09-06 from
  the Phase 4 residue. About twenty `...Interruptible` functions have a simpler
  twin that only tests call; five are `prod=0` in `src/ui` alone —
  `wrapLiteralToolOutput`, `renderProjectionViewportSource`,
  `renderProjectionViewportSourceWithSelector`, `measureProjection`,
  `buildStyledFocused` — plus `buildInputLine` over `buildInputLineForRow` and
  `inlineApprovalPanelRows` over `inlineApprovalPanelRowsForCommand`. Deleting
  them removes no dead weight; it forces every test to thread an extra `null`.
  Measured in `phase4-audit/CORRECTIONS.md`, "Slice 22: most of the remaining UI
  surface is wrappers, not dead code". A style call, and resolving it may mean
  deciding to keep them — this section requires a decision, not a deletion.

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

- `src/core/permissions/auto_classifier.zig:15` — `gateway_reviewer_model =
  "moonshotai/kimi-k3"`, a Gateway-era model id that is still the live default on
  `auto_classifier.Provider.model` (`:357`) and asserted at `:1955`. The seam is
  retained and the constant is load-bearing, so this is a rename/retarget of a
  stale value, not a deletion. Found by the Phase 4 audit, 2026-09-05.

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
