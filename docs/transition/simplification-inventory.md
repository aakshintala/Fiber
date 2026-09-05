# Fiber simplification inventory

Scope: Phase 4 of the Fiber product transition.

Status: seeded during Phase 3 from the post-demolition audit. Re-verify every
path, caller count, and stop condition against the Phase 4 opening commit before
editing.

This document becomes the Phase 4 source of truth when Phase 3 closes. Phase 4
removes false variation left by deleted products. It does not redesign modules
that still have real adapters or add new capability.

## Decision rule

Apply the deletion test to each seam:

- collapse it when deleting the module removes complexity and no caller must
  recreate that complexity
- retain it when at least 2 real adapters vary behind the interface
- retain it when the interface isolates a meaningful effect and tests use the
  same seam as production
- move broader redesign or new behavior to
  [`../enhancements/pending.md`](../enhancements/pending.md)

A planned future adapter does not by itself justify a large hypothetical seam.
A stable public contract may retain its provider-shaped data while its current
implementation becomes direct.

## Retained invariants

Every slice preserves:

- the native interactive TUI and `fiber ask` paths
- durable sessions, subagents, cancellation, permissions, and progress events
- the Codex subscription authentication path
- provider-shaped command and JSON contracts chosen in Phase 3
- Codex-native web search and explicitly selected MCP search
- MCP interoperability across retained transports and protocol versions
- production and test adapters at seams where behavior genuinely varies

Phase 4 changes implementation shape, not user-facing behavior. Behavioral
failures become Phase 5 repair evidence unless a slice caused them.

## Ordered slices

Run one slice at a time. Before editing, update that slice's removal surface,
exact searches, caller evidence, and stop conditions from the current tree.
Keep each slice to one subsystem or about 15 files.

**Recommended order (2026-09-05).** Run 2, 3, 4, 6, 7, 9, 10, 11 first: they are
near-pure deletions with exact-name absence searches, cheap to verify and cheap
to delegate. Slice 1 is the largest diff in the phase and the only one needing
per-site reading, so it benefits from a smaller tree. Slice 12 closes the phase.

Evidence for slices 2, 4, 7, 9, 10, 11 and the open decisions comes from
[`phase4-audit/REPORT.md`](phase4-audit/REPORT.md) — 490 files, 362k production
lines, 360 raw findings, 31% of adversarially verified claims refuted. The audit
inputs and per-shard outputs are in that directory. It is a transition document
and is deleted with the rest in Phase 6.

### Slice 1: collapse the native-only host profile

Removal surface:

- `src/core/hosts/runtime_profile.zig`
- `runtime_profile.allows` checks in the app runtime
- `App.host_profile` and the selected native profile in `src/main.zig`
- false branches and messages that exist only for removed embedding hosts

Current evidence:

- `runtime_profile.Profile` contains 13 capability booleans
- `runtime_profile.native` sets every capability to `true`
- no second production host profile remains
- imports span 9 files — `src/main.zig` plus 8 modules under `src/core/app/` —
  across roughly 30 call sites (re-verified 2026-09-05)

Guard shapes differ and a regex codemod gets the second kind wrong **silently**,
because every condition here is comptime-true and the compiler will not object:

- `if (comptime allows(X)) { body }` — keep the body
- `if (comptime !allows(X)) return;` — delete the whole statement

Read every site. Do not sed this slice.

Retain concrete effect seams such as clipboard, URL opening, terminal title, and
their unavailable or test adapters. Remove only the profile that predicts
whether those seams exist.

Stop if a surviving entry point supplies a different profile or a false branch
is reachable in the native CLI.

Completion criterion: no runtime-profile selection or capability branch remains,
and retained unavailable-effect behavior still has direct focused coverage.

### Slice 2: remove deleted-host tool completion residue

Removal surface:

