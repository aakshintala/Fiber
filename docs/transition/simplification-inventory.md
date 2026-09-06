# Fiber simplification inventory

Scope: Phase 4 of the Fiber product transition.

Status: replanned after the audit correction. Read
[`phase4-audit/CORRECTIONS.md`](phase4-audit/CORRECTIONS.md) before using the
raw findings in [`phase4-audit/REPORT.md`](phase4-audit/REPORT.md).

## Phase goal

Phase 4 removes:

- every verified dead declaration, field, variant, branch, module, and test
- false variation left by deleted products and hosts
- unsupported platform implementations and test guards
- one-value policy types and constant parameters that do not protect a public,
  persisted, security, or effect boundary
- single-caller wrappers when deleting them makes the caller simpler

Origin does not limit deletion. Inherited dead code is Phase 4 work too.

Phase 4 preserves behavior on macOS arm64, Linux x86_64, and Linux arm64. It may
remove behavior on unsupported targets because those targets are not Fiber.

## Retained invariants

Every slice preserves:

- the native interactive TUI and `fiber ask` paths on retained targets
- durable sessions, subagents, cancellation, permissions, and progress events
- corrupt-session isolation and validation of persisted authority records
- the Codex subscription authentication path
- provider-shaped command and JSON contracts chosen in Phase 3
- Codex-native web search and explicitly selected MCP search
- MCP interoperability across retained transports and protocol versions
- concrete effects and adapters that express real production, unavailable, or
  test variation
- the one-source Connections screen

Do not delete a persisted or security field merely because it currently has one
value. Remove it only when its containing format and all validation or hash
consumers are deliberately replaced in the same slice without data loss.

## Supported platform contract

Fiber supports exactly:

- macOS arm64
- Linux x86_64
- Linux arm64

Delete Windows, WebAssembly, WASI, Emscripten, freestanding, macOS Intel, BSD,
and other unsupported-target behavior. The build must reject unsupported targets
before their source branches are removed.

This resolves the temporary conflict with inherited Full CI guidance. The
product design in `docs/ideas/fiber-product-transition.md` is authoritative.

## Verification and attribution

### Phase opening baseline

Done. Recorded in [`../transition/phase4-baseline.md`](phase4-baseline.md) on
2026-09-05.

Before the first code slice:

1. Run the normal clean-tree gate.
2. Record the `zlint` warning count and the lazy-analysis probe output in
   `docs/transition/phase4-baseline.md`.

