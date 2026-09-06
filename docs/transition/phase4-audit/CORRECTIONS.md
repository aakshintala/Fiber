# Corrected Phase 4 audit decisions

Status: authoritative correction to `REPORT.md` at commit `b26e3d99`.

The raw corpus and arithmetic in `REPORT.md` are intact. Its operational
conclusions are not. Phase 4 now removes all verified dead code, including
inherited dead code, and all support outside the retained platform set.

## Provenance of the claims in this file

This file was written unversioned and asserted several claims as owner decisions.
One of them, the `gateway_reviewer_model` retention, was traced and found to be an
audit observation that this file promoted. Assume nothing here is an owner
decision unless it is labelled below.

- *owner-stated*: maximal simplification including inherited dead code; the
  retained target set; the one-source Connections screen; collapse provider
  plumbing while keeping the `ProviderId` enum and the model catalog
  (2026-09-05); run the demolition slices through Cursor
- *document-traced*: the retained target set also follows from
  `docs/ideas/fiber-product-transition.md` ("Drop macOS x86_64 from Fiber
  support. Keep macOS arm64, Linux x86_64, and Linux arm64")
- *audit-inferred*: every verdict-policy row, every retained or retracted
  TESTED-ONLY row, every missed cluster, every false refutation, and every
  single-caller candidate

Before relying on an unlabelled claim, trace it or ask the owner. Recheck the
remaining retentions the same way `gateway_reviewer_model` was rechecked.

## Retained product boundary

Fiber supports these targets:

- macOS arm64
- Linux x86_64
- Linux arm64

Fiber does not support Windows, WebAssembly, WASI, Emscripten, freestanding
builds, macOS Intel, BSD variants, or other operating systems. `build.zig` must
reject unsupported targets before source branches that serve them are removed.

This matches `docs/ideas/fiber-product-transition.md`:277. The inherited Full CI
macOS Intel job is transition residue, not a product requirement.

## Corrected verdict policy

The 360-row corpus is resolved as follows:

- delete all 90 DEAD rows after rechecking the declaration and exact references
- delete 81 of the 82 CONFIRMED rows after rechecking the verifier evidence;
  retain `session_test_controls` for the Phase 5 recovery harness
- delete 56 of the 61 TESTED-ONLY rows, including their obsolete tests
- retain 3 TESTED-ONLY rows because they are useful test scaffolding over live
  behavior
- retract 2 stale TESTED-ONLY findings
- retain SINGLE-CALLER rows by default, but collapse the explicit candidates in
  this document when doing so removes a wrapper, constant branch, or dead chain
- retain REFUTED rows by default, but act on the explicit false refutations and
  constant-value clusters in this document

Origin no longer controls whether dead code is removed. The `deleted-product`
and `always-was` tags remain useful history, but both classes are Phase 4 work.

## Retracted and retained tested-only rows

Do not delete these rows:

- `src/core/shared/lexical_relevance.zig:35` — the reported `score` and `order`
  fields do not exist; the live `Score` fields are read by the comparator
- `src/core/terminal/contracts.zig:1671` — `AuthorityGrant.repeated_probes` is
  hashed, cloned, validated, and persisted; deleting its default alone is not a
  simplification
- `src/core/slash_commands/command_router.zig:311` — `TestContext` tests live
  command routing
- `src/builtins/hooks.zig:76` — `RecordingClient` tests the live hook contract
- `src/builtins/mcp.zig:1136` — `stableEmptyTestEnviron` is shared test setup for
  live MCP behavior

Retain `src/core/session/session_test_controls.zig`, including `logOptions` and
`pauseAtRequestedBoundary`. Phase 5 needs this crash-injection seam to rebuild
the session-recovery E2E harness.

## False audit premises

### The layering rule is not a fact about the tree

The audit brief says every production `src/core` import of `src/builtins` is
test-guarded. At least these production imports disprove it:

- `src/core/app/app_mcp_menu_runtime.zig:2`
- `src/core/cli/cli_ask.zig:65`

A one-implementation provider cannot be retained merely by citing that rule.
Each seam must be measured by production adapters, test adapters, effect
isolation, and dependency direction. The final seam audit records each decision.

### The audit covered `src`, not the whole tree

The shards covered all 490 Zig files under `src`. They excluded 6 tracked Zig
files, including `build.zig`. The build file matters because it still accepts
unsupported targets through `standardTargetOptions`.

### Reference counts are not semantic resolution

The mechanical counter confused same-named declarations and grouped fields with
their enclosing types. Every deletion must still be rechecked at slice open.
The corpus is a removal inventory, not compiler proof.

## Missed and mis-triaged clusters

The following clusters belong in Phase 4 even though the report deferred or
missed them:

- all `HostSandboxDefault` variation and
  `ShellAuthorizationSource.js_host`; production always supplies `.none`
- `TransientContextInput.host_workspace`, `HostWorkspaceContext`, and the
  alternate-host branch in `buildTurnContextFragmentForHost`; production never
  supplies host workspace data
- the legacy `GatewayCompletion`, `parseGatewayCompletion`, and
  `freeGatewayCompletion` parser family and its tests
- the dead request-building family in `src/gateway/agent_request_body.zig` and
  its test-only callers in `src/builtins/gateway.zig`
- `main.zig:464` `web_search_models_path` and the dead Fiber search backend
- the complete `subagent_panel` triple in `render_request.zig`,
  `frame_builder.zig`, and `frame_layout.zig`
- the complete `workspace_clean` family across execution, permission, tooling,
  terminal, and shell modules
- the direct-child prompt no-op in `resume_admission.zig` and both callers
- the cooperative live-session transition state that every production caller
  disables
- dead model-picker projection and rank helpers, including fields used only by
  that dead chain
- dead auth picker, logout, OAuth refresh, revoke, discovery, and precedence
  helpers whose callers disappeared during provider demolition
- the stale E2E case at `tests/e2e/cli.test.ts:626` that still expects the removed
  development update channel

## False refutations to act on

A live sibling branch does not keep an unsupported-target clause alive. Remove
the Windows, WASI, Emscripten, freestanding, and unsupported-OS clauses while
keeping Linux and macOS arm64 behavior.

Also simplify these refuted rows:

- `picker_presentation.zig:345` — inline the constant `subscription_source = true`
- `footer/viewport.zig:180` — remove the discarded `metrics` parameter
- `subagent/tool_host.zig:62` — remove `max_result_bytes`, whose only read is a
  discard
- `gateway/provider_set.zig:14,24` — remove unused `AuthStrategy` and its field
- `auth/credentials.zig:220` — remove the constant-true source refresh helper and
  guard
- `builtins/context.zig:102,165` — remove the always-true project-instruction
  switch while keeping instruction loading
- `command_specs.zig:137` — remove the always-true alias-completion flag
- `mcp/features/common.zig:103` and `features/tools.zig:708` — remove discarded
  protocol parameters
- `render_engine/frame_layout.zig:11` — collapse the one-value placement policy
- `shared/message.zig:16` — collapse the one-variant content union if the slice
  remains mechanical and all message ownership tests stay green

## Single-caller simplifications to act on

Collapse these rows now:

- `hosts/host.zig:136` `capabilitiesForTarget`
- `subagent/agent_adapter.zig:36` `childModelCapabilityResolver`
- `subagent/execution.zig:218,327` no-op tool activity recorder
- `app/app_callbacks.zig:49` `preparedDiffPayload`
- `tools/web/fetch.zig:33` `callWithTransport`
- `ui/approval_screen.zig:1261` `writeReviewRows`
- `terminal/ui_projection.zig:12` unread `attachable` field
- `app/app_terminal_runtime.zig:137,139` empty managed-facts chain
- the chain-dead helpers adjacent to DEAD or TESTED-ONLY entries in
  `read_file.zig`, `skill_runtime.zig`, `managed_execution_contract.zig`,
  `execution_memory.zig`, `gateway_error_format.zig`, `command_specs.zig`, and
  `mcp/elicitation.zig`

Keep single-caller code when it isolates a retained effect, protects persisted
or security state, or makes the caller materially easier to understand.

## Persisted and security contracts that stay

Maximal deletion does not justify data loss or weaker validation. Retain:

- terminal authority lifetimes, repeated-probe authority, schedules, monitor
  lifetimes, and hashes used to validate persisted records
- corrupt-session isolation and recovery branches
- bounded input and schema limits
- concrete clipboard, URL-opening, terminal-title, process, notification, OAuth,
  and stream seams with real unavailable or test adapters
- provider-shaped public commands and JSON selected in Phase 3
- the one-source Connections screen, which is retained by owner decision
Retracted 2026-09-05: `gateway_reviewer_model` is dead, not live behavior. See
the correction below. Delete it in Slice 19.

## Retracted: the `gateway_reviewer_model` retention

This file previously listed `gateway_reviewer_model` under owner decisions as
live behavior to retain until Phase 5. That was wrong on both counts. It was
never an owner decision, and the constant is not live.

The finding it came from is `deferred.md`:65, committed in `3f19ad7b`, which
records it as an audit observation: a Gateway-era model id that is "still the
live default" and therefore a rename rather than a deletion. This file promoted
that observation to an owner decision. No owner ever stated it.

The observation is also wrong. Tracing the production path:

```
main.zig, builtins/providers.zig
  -> openai_codex_permission_reviewer.provider
     .model = openai_codex_models.reviewer_model   // "gpt-5.4-mini"
  -> responses_permission_reviewer.review
  -> Reviewer.withTransportModel(..., adapter.model)
```

Every production construction passes an explicit model, so the
`Reviewer.model = gateway_reviewer_model` field default at
`auto_classifier.zig`:357 is never used in production. The only caller of
`Reviewer.withTransport`, which does take the default, is
`tool_admission.zig`:3981, inside a test.

Automatic permission review already runs on `gpt-5.4-mini`, selected from the
Codex catalog and asserted by `openai_codex_permission_reviewer.zig`:47
("Codex reviewer model remains catalog-selected gpt-5.4-mini").

`gateway_reviewer_model = "moonshotai/kimi-k3"` is therefore inherited dead
residue from the deleted Gateway product, reachable only from tests. All three
references live in `auto_classifier.zig` (`:15`, `:357`, `:1955`). Delete the
constant, retarget the field default to the Codex reviewer model, and update the
`:1955` assertion.

Changing the production reviewer model away from `gpt-5.4-mini` is a separate
product decision. The owner considered it on 2026-09-05 and declined for now, so
`openai_codex_models.reviewer_model` and the test asserting it both stay as they
are.

## Platform removal rule

First make unsupported targets fail in `build.zig`. Then remove their source and
test branches in bounded subsystem slices. Preserve branches that vary between
Linux and macOS arm64.

The final platform searches must find no unexplained occurrences of:

```sh
git grep -n -E '\.windows|\.wasi|\.emscripten|\.freestanding' -- src/ benchmarks/ tests/ build.zig
git grep -n -E '\.freebsd|\.netbsd|\.openbsd|\.dragonfly|\.plan9|\.illumos|\.haiku|\.serenity|\.uefi|\.solaris' -- src/
git grep -n -E 'std\.os\.windows|NtTerminateProcess|cmd\.exe|docker\.exe|COMSPEC|USERPROFILE'
git grep -n -E 'is_wasm|host_target' -- src/
```

Literal prose that describes rejected input may remain only when it is part of a
retained error contract. Every remaining hit needs a written justification.

## Slice 4 is narrower than the inventory says (2026-09-05)

*measured, not owner-stated.* The inventory's Slice 4 removal surface names
`provider_bundle`, `buildAgentRequest`, `buildAgentToolsJson`,
`writeDynamicFunctionTool`, and `toolNameSelected` as a "test-only
request-building family" to delete. Test-only is true. Dead is not.

`buildAgentRequest` is the request serialiser that both fake gateways use to
capture what the agent would have sent: `FakeGateway.stream` in
`src/core/agent/runtime/tests/support.zig` and `VisionGatewayFixture.stream` in
`src/core/tooling/tool_runtime.zig`. Those captures are asserted on by roughly
twenty retained tests — the whole of `tests/interruption_flow.zig`'s
`<turn_aborted>` and aborted-tool-output coverage, and the vision file-part
assertions in `tool_runtime.zig`. Deleting the family deletes that coverage.

`provider_bundle` has three live consumers that have nothing to do with request
building: the test configs in `app_entry_runtime.zig`, `cli_surface.zig`, and
`cli_ask.zig`, plus two provider-identity assertions.

Both are retained. What Slice 4 actually removes is the dead surface inside
`src/gateway/agent_request_body.zig`, measured by counting references per
declaration inside and outside test blocks: the legacy completion parser pair
and the superseded request-builder overloads, with their dependency closure and
their own tests. `agent_request_body.zig` is not deleted whole — six of its
declarations are reached from the retained fixture path.

The stop condition held as written: no production request path imports the
file. Its only importer is `src/builtins/gateway.zig`.