- `DeferredToolCompletion`
- `ToolExecutionResult.deferred_tool_completion`
- `AgentRuntimeDeps.publish_deferred_tool_completion`
- publication handling in tool batching and parallel-execution eligibility
- `unavailableHostToolResult` and its JavaScript-host message
- `tool_dispatch.HostToolProvider` and `HostToolProviderFn` (`tool_dispatch.zig:157,166`)
  and the `host_tool_provider` fields threading them
  (`tool_dispatch.zig:272`, `tool_runtime.zig:141,870`) — never constructed anywhere
  (added by the Phase 4 audit, 2026-09-05)

Current evidence:

- the deleted ACP host was the real producer and publisher
- exact-name searches find consumers but no assignment of a non-null deferred
  completion
- `unavailableHostToolResult` has no caller

Retain committed-file secondary publication. The root agent and subagents still
vary there deliberately.

Stop if a surviving tool executor produces a deferred completion or an external
transport consumes one.

Completion criterion: exact searches find no removed symbols or deleted-host
messages, and ordinary tool completion behavior is unchanged.

### Slice 3: flatten the OAuth transport wrapper

Removal surface:

- `gateway_provider.Provider`, which contains only `oauth_transport`
- wrapper construction in `src/builtins/gateway.zig`
- fields and parameters that immediately unwrap `.oauth_transport`

Retain `oauth_transport.Provider`. It has native, unavailable, and test adapters,
so that seam expresses real variation.

Stop if another field or invariant is added to `gateway_provider.Provider`
before this slice starts.

Completion criterion: callers accept `oauth_transport.Provider` directly and
`gateway_provider.zig` retains only its model-catalog and capability behavior.

### Slice 4: remove unreachable Fiber search-backend wiring

Removal surface:

- `provider_set.Bundle.Capabilities.fiber_search`
- `provider_set.Bundle.fiber_search`
- null propagation through root-agent, one-shot, and subagent construction
- **the whole `src/core/tooling/web_search_provider.zig` module**, plus
  `web_search_runtime.zig:34`'s `provider: ?Provider = null` field. Removing the
  `fiber_search` slot leaves the module with no production implementation at all —
  its only remaining constructor is a test double at `web_search_runtime.zig:341`.
  Scoping this slice to the field alone orphans a vtable module
  (widened by the Phase 4 audit, 2026-09-05)

Current evidence:

- no production provider bundle supplies a Fiber-owned search backend
- active runtimes initialize the provider as null

Retain:

- provider-neutral web-search contracts and policy
- Codex-native search gating
- explicitly selected MCP search

A Fiber-owned search backend is new capability and belongs in enhancements.

Stop if a production bundle supplies `fiber_search` or removing the field would
remove Codex-native or MCP search.

Completion criterion: no unreachable backend slot remains and retained search
routes still compile behind their existing interfaces.

### Slice 5: withdrawn — the one-source authentication picker stays

**Withdrawn 2026-09-05 by owner decision.** The removal surface was the
intermediate `Connections` screen, which today offers one action because
`credential_source_order` (`auth_runtime.zig:20`) holds only
`chatgpt_subscription`.

It stays for two reasons. OpenCode and Databricks are both planned, so the screen
is early rather than false — deleting a working screen to rebuild it in a few
months is negative work. And it is the only slice in this phase that changes
user-visible behavior, which breaks the property that makes Phase 5 triage clean:
if every Phase 4 slice is invisible from outside the binary, any Phase 5 failure
is unambiguously pre-existing.

The slice number is retained rather than renumbered so earlier commit messages
and notes still resolve.

### Slice 6: remove the detached stream-flush switch

Removal surface:

- `AgentRuntimeDeps.flush_assistant_stream_per_content_chunk`
- the matching `StreamChunkContext` field and conditional flush
- the test-only assignment that enables it

Current evidence:

- no production construction reads or enables the dependency
- only one unit test enables the stream-context field

Stop if a surviving output adapter requires per-chunk flush semantics.