Commands:

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
zlint
```

The `zlint` `unused-decls` count is 111 at commit `b26e3d99` and unchanged at
the baseline. It and the probe get the same attribution rule as the rest of the
gate: a count or error that grows after a slice is caused by that slice until
fixed or reverted.

A red build, unit test, formatting check, or smoke test stops Phase 4.

### E2E is not a Phase 4 signal

The opening run produced 489 failures and zero passes. 47 of the 55
`tests/e2e/*.test.ts` files drive the product through a fake Vercel AI Gateway
whose provider Phase 3 deleted, so the failures are environmental rather than
regressions. With nothing green, "green at baseline and red later" has no
domain and the suite cannot attribute anything to a slice.

Phase 4 therefore does not run `bun test` — not at the re-audit checkpoint, not
at phase exit. Rewiring the harness onto the Codex path is Phase 5 work.
Evidence is in `phase4-baseline.md`; the decision is logged in
`phase4-audit/OWNER-QUESTIONS.md`.

### Failure attribution

- a unit, build, formatting, or smoke failure first seen after a slice is caused
  by that slice until fixed or reverted
- `zig build test` output must stay free of `failed command:`
- `zlint` must report no more than 111 `unused-decls` warnings
- the lazy-analysis probe reports the OSC 8 failure and no other; see
  `phase4-baseline.md`

### Per-slice gate

Run one slice at a time on `main`. A suffixed slice such as 9c is a separate
slice and gets its own commit and gate.

For every code slice, run and report:

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
zlint
```

Also grep the `zig build test` output for `failed command:` and run the slice's
exact absence searches. Do not trust the test command's exit status alone.

### Orphaned private declarations

`zlint` must report no more `unused-decls` warnings than the count recorded in
`phase4-baseline.md`. Deleting a public function orphans the private imports and
aliases that fed it; that residue is this rule's exact shape.

`zlint.json` scopes the linter to `unused-decls` only. Do not widen it during
Phase 4. Its other rules are inherited-code style opinions and belong to the
end-of-transition quality audit.

Run `zlint` from the repository root with no path arguments. Directory arguments
are broken in v0.9.1 and silently lint zero files.

Clear the residue with `zlint --fix-dangerously`, then read the diff before
committing. The fixer removes the declaration and its doc comment.

The rule finds only private, file-local, top-level `const` declarations. It never
reports `pub` declarations, so it cannot find the cross-module dead code that the
audit corpus inventories. It is a residue sweep, not a substitute for a slice.

### Lazy-analysis probe

Zig never semantically analyzes an unreferenced container-level declaration. A
dead `pub` function that calls a symbol this phase deleted still compiles clean,
because nothing analyzes it. A green build is therefore weaker evidence than it
looks.

Force analysis at each full checkpoint:

```sh
{ echo 'const std = @import("std");'
  git ls-files 'src/**/*.zig' \
    | sed 's|^src/||; s|.*|test { std.testing.refAllDecls(@import("&")); }|'
} > src/zz_refall_probe.zig
printf '\ntest { _ = @import("zz_refall_probe.zig"); }\n' >> src/main.zig
zig build test -Doptimize=ReleaseSafe
git checkout src/main.zig && rm src/zz_refall_probe.zig
```

The probe must run through `zig build`, not `zig test`. Several modules import
the generated `build_options` module, which only the build graph supplies.

Never commit the probe. Permanently forcing analysis makes dead declarations look
referenced to the next audit and to `zlint`.

`std.testing.refAllDecls` in Zig 0.16 reaches one level and public declarations
only. There is no `refAllDeclsRecursive`. Methods on nested structs stay
unanalyzed, so a clean probe is not proof of a clean tree.

## Corrected audit policy

The raw 360-row corpus remains evidence, not a ready-made deletion plan.

- delete DEAD and CONFIRMED rows after rechecking current declarations and
  references, except explicit retentions in the correction document
- delete obsolete TESTED-ONLY code with its tests
- retain the five TESTED-ONLY exceptions in `phase4-audit/CORRECTIONS.md`
- retain SINGLE-CALLER and REFUTED rows unless this inventory or the correction
  document explicitly assigns them to a slice
- ignore the old `deleted-product` versus `always-was` phase boundary

The audit covered `src`, not every tracked Zig file. Each relevant slice must
also inspect `build.zig`, benchmarks, scripts, and test support.

## Ordered slices

### Slice 0: record the pre-simplification baseline

Run the phase opening baseline and write `phase4-baseline.md`. Make no source
change.

Stop if any gate is red.

### Slice 1: restrict builds and CI to supported targets

Removal surface:

- reject every target except macOS arm64, Linux x86_64, and Linux arm64 in
  `build.zig`
- remove macOS Intel runners, matrices, binary-size work, and documentation from
  retained workflows
- remove any release artifact or installer branch for an unsupported target

Use `upgrade_helpers.platformFromTarget` as the existing allowlist precedent.

Proof:

```sh
zig build -Dtarget=x86_64-windows
zig build -Dtarget=wasm32-wasi
zig build -Dtarget=x86_64-macos
```

All three commands must fail with the explicit unsupported-target message. The
three retained target builds must still succeed where the local toolchain can
cross-build them.

### Slice 2: remove deleted-host tool completion and sandbox residue

Removal surface:

- `DeferredToolCompletion`
- `ToolExecutionResult.deferred_tool_completion`
- `AgentRuntimeDeps.publish_deferred_tool_completion`
- publication and parallel-execution handling for deferred completion
- `unavailableHostToolResult`
- `HostToolProvider`, `HostToolProviderFn`, and threaded provider fields
- `HostSandboxDefault`, `host_sandbox_default`, its tool-admission branch, and
  `ShellAuthorizationSource.js_host`
- tests that manufacture deleted JavaScript-host defaults

Retain committed-file secondary publication.

Stop if a surviving executor produces deferred completion or a retained runtime
supplies a non-default host sandbox policy.

### Slice 3: flatten the OAuth transport wrapper

Removal surface:

- `gateway_provider.Provider`, which contains only `oauth_transport`
- wrapper construction and fields that immediately unwrap it
- the unused `gateway_provider` import in `app_commands.zig`

Retain `oauth_transport.Provider`; native, unavailable, and test adapters vary.

Stop if the wrapper gains another field or invariant before this slice starts.

### Slice 4: delete dead Gateway request fixtures and parser code

Removal surface:

- the test-only request-building family in `src/builtins/gateway.zig`
- `provider_bundle`, `buildAgentRequest`, `buildAgentToolsJson`,
  `writeDynamicFunctionTool`, and `toolNameSelected`
- the dead request and legacy completion parser family in
  `src/gateway/agent_request_body.zig`
- test-gated imports and tests whose only purpose is that family

Prefer deleting `agent_request_body.zig` whole if its only remaining importer is
the test fixture. Rewrite a dependent test only when it still proves retained
Codex behavior; otherwise delete the obsolete test.

Stop if a production request path imports the file at slice open.

### Slice 5: remove the unreachable Fiber search backend

Removal surface:

- `provider_set.Bundle.Capabilities.fiber_search`
- `provider_set.Bundle.fiber_search`
- null propagation through root, one-shot, and subagent construction
- `web_search_provider.zig`
- the provider and policy fields in `web_search_runtime.zig`
- `web_search_policy.zig` if its only remaining consumers are deleted modules or
  tests
- `main.zig`'s `web_search_models_path`; use the retained Codex path directly

Retain provider-neutral request and result contracts used by Codex-native or MCP
search. Do not retain a policy module with no production consumer.

Stop if a production Fiber-owned backend exists or a deletion reaches
Codex-native or MCP search.

### Slice 6: remove the detached stream-flush switch

Remove `flush_assistant_stream_per_content_chunk`, its stream-context field,
conditional flush, and obsolete test variation.

Stop if a surviving output adapter requires per-content-chunk flush semantics.

### Slice 7: remove deleted-product one-value residue

Removal surface:

- `update_target.Channel`, its dead parser, fixed channel parameters, and the
  stale E2E tests that expect a development channel or document
  `--channel <stable|dev>`
- `parseTitledChoices(..., allow_description)`
- `TransitionRoute`
- `TransientContextInput.host_workspace`, `HostWorkspaceContext`, and the
  alternate-host context branch
- elicitation `user_identity`, `wrong_user`, and canonical-response behavior that
  exists only for the deleted host path

Retain elicitation identity checks only if a current protocol supplies identity.
The current tree does not.

### Slice 8: remove `workspace_clean` completely

Delete the variant and every arm together across:

- `command_environment.zig`
- `command_runner.zig`
- `managed_execution.zig`
- `command_admission.zig`
- `tool_admission.zig`
- `tool_runtime.zig`
- `terminal/shell_resolver.zig`
- `tools/shell/shell.zig`

Proof:

```sh
git grep -n workspace_clean -- src/
```

The search must return no matches.

Stop if a production path constructs this environment at slice open.

### Slice 9: close provider-selection discards

Retain parameters typed `ProviderId`. Replace the discarded provider target with
an exhaustive switch so another variant fails compilation until implemented.

Delete:

- credential-source `preferred` parameters that every caller passes as null
- picker `source` and `manual_code_*` parameters that are ignored
- `ProviderActivationCaller.provider_command`
- its unreachable error arm and now-useless caller parameter
- the no-op `state.source` read

This slice solely owns these symbols; no earlier slice may delete them.

Retain the `ProviderId` enum itself. Slice 26 collapses provider plumbing but
keeps the one-variant enum at the persisted and public boundary.

Stop if a second `ProviderId` variant lands first.

### Slice 10: remove unsupported execution and process branches

Was Slice 19 before the 2026-09-05 reorder.

After Slice 1 makes them unreachable, remove unsupported-target branches and test
guards from:

- `command_runner.zig`
- `process_tree.zig`
- `direct_command.zig`

Keep macOS and Linux process-group, signal, timeout, and descendant cleanup
behavior.

### Slice 11: remove unsupported MCP and tooling branches

Was Slice 20 before the 2026-09-05 reorder.

Remove unsupported-target code from MCP subprocess, auth, Docker, tool runtime,
tool dispatch, and file-mutation modules. Delete Windows process APIs and
executable-name fallbacks.

Keep macOS and Linux stdio shutdown and process cleanup behavior.

### Slice 12: remove unsupported host, terminal, and session branches

Was Slice 21 before the 2026-09-05 reorder.

Remove unsupported-target code and test guards from host capabilities, keychain,
URL opener, terminal host, native session, shell resolution, command replay, and
session stores.

Retain macOS Keychain behavior and Linux profile-file credential behavior.

### Slice 13: remove unsupported workspace, image, and skill branches

Was Slice 22 before the 2026-09-05 reorder.

Remove unsupported-target fallbacks and skips from workspace indexing, pathing,
search, tape recording, image handling, skills, and filesystem tools.

Delete test guards when the test covers retained behavior. Delete or retarget a
test only when it exclusively asserts an unsupported platform.

### Slice 14: remove unsupported CLI, UI, main, and shared I/O branches

Was Slice 23 before the 2026-09-05 reorder.

Remove unsupported-target implementations and constant capability switches from
`main.zig`, CLI output, doctor, app commands, shared I/O, resize, shell runtime,
and remaining UI code.

Collapse constants such as `supports_headless_interrupt`, `supports_test_pty`,
`supports_resize_signal`, and `hasPosixArgVector` after the target allowlist makes
them invariant.

Run the lazy-analysis probe at this checkpoint. E2E carries no signal; see
the E2E section above.

### Slice 15: collapse the native host profile

Was Slice 24 before the 2026-09-05 reorder.

Delete `runtime_profile.Profile`, the all-true native profile, capability guards,
`App.host_profile`, and false branches that only served deleted hosts.

Read every site. Two guard shapes require different edits:

- `if (comptime allows(X)) { body }` keeps the body
- `if (comptime !allows(X)) return;` deletes the statement

Retain concrete clipboard, URL, terminal-title, process, and notification effect
seams.

Run the lazy-analysis probe at this checkpoint. E2E carries no signal; see
the E2E section above.

### Re-audit checkpoint

Run before the renumbered dead-code series below.

The platform removal and host-profile collapse above delete roughly 154
unsupported-target sites and 48 `runtime_profile` sites, and orphan code that no
prior slice could see. The dead-code slices that follow were written against the
tree as it stood at `b26e3d99`, so re-derive their removal surfaces against the
collapsed tree before opening any of them.

Do this:

1. Run the lazy-analysis probe and compare with the opening baseline.
2. Run `zlint` and the lazy-analysis probe; record both.
3. Re-run the audit searches over all tracked source, build, benchmark, script,
   and test files.
4. Merge the following slices by subsystem wherever their surfaces now overlap.
   Fewer, larger, better-targeted slices are the point of running them here
   rather than before the collapse.

This checkpoint is why Slice 27 should find residue rather than a second full
pass.

### Slice 16: delete dead auth and model-catalog families

Was Slice 10 before the 2026-09-05 reorder.

Removal surface:

- dead OAuth discovery, refresh, revoke, and granted-scope helpers
- dead auth picker, logout inventory, precedence, and credential wrappers
- dead API-key picker code
- dead model-picker projection, rank, comparison, price, and presentation fields
- fields used only inside those dead chains

Do not touch `modelProviderRank`, `modelTierRank`, `featured_picker_families`, or
the `ModelProviderFilter` enum. Those rejected-vendor rows are inert but
observable, and Slice 26 retains them deliberately.

Retain live Codex token parsing, device authorization, polling, credential
resolution, catalog parsing, and public model capabilities.

### Slice 17: delete dead command and builtin wrappers

Was Slice 11 before the 2026-09-05 reorder.

Removal surface:

- forwarding wrappers and re-exports in `builtins/commands.zig`,
  `builtins/tools.zig`, and `builtins/modes.zig`
- dead slash help and welcome rendering
- the child-chat slash registry and storage
- the empty top-level resource array, its loops, and helper functions
- constant completion-policy fields with no varying spec

Retain underlying command-spec functions with live CLI or picker callers.

### Slice 18: delete dead agent and subagent code

Was Slice 12 before the 2026-09-05 reorder.

Removal surface:

- delivery-ack fields never assigned
- dead question-prompt wrappers and constant parameters
- dead execution-memory constructors and adapters
- dead subagent authority, model-contract, background URL, and host wrappers
- no-op tool activity recorder
- direct-child resume no-op calls
- discarded subagent execution options

Retain subagent permission, persistence, cancellation, and model-selection
contracts used by production.

### Slice 19: delete dead execution and permission code

Was Slice 13 before the 2026-09-05 reorder.

Removal surface:

- dead managed-execution presentation, terminal-state, cancellation, tombstone,
  and router chains
- dead permission-prompter retention fields and methods
- unused automatic-reviewer input fields and disabled variant
- `auto_classifier.gateway_reviewer_model = "moonshotai/kimi-k3"` (`:15`), the
  `Reviewer.model` field default at `:357`, and the assertion at `:1955`

Automatic permission review is live and already runs on catalog-selected
`gpt-5.4-mini` via `openai_codex_permission_reviewer`. The Kimi constant is
inherited Gateway residue reachable only from tests. Retarget the field default
to the Codex reviewer model rather than leaving the seam without one, and keep
the review path itself working. Do not change
`openai_codex_models.reviewer_model`; the owner declined that on 2026-09-05.
- constant source-refresh guards
- no-op permission protocol parameters

Retain admission fingerprints, configured and session grants, auto review, yolo,
and all security validation.

### Slice 20: delete dead MCP code

Was Slice 14 before the 2026-09-05 reorder.

Removal surface:

- dead elicitation states, rejections, fields, parsers, and schema helpers
- dead MCP auth-store status API and PKCE helper
- dead health publication and MRTR parsing helpers
- dead tool and resource re-exports, errors, and test-only wrappers
- adjacent single-caller helpers that become chain-dead

Retain stdio and HTTP transports, protocol negotiation, authentication, tools,
prompts, resources, subscriptions, and corrupt or invalid input handling.

### Slice 21: delete dead terminal and session code

Was Slice 15 before the 2026-09-05 reorder.

Removal surface:

- dead terminal client dequeue and projection methods
- dead shell formatting helper
- dead store export and UI background projection
- unreachable recovery evidence variants only when production construction proves
  they cannot occur
- dead monitor or transition helpers not used by persisted validation

Retain `session_test_controls.zig`, corrupt-session isolation, authority hashes,
proofs, lifetime validation, schedules, and compatibility needed to read current
Fiber sessions.

Stop if a candidate participates in serialization, hashing, authority checks, or
recovery of a retained record.

### Slice 22: delete dead UI and input code

Was Slice 16 before the 2026-09-05 reorder.

Removal surface:

- all three `subagent_panel` variants, the production switch arm in
  `app_render_runtime.zig`, and the obsolete `frame_fixed_point.zig` test
- dead transcript preview, reconstruction, wrapping, and resume-projection chains
- dead row formatting and resize-reflow variants
- dead editor cursor methods duplicated by live navigation functions
- discarded footer, picker, and render parameters, except the provider-selection
  picker parameters owned by Slice 9
- constant rendering flags and one-value frame placement policy

Retain the live transcript, resize, approval, catalog, and resume paths. Run the
focused resize and render unit tests after each UI sub-slice.

### Slice 23: delete dead skill, filesystem, image, and shared helpers

Was Slice 17 before the 2026-09-05 reorder.

Removal surface:

- dead skill summary and menu-filter chains
- dead skill tool entry wrappers
- dead write-file dispatch code embedded in `read_file.zig`
- dead image placeholder span and review helpers
- dead gateway diagnostic, debug-trace, message, and tool-dispatch helpers
- dead gesture accessors

Split this slice by subsystem when more than about 15 files would change.

### Slice 24: delete dead app-runtime code

Was Slice 18 before the 2026-09-05 reorder.

Removal surface:

- dead prompt-history provider and initialization
- dead startup, lifecycle, bootstrap, and terminal managed-facts helpers
- unreachable startup branches and unused imports
- cooperative live-session transition state that every production caller disables

Retain live session installation, cancellation, resume, prompt history, and
workspace startup behavior.

### Slice 25: collapse general one-value and single-caller residue

Removal surface:

- `HardLinePolicy`
- `PrintfFormatLanguage`
- `LsSymlinkSemantics`
- internal `ShellKind` while preserving the advertised and validated
  `"kind":"executable"` tool contract
- one-value message content and frame-placement types when their collapse stays
  mechanical
- the always-true project-instruction switch in `builtins/context.zig`
- discarded protocol parameters in `mcp/features/common.zig` and
  `mcp/features/tools.zig`
- every correction-document action not owned by an earlier slice
- explicit single-caller candidates in `phase4-audit/CORRECTIONS.md`

Do not collapse persisted terminal authority types or public provider-shaped
contracts.

### Slice 26: close the implementation-seam audit

The old blanket layering premise is withdrawn.

For every remaining `Provider`, vtable, callback table, and optional adapter:

1. record production adapter count
2. record unavailable adapter count
3. record test adapter count
4. identify the effect or dependency boundary it protects
5. collapse it when no real variation or effect boundary remains
6. retain it only with the evidence above

Also resolve the existing production `core -> builtins` imports. Move composition
toward `main.zig` or a typed dependency rather than citing a boundary the tree
does not currently enforce.

#### Provider seam: collapse the plumbing, keep the boundary

Owner decision, 2026-09-05. The seam now in the tree was shaped for Gateway,
Grok, and Vercel. All three are deleted, so its original justification is gone,
and its current shape is a guess about a provider set that does not exist yet.
Collapse it rather than preserving a fossil.

Step 5 above applies to internal plumbing only. Three layers, three answers:

- *internal plumbing* — one-arm switches, threaded `ProviderId` parameters,
  one-implementation vtables and wrappers. Collapse. Rebuilding is mechanical and
  the compiler enumerates every site.
- *persisted and public contracts* — session records, JSON shape, command
  surface. Keep the discriminant. Versioned data cannot be refactored
  unilaterally, and Codex-only assumptions baked there are expensive to undo.
- *the model catalog* — `modelProviderRank`, `modelTierRank`,
  `featured_picker_families`, and the full `ModelProviderFilter` enum stay
  whole. Those rejected-vendor rows are inert but observable: the provider tab
  does not render until the catalog spans two families, unmatched featured rows
  break immediately, and `modelTierRank` is a substring matcher that deleting
  entries is the only way to break. This also constrains Slice 16.

Keep `ProviderId` as a one-variant enum at the persisted and public boundary.
Carrying cost is near zero and `git grep ProviderId` becomes the worklist when
the real multi-provider seam is designed. Do not delete the enum itself.

Before designing that seam, read the deleted Grok implementation. It is the
worked example of a second provider with its own endpoint and credential sharing
the retained `responses_protocol.zig`:

```sh
git show 993688a5:src/gateway/xai_grok.zig
git show 993688a5:src/gateway/xai_grok_models.zig
git show 993688a5:src/core/auth/grok_oauth.zig
```

### Slice 27: final dead-code and residue sweep

Repeat the audit against all tracked source, build, benchmark, script, and test
files after the prior deletions. New dead code exposed by those deletions is part
of this slice, not a post-transition backlog.

Required searches include:

```sh
git grep -n -E '\.windows|\.wasi|\.emscripten|\.freestanding' -- src/ benchmarks/ tests/ build.zig
git grep -n -E '\.freebsd|\.netbsd|\.openbsd|\.dragonfly|\.plan9|\.illumos|\.haiku|\.serenity|\.uefi|\.solaris' -- src/
git grep -n -E 'workspace_clean|DeferredToolCompletion|HostToolProvider|fiber_search|host_sandbox_default|host_workspace' -- src/
git grep -n -E 'acp|grok|vercel|gateway|wasm|napi|node_api|javascript_host' -- src/ build.zig tests/ scripts/
```

A remaining product-name hit may stay only when it is required attribution,
history, or a live external protocol identifier. Record each exception.

Run the lazy-analysis probe and compare it with the opening baseline.

## Phase exit

Phase 4 closes only when:

- the build accepts exactly the 3 retained targets
- unsupported platform searches have no unexplained hits
- every DEAD, CONFIRMED, and TESTED-ONLY audit row is deleted, retracted, or
  explicitly retained in `phase4-audit/CORRECTIONS.md`
- every actionable SINGLE-CALLER and false REFUTED row in the correction document
  is resolved
- every remaining implementation seam has measured retention evidence
- no newly exposed dead code remains
- `zlint` reports zero `unused-decls` warnings
- the lazy-analysis probe reports the OSC 8 failure and no other; see
  `phase4-baseline.md`
- the Phase 4 section of `deferred.md` is empty
- build, unit, formatting, and smoke gates pass
- `zig build test` output is free of `failed command:`