Completion criterion: production streaming has one flush policy and tests drive
that policy directly.

### Slice 7: remove one-value branch residue

Initial removal surface:

- `parseTitledChoices(..., allow_description)`, whose 2 callers pass `false`
- `TransitionRoute`, whose only value is `root`

Single-variant enums found by the Phase 4 audit (2026-09-05):

- `src/core/upgrade/update_target.zig:7` — `Channel = enum { stable }`, whose
  `parse()` accepts only `"stable"`, and the `switch (channel)` in
  `upgrade_helpers.zig:69`. `upgrade --channel` was removed in demolition Slice 19,
  so this is deleted-product residue, not ordinary one-value shape.
- `src/ui/render_engine/viewport_selection.zig:23` — `HardLinePolicy`
- `src/core/shell_command/command_effect.zig:185` — `PrintfFormatLanguage`
- `src/core/shell_command/command_effect.zig:238` — `LsSymlinkSemantics`
- `src/core/terminal/contracts.zig:146` — `PersistenceLevel`
- `src/tools/shell/shell.zig:37` — `ShellKind = enum { executable }`

The MCP item is also recorded in `deferred.md`. At Phase 4 opening, move that
entry here by clearing the Phase 4 deferred section before implementing this
slice.

Stop if a second live value or caller appears. Split newly found residue into a
separate bounded slice when it crosses subsystem ownership.

Completion criterion: parameters and tags with one invariant value are removed,
and their invariant is expressed directly by the implementation.

### Slice 8: renumbered

The one-implementation audit that was Slice 8 is now **Slice 12**, rewritten from
an open-ended search into a checklist after the Phase 4 audit covered the tree.
The number is left in place so earlier notes still resolve.

### Slice 9: remove WebAssembly target residue

Added by the Phase 4 audit, 2026-09-05. The deleted WebAssembly target left
`wasi`/`emscripten` branches in code that now only ever builds native.

Removal surface:

- `src/core/hosts/host.zig:149` — `nativeForOs` wasi `process_control` guard
- `src/main.zig:3223` — `hasPosixArgVector` wasi arm
- `src/core/shared/io.zig:214` — wasi branch in `openExistingRegularFileWithPolicy`
- `src/core/shared/io.zig:427` — wasi/emscripten guard in `getenvFromBlock`

Stop if a build target other than native is reintroduced to `build.zig` first.

Completion criterion: no `wasi` or `emscripten` branch remains in retained code
and native behavior on every touched path is unchanged.

### Slice 10: remove the `workspace_clean` execution environment

Added by the Phase 4 audit, 2026-09-05. A union variant plus every arm that
handles it. Delete the variant and its arms together or the switches will not
compile.

Removal surface:

- `src/core/execution/command_environment.zig:16` — `Environment.workspace_clean` union variant
- `src/core/execution/command_environment.zig:136` — `Host.workspace_clean` enum variant
- `src/core/execution/command_environment.zig:116` — `formatApprovalCommand` arm
- `src/core/execution/command_runner.zig:626` — `executeCommandInEnvironment` arm
- `src/core/execution/managed_execution.zig:1425` — `dupeEnvironment` arm

Stop if any production path constructs a `workspace_clean` environment.

Completion criterion: the environment union has no unreachable variant and
command execution behavior is unchanged.

### Slice 11: remove confirmed dead deleted-product symbols

Added by the Phase 4 audit, 2026-09-05. Individually small, one subsystem each,
grouped here because none justifies its own slice. Every entry was verified to
have zero production references. Split into per-subsystem commits.

| Site | What |
|---|---|
| `src/ui/footer/picker_presentation.zig:455` | `composeApiKeyPickerRow` — API-key auth row, no such source remains |
| `src/ui/footer/picker_presentation.zig:223,332,333` | `manual_code_visible`, `manual_code_mask_count` params — `:229` is literally `_ = manual_code_visible;` and `input_presentation.zig:1581` hardcodes `false` |
| `src/core/agent/runtime/deps.zig:126,127` | `ParentTurnDeliveryAck.discovery_start_offset` / `discovery_next_offset` — never assigned |
| `src/core/agent/question_prompt.zig:197,209` | `syncChoicesFrom`, `append_freeform` false-path param |
| `src/core/auth/oauth.zig:118` | `requestDeviceAuthorization` — dead duplicate; the live device-code flow is `login_flow.zig:521` |
| `src/core/app/prompt_history_runtime.zig:67` | `initializeWithProvider` — confirms `prompt_history_provider.Provider` is a dead seam; take the module with it |
| `src/core/cli/cli_surface.zig:558` | `ProviderActivationCaller.provider_command` variant |
| `src/core/gateway/model_catalog.zig:359,424` | `compareModelCatalogEntries`, `projectPickerModelCatalog` |
| `src/core/gateway/model_catalog.zig:292` | `web_search_price` field |
| `src/core/gateway/provider_set.zig:23` | `presentation` field |
| `src/core/app/app_commands.zig:8` | unused `gateway_provider` import — fold into Slice 3 |
| `src/gateway/agent_request_body.zig:390` | `withRequestUserAgent` |
| `src/ui/render_engine/frame_builder.zig:20` + `src/ui/render_request.zig:10` | `subagent_panel` variant in both — delete together |
| `src/core/session/session_test_controls.zig:7` | `logOptions` |

Two clusters where one deletion resolves several findings:

- `elicitation.zig` — `Binding.user_identity` / `AnswerBinding.user_identity` are
  never assigned, so the `optionalStringEqual` comparison at `:203` always passes
  and `Rejection.wrong_user` (`:173`) is unreachable. One deletion, four findings.
- `command_specs.zig` — `childChatSlashRegistry` (`:150`) is dead, taking
  `child_chat_slash_command_count` (`:148`) and its `[N]SlashSpec` storage with it.
- `builtins/commands.zig:301` — `top_level_resources` is an empty array wired into
  `top_level_registry`; `maxTopLevelResourceLabelWidth` (`command_specs.zig:814`)
  and `writeTopLevelResource` (`:852`) iterate it and produce nothing. Array, both
  helpers, and the loops at `:268,314` go together.

Stop on any entry whose production caller count is no longer zero at slice time.

Completion criterion: exact searches find none of these symbols, and no retained
behavior changed.

### Slice 12: close the one-implementation audit

Replaces the open-ended search that was Slice 8. The Phase 4 audit
(`phase4-audit/REPORT.md`, 2026-09-05) covered all 490 files and 362k production
lines, so this slice is a checklist, not a hunt.

**The layering rule settles most candidates.** `src/core` defines contracts,
`src/builtins` implements them, `src/main.zig` wires them, and every production
`core -> builtins` import is `if (builtin.is_test)`-guarded. A vtable in
`src/core` with one implementation in `src/builtins` is therefore *correct* —
collapsing it would invert the dependency. Verify with
`rg -n '@import\(".*builtins/' src/core` and confirm every hit is test-guarded.

Ten `Provider` structs remain unclassified. For each, record production adapter
count, test adapter count, and whether caller and implementation sit on the same
side of the core/builtins boundary:

`web_search_provider` (dies with Slice 4), `usage_dashboard_runtime`,
`context_contract`, `command_provider`, `process_provider`,
`notification_contract`, `model_catalog`, `skill_commands`, `tool_provider`,
`prompt_history_provider` (dies with Slice 11).

Retain, with evidence already gathered: `oauth_transport` (native, unavailable,
test), `stream_provider` (Codex plus deterministic test streams),
`auto_classifier` (production and test reviewers), `process_provider` (has an
`unavailable_provider` adapter).

Completion criterion: each of the ten is collapsed or justified with current
caller and adapter evidence, and the Phase 4 section of `deferred.md` is empty.

## Open decisions for the owner

Surfaced by the Phase 4 audit and deliberately **not** folded into a slice,
because each is a product or design call rather than removal of false variation.

### The provider-selection parameters

Verified dead, but they are the machinery a second model provider would use, and
OpenCode and Databricks are both planned:

- `src/core/auth/credentials.zig:170` — `resolveForProvider(preferred)`, body starts `_ = preferred;`
- `src/core/auth/auth_runtime.zig:302` — `loadStatusSnapshotForProvider(preferred)`
- `src/core/cli/cli_surface.zig:581,582` — `activateProviderSelection(target, caller)`, body starts `_ = caller; _ = target;` and then hardcodes `.codex`
- `src/core/cli/cli_surface.zig:571` — `writeProviderActivationError` fiber-provider branch
- `src/ui/footer/picker_presentation.zig:222,331` — `source` parameters
- `src/ui/footer/model_menu_presentation.zig:410` — `loadedCatalogStatusText` `state.source` read

This is the same question Slice 5 answered "keep", with one difference worth
weighing: a `_ = target;` parameter is not merely early, it is actively
misleading — the signature claims the caller can select a provider and the body
ignores it. Deleting them is a smaller diff today and more work when Databricks
lands. Keeping them means the signature keeps lying until then. Either is
defensible; it needs an owner, not a slice.

## Explicitly retained seams

Re-verify these at Phase 4 opening. They currently express real variation or a
meaningful effect:

- agent stream providers used by Codex and deterministic tests
- automatic permission reviewers used by production and tests
- OAuth transport providers used by native, unavailable, and test adapters
- URL opener, clipboard, and terminal-title effects
- MCP stdio and HTTP transports, protocol negotiation, authentication, and
  tool, prompt, resource, and subscription behavior
- committed-file secondary publication, where root agents publish and subagents
  deliberately skip
- provider-shaped public command and output contracts

## Post-transition backlog: ordinary dead code

The audit tagged each finding `deleted-product` or `always-was`. Only the first
is Phase 4's work. The `always-was` findings are real dead code with no
connection to the demolition — inherited fx-era rot — and they are **out of scope
for this phase**: removing them widens the gate and muddies Phase 5's ability to
treat every failure as pre-existing.

They are recorded, with verdicts, in
[`phase4-audit/REPORT.md`](phase4-audit/REPORT.md): 75 dead, plus the
`always-was` entries under CONFIRMED and TESTED-ONLY. The densest sites are
`auth_runtime.zig` (7), `skill_runtime.zig` (6), `agent_request_body.zig` (5),
`editor_state.zig` (4), and `image_attachments.zig` (4).

Two categories there are **not** deletions and should not be treated as such:

- **TESTED-ONLY (61)** — the only callers are the symbol's own tests. Deletable,
  but the test goes too, so each needs a judgment about whether the coverage is
  worth keeping the code for.
- **SINGLE-CALLER (60)** — exactly one caller. An inline-the-wrapper candidate,
  not dead code.

Feed this to the architectural audit planned after Phase 6, not to a Phase 4 slice.

## Outside Phase 4

Keep these out of the transition simplification gate:

- decomposing the whole MCP runtime
- redesigning `AgentRuntimeDeps`
- adding another model provider
- implementing a Fiber-owned web-search backend
- implementing `fiber mcp doctor`
- rebuilding ACP or editor integration
- TUI resize, cancellation, and transcript-transition repair, which Phase 5 owns

These may be valuable, but they are deeper-module design, new capability, or
behavioral repair rather than removal of false post-demolition variation.

## Verification

For every code slice, run the narrowest focused tests while developing, then:

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
```

Also run the slice's exact absence searches and report every command with its
exit status. Phase 5 owns routine deterministic E2E and real-product exhaustive
verification unless a Phase 4 slice changes or breaks a directly covered path.
