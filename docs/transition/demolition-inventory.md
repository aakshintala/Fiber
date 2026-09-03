# Fiber demolition inventory

## Audited revision and worktree

- Branch: `main`
- Commit: `205370ce6169950ebdd3657d774786c1d8007fd0` (`205370ce`, `Merge ticket 02: Codex-only runtime`)
- Worktree before this report was written: `AGENTS.md` modified, planning documents untracked.
- The `AGENTS.md` modification and the existing planning documents were treated as planning context, not implementation changes.
- This report was written to `.scratch/` and moved to `docs/transition/` when its ambiguities were resolved. Paths in the ordered slices below are unaffected.
- Six workers wrote read-only findings to `/tmp/fiber-demolition-audit-{a,b,c,d,e,f}.md`. No worker changed the repository. This report is the only repository file created by the audit.

## Executive summary

The large embedding and provider implementations are already gone: `sdk/`, WebAssembly and Node-API artifacts and build options, SDK CI, npm publishing, Vercel and Grok provider bundles, Vercel host streaming, and the rejected provider command surface are absent.

Demolition is not finished. The remaining work falls into these primary owners:

1. Dead WASI branches and cooperative host paths left after the embedding products were removed.
2. Orphaned provider infrastructure: credits, team and tenant usage lookup, chat URL and secret-store plumbing, old settings keys, and a few dead modules and fixtures. Model catalog presentation is explicitly excluded; see resolution 6.
3. fx-state compatibility: explicit and automatic legacy session migration, including background-record migration.
4. Inherited commands, slash commands, aliases, and updater behavior.
5. Vercel CDN workflows, macOS Intel workflow entries, stale release tests, and removed-product documentation.

The fake-Gateway E2E harness still has many real callers, but most callers exercise retained behavior. It is repair evidence, not safe demolition. Convert those tests to the Codex fixture in Phase 5, deleting only scenarios proven to test rejected transport semantics. Likewise, live one-implementation provider and host seams belong to Phase 4 rather than demolition.

The ordered inventory below contains 20 bounded slices. Slices 1 through 14 are independent where their dependency fields allow. Slices 15 through 20 touch broad command, upgrade, or workflow surfaces and should follow their listed prerequisites.

## Design coverage matrix

Each row is independently classifiable. Compound design sentences are split so that one surviving clause cannot be hidden by an aggregate status.

### Embedding products

| ID | Design requirement | Classification | Evidence or destination |
| --- | --- | --- | --- |
| E01 | Remove the JavaScript and npm SDK under `sdk/` | already removed | `sdk/` is absent; no tracked SDK package remains |
| E02 | Remove `fx-core.wasm` and `fx-term.wasm` | already removed | No artifact or build reference matches either name |
| E03 | Remove browser terminal and JavaScript host adapters | already removed | No browser or JavaScript host implementation remains under `src/` |
| E04 | Remove the Node-API addon and fetch bridge | already removed | No `napi`, Node-API, or addon target remains |
| E05 | Remove `-Dwasm-surface` and `-Dnapi-surface` | already removed | `build.zig` defines neither option |
| E06 | Remove SDK-specific CI jobs | already removed | Current workflows contain no SDK, wasm, napi, or libfx job |
| E07 | Remove npm publishing for libfx | already removed | `.github/workflows/publish-libfx.yml` is absent; stale test reference remains in Slice 20 |
| E08 | Remove SDK demos, packaging, tests, and documentation | already removed | No SDK-owned demo, package, test, or live documentation surface found |
| E09 | Remove WebAssembly target branches without callers | pending deletion | Slices 5 through 7 |
| E10 | Simplify host profiles and target abstractions left with one implementation | deferred | Phase 4; only dead WASI and cooperative paths are demolished now |

### Rejected providers, credentials, usage, and search

| ID | Design requirement | Classification | Evidence or destination |
| --- | --- | --- | --- |
| P01 | Remove Vercel AI Gateway transport | already removed | Codex is the only real stream provider; residual URL/request plumbing is Slices 1 and 11 |
| P02 | Remove Vercel OAuth | already removed | Provider catalog and credential source contain Codex only; Vercel strings in generic OAuth tests are fixtures |
| P03 | Remove Vercel team selection | pending deletion | Dead picker projection in Slice 1; tenant and team usage fields in Slice 9 |
| P04 | Remove Vercel-related credentials and Keychain service | already removed | No Gateway credential or Keychain service remains; generic dead `SecretStore` seam is Slice 10 |
| P05 | Remove Grok provider and OAuth | already removed | No Grok provider or issuer remains. Inert vendor rows in the model catalog are retained per resolution 6 |
| P06 | Remove Grok configuration remnants | pending deletion | `grok_model` and rejected-provider fixtures in Slice 12 |
| P07 | Remove `/feedback` and its endpoint | pending deletion | Orphan `src/core/feedback/runtime.zig` and stale fixture/docs in Slice 1 |
| P08 | Remove Vercel host-stream Referer, title, protocol, and team headers | already removed | No host-stream provider or request team field remains; stale `JsHostStreamFailed` name is Slice 1 |
| P09 | Remove provider-specific deferred generation-usage lookup | pending deletion | Slice 9; retain exact Codex usage records |
| P10 | Keep provider-neutral search contracts | final verification | Preserve `src/core/tooling/web_search_{contract,policy,provider}.zig` |
| P11 | Keep MCP search as an explicit alternative | final verification | Preserve MCP search tool plumbing; no silent fallback found |
| P12 | Keep provider-native search gating | final verification | Current gating is in app, ask, ACP, and subagent paths; exercise Codex separately in Phase 5 |
| P13 | Remove a Vercel search adapter | already removed | No adapter is wired; only dead Gateway input fields remain for Slices 11 or Phase 4 |
| P14 | Do not select a replacement Fiber search backend | deferred | No implementation during cutover |

### Commands, aliases, settings, and flags

| ID | Design requirement | Classification | Evidence or destination |
| --- | --- | --- | --- |
| C01 | Remove `setup` | already removed | No top-level kind, spec, parser, or dispatch branch |
| C02 | Remove `teams` | already removed | No top-level kind, spec, parser, or dispatch branch |
| C03 | Remove `credits`, `balance`, `/credits`, and `/balance` | already removed | Command surface is absent; orphan credits contracts are Slice 2 |
| C04 | Remove the global `provider` command | already removed | No command surface remains |
| C05 | Remove the active-provider setting | pending deletion | Slice 12; runtime seam collapse waits for Phase 4 |
| C06 | Remove top-level `pr` and `issue` | pending deletion | Slice 13 |
| C07 | Remove `/alias`, `/reset`, `/stats`, `/cost`, `/allowlist`, and `/version` | pending deletion | Slice 15 |
| C08 | Remove `/image`, `/images`, `/img`, and `/paste` | pending deletion | Slice 16; preserve composer and `ask --image` attachment behavior |
| C09 | Remove `/copy` | pending deletion | Slice 16; preserve clipboard behavior with other callers. `/undo` is retained (owner decision: only non-git revert of an agent edit); `/trace` is deferred to Phase 6 (diagnostic instrument needed during demolition) |
| C10 | Remove `/statusline`, `/sound`, and `/fast` | pending deletion | Slice 17. Commands only: `sound_level` and status rendering are retained and stay reachable through `/settings` |
| C11 | Remove `session migrate` | pending deletion | Slice 14; current help, parser, dispatch, snapshot, and tests remain |
| C12 | Remove `-r`, `--resume`, `--resume-last`, `--continue`, `-c`, and `--resume-<id>` | pending deletion | Slice 14; retain bare `resume`, `continue`, `session resume`, and `ask --resume-id` |
| C13 | Replace `/continue` recovery and `ask --continue-recovery` with `/retry` and `ask --retry` | new implementation | Phase 3 atomic replacement |
| C14 | Replace top-level `login` and `logout` plus `/login` and `/logout` with `auth` and `/auth` | new implementation | Phase 3 atomic replacement; retain Codex authentication runtime |
| C15 | Replace `mcp auth` with `mcp login` | new implementation | Phase 3 |
| C16 | Remove `mcp list --connect` | pending deletion | Slice 18; `mcp doctor` is Phase 3 |
| C17 | Remove persisted `fast_mode` and make fast a model property | pending deletion | Setting and slash command in Slice 17; model property in Phase 3 |
| C18 | Replace ask `--auto`, `--yolo`, and `--prompt-permissions` with `--permission-mode` | new implementation | Phase 3 atomic replacement |
| C19 | Remove `--no-color` and honor `NO_COLOR` | new implementation | Phase 3 atomic replacement |
| C20 | Add ask `--model` and `--effort` | new implementation | Phase 3 |
| C21 | Keep ask `--quiet`, `--no-save`, `--image`, and `--resume-id` | final verification | Preserve while deleting aliases |
| C22 | Remove automatic update checks and `upgrade --channel` during WIP | pending deletion | Slice 19. Owner decision: the `upgrade` command and updater module are retained; only the Vercel CDN contract and dev channel are removed |
| C23 | Rename internal terminal re-exec flags without aliases | rename | Phase 2; generated bootstrap string requires manual review |
| C24 | Support `--json` on every retained operational command | new implementation | Phase 3 contract audit |
| C25 | Remove stale `acp --model` and `acp --log-file` surface | pending deletion | Slice 18. Contrary to the design’s current-state note, parser support is live as well as help text |
| C26 | Remove ACP config options `provider` and `mode`; retain `model`, add `effort`, use `session/set_mode` | new implementation | Phase 3 |
| C27 | Rename ACP mode `code` to `auto` and expose `yolo` | new implementation | Phase 3 |

### State and compatibility

| ID | Design requirement | Classification | Evidence or destination |
| --- | --- | --- | --- |
| S01 | Do not import or migrate fx sessions | pending deletion | Automatic and explicit legacy session migration in Slices 3 and 14 |
| S02 | Do not migrate old background-record state | pending deletion | Slice 4 |
| S03 | Do not add an fx-to-Fiber compatibility reader | already removed | No Fiber identity exists yet and no dual-root reader was found |
| S04 | Rename executable, environment, state, config, formats, fixtures, and credentials | rename | Phase 2 |
| S05 | Rename retained Keychain services and require fresh auth | rename | Phase 2; no removed Gateway service remains |
| S06 | Add session removal through CLI and ACP | new implementation | Phase 3 |
| S07 | Keep recovery separate from retry | new implementation | Phase 3 contract work |

### Release, distribution, platform, and documentation

| ID | Design requirement | Classification | Evidence or destination |
| --- | --- | --- | --- |
| R01 | Delete `cdn-backfill.yml` | pending deletion | Slice 20 |
| R02 | Delete `dev-release.yml` | pending deletion | Slice 20 |
| R03 | Delete `publish-libfx.yml` | already removed | Stale assertion removed in Slice 20 |
| R04 | Delete `prepare-release.yml` | narrowed to strip | Slice 20. Owner decision: remove the Gateway changelog step and `vercel-labs` leak regex; retain commit-signature verification |
| R05 | Remove Vercel CDN and development update channel | pending deletion | Slices 19 and 20. The CDN contract and `Channel.dev` go; the updater runtime stays |
| R06 | Provide no installer or custom install domain during WIP | pending deletion | README and CONTRIBUTING cleanup in Slice 20 |
| R07 | Drop macOS x86_64 work from retained workflows | pending deletion | Slice 20 |
| R08 | Retain `ci.yml`, `bench.yml`, `binary-size.yml`, and `pgso-macos-arm64.yml` temporarily | final verification | Only Intel matrix rows are removed |
| R09 | Decide the fate of `full-ci.yml` | deferred | The product design neither names it for deletion nor includes it in the temporary retain list; the transition process suspends Full CI rather than requiring this workflow |
| R10 | Design GitHub Release distribution, signing, and updater behavior before `0.0.1` | deferred | Phase 6 prerequisite, not cutover implementation |
| R11 | Add NOTICE, attribution, Fiber changelog, and `0.0.1` identity | rename | Phase 2 identity plus Phase 6 documentation; do not publish |
| R12 | Rewrite process documentation | deferred | Phase 6 after behavior is verified |

## Ordered demolition slices

Every slice is limited to one subsystem or about 15 files. A stop condition means do not widen the slice; return to the controller with the evidence.

### Slice 1: orphaned rejected-provider debris

- Paths and symbols: `src/core/feedback/runtime.zig`; `src/core/auth/api_key_validator.zig`; unused import in `src/main.zig`; `src/core/auth/auth_transition.zig`; test-only re-export shims `src/gateway/web_search.zig` and `src/gateway/web_search_types.zig`; `teamQueryProjection` declarations in `src/ui/footer/picker_presentation.zig`; stale `JsHostStreamFailed` exclusions in `src/gateway/client.zig`; feedback URL fixture in `src/ui/render_engine/transcript_blocks.zig`.
- Retained invariants: generic OAuth tests, provider-neutral search contracts, semantic-notice hyperlink rendering, the model cache, and the current fake-Gateway E2E model-catalog hook remain.
- Exact post-deletion searches: `feedback/runtime`, `fx.sh/feedback`, `api_key_validator`, `auth_transition`, `gateway/web_search.zig`, `gateway/web_search_types.zig`, `teamQueryProjection`, `JsHostStreamFailed`.
- Dependencies: none.
- Stop if: either web-search shim has a non-test importer, the feedback URL is asserted as product behavior, or an auth-transition symbol has an external caller.

### Slice 2: orphaned credits contracts

- Paths and symbols: `src/core/gateway/gateway_provider.zig` (`CreditsLookupInput`, `CreditsProvider`, `unavailable_credits_provider`); `src/core/gateway/provider_set.zig` (`Bundle.credits`); `src/core/output/output_contracts.zig` (`CreditsSnapshot`); `src/main.zig` (`creditsProvider`); test probes in `src/core/cli/cli_surface.zig`.
- Retained invariants: all non-credit provider contracts and output snapshots.
- Exact post-deletion searches: `CreditsLookupInput`, `CreditsProvider`, `CreditsSnapshot`, `creditsProvider`, `unavailable_credits_provider`, `.credits`.
- Dependencies: none.
- Stop if: a non-test command or provider initializes the credits field.

### Slice 3: legacy session import

- Paths and symbols: `src/core/session/session_migration.zig`; legacy parse functions in `session_json.zig`; migration branches in `session_store.zig`; fields and limits in `session_store_types.zig`; legacy discovery in `session_discovery.zig`; legacy fingerprint and rollback path in `session_authority.zig`; oversized-legacy diagnostics in `src/core/cli/doctor_runtime.zig`; source test imports in `src/main.zig`.
- Retained invariants: schema-v3 event-log sessions still list, show, resume, and recover; corrupted current-format sessions still produce diagnostics.
- Exact post-deletion searches: `session_migration`, `parseLegacyExact`, `parseLegacySchemaVersion`, `parseLegacySummaryStreaming`, `automatic_legacy_max_bytes`, `allow_large_legacy`, `oversized_legacy_snapshot`, `legacyFingerprintMatches`, `session.legacy.json`.
- Dependencies: none.
- Stop if: any legacy parser is used for a current schema-v3 event or authority record.

### Slice 4: legacy background-record migration

- Paths and symbols: `src/core/session/legacy_background_migration.zig`; call sites in `src/core/app/app_session_runtime.zig`, `src/core/cli/cli_ask.zig`, and `src/acp/sessions.zig`; test import in `src/main.zig`.
- Retained invariants: current background records with `process_token` still load and stale live-process handling remains for current records.
- Exact post-deletion searches: `legacy_background_migration`, `legacy process`, `schema_version = 2` around background records.
- Dependencies: none.
- Stop if: the migration function also validates or repairs current-format records.

### Slice 5: WASI branches in ACP and MCP

- Paths and symbols: `src/acp/server.zig`, `src/acp/prompt.zig`, `src/acp/jsonrpc.zig`, `src/acp/sessions.zig`; `src/core/mcp/atomic_value.zig`, `stdio_dispatcher.zig`, `legacy_http_sse.zig`, `mcp_auth.zig`, `tool_subscription.zig`; their `host_target.is_wasm` branches, including `wasm_state` and `commitWasmSessionLocked`.
- Retained invariants: native ACP framing and flush behavior, MCP stdio and HTTP transport, and native atomics.
- Exact post-deletion searches: `host_target.is_wasm` within `src/acp/` and `src/core/mcp/`; `wasm_state`; `commitWasmSessionLocked`; `atomic_value.zig` if replaced directly.
- Dependencies: none.
- Stop if: a branch varies by a retained target rather than WASI alone.

### Slice 6: WASI branches in auth and app entry

- Paths and symbols: `src/core/auth/login_flow.zig`, `chatgpt_oauth.zig`, `chatgpt_session.zig`, `session_presence.zig`; `src/core/app/app_entry_runtime.zig`; `src/core/terminal/client.zig`; `GracefulExitSigintGuard`, `run_if_requested`, and WASI OAuth or terminal guards.
- Retained invariants: native Codex browser authentication, cancellation, signals, and terminal sessions.
- Exact post-deletion searches: `host_target.is_wasm` in the listed paths; `ChatGptOAuthUnavailable` branches that existed only for WASI.
- Dependencies: none.
- Stop if: a guard is required by non-WASI headless execution.

### Slice 7: remaining WASI target branches

- Paths and symbols: `src/main.zig`; `src/core/agent/runtime/orchestrator.zig`; `src/core/app/app_entry_runtime.zig` only if not completed in Slice 6; `src/builtins/context.zig`; `src/builtins/hooks/herdr.zig`; `src/ui/shell_runtime.zig`; `src/ui/terminal/theme_detection.zig`; `src/tools/shell/shell.zig`; remaining direct `builtin.os.tag == .wasi` uses; finally `src/core/hosts/target.zig`.
- Retained invariants: native worker threads, shell execution, terminal rendering, signals, MCP loading, and ACP operation.
- Exact post-deletion searches: `host_target`, `is_wasm`, `\.wasi`, `loadNoMcpRuntime`, `idle_wasm_poll_timeout_ms`.
- Dependencies: Slices 5 and 6 before deleting `target.zig`.
- Stop if: any direct `.wasi` branch belongs to generic standard-library portability rather than the removed product target.
- Rescope (2026-09-03): a read-only classification pass found the slice far larger than the path list above. Roughly 40 removable sites span 23 files, and 21 further files carry `.wasi` lines that are genuine per-OS portability guards and must survive. Files the original list omits entirely: `src/core/shared/debug_trace.zig`, `src/core/agent/runtime/gateway_step.zig`, `src/core/shared/io.zig` (line 968 only), `src/core/execution/managed_execution.zig`, `src/core/terminal/native_session.zig`, `src/core/terminal/host.zig`, `src/core/hosts/native.zig`, `src/core/workspace/workspace_files.zig` (line 931 only), `src/core/tooling/tool_dispatch.zig`, and `src/tools/shell/shell.zig`. Slice 7 is therefore split into 7a (removable sites outside `main.zig`) and 7b (`main.zig` plus `target.zig` deletion) to stay under the file cap.
- Classification rule: `host_target.is_wasm` is always removable. A direct `builtin.os.tag` test is removable only when `.wasi` stands alone; when it appears beside `.windows` (or `.freestanding`) it is a portability guard and stays. Two exceptions found by inspection: `src/core/tooling/tool_runtime.zig:389` is a bare `.wasi` test that is removable, and `src/core/cli/cli_ask.zig:100` is a `.windows, .wasi, .freestanding` matrix arm that stays.
- Rescope (2026-09-03, second pass): of the 11 `main.zig` sites left for 7b, two — `cooperativeTransportPulse` (line 448) and `processNextCooperativePrompt` (line 943) — are `if (comptime !host_target.is_wasm) return;` guards where the mechanical unwrap doesn't just drop a branch, it guts the rest of the function (the real body is wasm-only cooperative-pulse logic that becomes unreachable). Both functions are already named for full removal in Slice 8. Collapsing the guard here would either duplicate Slice 8's work early or leave dead code sitting behind a bare `return;` for one slice. 7b now transforms the other 9 `main.zig` sites plus both `orchestrator.zig` sites only, and leaves `target.zig` in place — its last two references (from these two functions) die when Slice 8 deletes the functions, so `target.zig`'s deletion moves to the tail of Slice 8. 7b also deletes the two helpers it orphans: `loadNoMcpRuntime` (main.zig:556, dead once all four `is_wasm` ternaries collapse to `builtin_mcp.loadRuntime`) and `idle_wasm_poll_timeout_ms` (main.zig:179, dead once the `loopPollTimeoutMs` fallback branch is dropped).

### Slice 8: cooperative threadless host mode

- Paths and symbols: `src/core/app/app_entry_runtime.zig` (`runInteractiveCooperative`, cooperative parameter); `src/core/auth/login_flow.zig` (`startPreparedCooperative`); `src/main.zig` (`cooperativeTransportPulse`, `processNextCooperativePrompt`); `src/core/app/app_callbacks.zig`; `src/core/agent/runtime/deps.zig`; `src/core/agent/runtime/orchestrator.zig`; `src/core/agent/stream_provider.zig` (`cooperative_pulse`); `src/core/hosts/runtime_profile.zig` (`cooperative_agent`); finally `src/core/hosts/target.zig` and its two remaining `host_target` imports in `main.zig`/`orchestrator.zig` (see 7b rescope).
- Retained invariants: native threaded prompt execution, sign-in polling, cancellation, and subagents.
- Exact post-deletion searches: `runInteractiveCooperative`, `startPreparedCooperative`, `cooperativeTransportPulse`, `processNextCooperativePrompt`, `CooperativePulse`, `cooperative_pulse`, `cooperative_agent`, `host_target`, `is_wasm`.
- Dependencies: Slices 5 through 7.
- Stop if: any entry point can select cooperative mode on a retained target.

### Slice 9: deferred usage and team dimension

- Paths and symbols: `src/core/agent/stream_provider.zig` (`DeferredUsageReference`, usage `.deferred`, tenant fields); `src/core/session/generation_usage_provider.zig`; deferred lookup and pending-team paths in `session_usage.zig`; related codec in `session_usage_sidecar.zig`; `src/core/gateway/provider_set.zig` (`deferred_usage`, `deferredUsageProviders`); `src/core/auth/credentials.zig` (`team_context`); callers in `src/core/cli/cli_ask.zig`, `src/acp/server.zig`, `src/acp/sessions.zig`, and `src/main.zig`; owned tests in `src/core/tooling/tool_runtime.zig`.
- Retained invariants: exact Codex generation usage, usage persistence, reconciliation, and billable search counts.
- Exact post-deletion searches: `DeferredUsageReference`, `deferred_usage`, `deferredUsageProviders`, `validateTeam`, `team_context`, `pending.team`, `credential.tenant`, `LookupInput.tenant`.
- Dependencies: none.
- Stop if: the Codex transport constructs `.deferred`, or removing a codec field prevents current-format exact-usage records from loading.

### Slice 10: dead host SecretStore seam

- Paths and symbols: `src/core/hosts/host.zig` (`SecretStore`, retain `SecretStorePresence`); `src/core/auth/credentials.zig`; `src/core/auth/auth_runtime.zig`; `src/core/app/app_lifecycle.zig`; `src/core/app/app_entry_runtime.zig`; `src/core/cli/acp_runner.zig`; `src/core/cli/cli_surface.zig`; composition call sites in `src/main.zig`, `src/acp/prompt.zig`, `src/acp/sessions.zig`, `src/core/app/app_agent_runtime.zig`, and `src/core/tooling/tool_runtime.zig`.
- Retained invariants: Codex file-based session credentials and MCP OAuth’s direct native-keychain path.
- Exact post-deletion searches: `host.SecretStore`, `host_mod.SecretStore`, `unavailable_secret_store`, `secret_store`; retain and verify `SecretStorePresence`.
- Dependencies: none.
- Stop if: any real `SecretStore` initializer or non-null load/store implementation is found, or MCP OAuth routes through this seam.

### Slice 11: dead Gateway chat URL plumbing

- Paths and symbols: `src/core/gateway/gateway_provider.zig` (`ChatUrlProvider`); `src/builtins/gateway.zig` (`chat_url_provider`, `resolveChatUrl`); `src/main.zig` (`agentChatUrl`); `gateway_chat_url` and unused permission-review `endpoint` fields in `src/core/tooling/web_search_runtime.zig`, `web_search_provider.zig`, `tool_runtime.zig`, `src/core/app/app_agent_runtime.zig`, `app_entry_runtime.zig`, `src/core/agent/runtime/config.zig`, `src/core/cli/cli_ask.zig`, `src/core/cli/cli_surface.zig`, `src/core/subagent/agent_adapter.zig`, `src/acp/prompt.zig`, and `src/acp/sessions.zig`.
- Retained invariants: `CliModelCatalogInput.endpoint`, Codex model endpoint, permission review, and the provider-neutral search execution contract.
- Exact post-deletion searches: `ChatUrlProvider`, `resolveChatUrl`, `agentChatUrl`, `gateway_chat_url`, `ai-gateway.vercel.sh/v3/ai/language-model`; inspect every remaining `.endpoint` rather than deleting by name.
- Dependencies: Slice 1 for dead test fixture cleanup.
- Stop if: a retained search backend reads one of these fields, or an `endpoint` is the Codex catalog endpoint.

### Slice 12: provider settings keys

- Paths and symbols: `src/core/config/settings_store.zig` (`provider`, `codex_model`, `grok_model` compatibility keys); `src/core/config/config_runtime.zig` corresponding reads and profile-only list; rejected-provider fixtures in `src/acp/sessions.zig`.
- Explicitly out of scope per resolution 6: `src/core/gateway/model_catalog.zig`, `src/core/app/model_cache_runtime.zig`, and `src/ui/footer/model_menu_presentation.zig` are not touched. The catalog is already provider-neutral and self-pruning; its rejected-vendor rows are inert.
- Retained invariants: current `model` and `models` settings, Codex model selection, capability merge, namespaced model identifiers, and the entire model catalog ranking, featured-family, and provider-tab machinery.
- Exact post-deletion searches: `grok_model`, `codex_model`, settings key `"provider"`. Do not search-and-delete `modelProviderRank`, `modelTierRank`, `featured_picker_families`, or any `ModelProviderFilter` variant.
- Resolutions 6 and 7 apply: touch no catalog file; read removed settings keys nowhere and add no compatibility path for them.
- Dependencies: Slice 9 if provider fields overlap.
- Stop if: `codex_model` is the only source of the active model in a newly written current settings file, or the slice grows to include catalog, model-cache, or model-menu files.

### Slice 13: top-level pr and issue wrappers

- Paths and symbols: specs in `src/builtins/commands.zig`; kinds in `src/core/slash_commands/command_specs.zig`; parser, dispatch, and `runGithubWorkflow` in `src/core/cli/cli_surface.zig`; `src/core/github/github_publish.zig`; `src/core/github/github_workflows.zig`; branches and test imports in `src/main.zig`; owned cases in `tests/e2e/cli.test.ts`.
- Retained invariants: generic git context used elsewhere and ordinary agent requests involving GitHub.
- Exact post-deletion searches: top-level kinds `.pr` and `.issue`, `runGithubWorkflow`, `github_publish`, `github_workflows`, CLI help tokens `pr <` and `issue <`.
- Dependencies: none.
- Stop if: a `src/core/github/` module has a caller outside these wrappers; retain that module.

### Slice 14: session migrate and resume aliases

- Paths and symbols: session spec and help in `src/builtins/commands.zig`; parser, dispatch, `parseSessionMigrationArgs`, `resume_id_alias_prefix`, and `resume_picker_alias` in `src/core/cli/cli_surface.zig`; `SessionMigrationSnapshot` in `src/core/output/output_contracts.zig`; ask `--resume` alias in `src/core/cli/cli_ask.zig`; help snapshots in `src/core/slash_commands/command_specs.zig`; owned sections in `tests/e2e/cli.test.ts`.
- Retained invariants: `session list|show|resume|recover|rename`, `sessions`, bare `resume`, bare `continue`, and `ask --resume-id`.
- Exact post-deletion searches: `session migrate`, `parseSessionMigrationArgs`, `SessionMigrationSnapshot`, `resume_id_alias_prefix`, `resume_picker_alias`, `--resume-last`, `--resume-<id>`, exact `"--resume"` parser checks. Allow `--resume-id` only.
- Dependencies: Slice 3 removes the underlying legacy migration path first.
- Stop if: removal catches bare command `resume`, bare command `continue`, or `ask --resume-id`.

### Slice 15: basic inherited slash commands

- Paths and symbols: kinds, specs, aliases, parser and dispatch for `/alias`, `/reset`, `/stats`, `/cost`, `/allowlist`, and `/version` in `src/core/slash_commands/command_specs.zig`, `src/builtins/commands.zig`, and `src/core/slash_commands/command_router.zig`; handlers in `src/core/app/app_commands.zig`; completion code in `src/core/app/input_completion_runtime.zig`; owned cases in `tests/e2e/tui-slash-extra.test.ts`, `tui-slash-menu.test.ts`, and `tui-command-permissions.test.ts`.
- Retained invariants: `/usage`, `/permissions`, `/new`, `/clear`, model aliases if they have non-command callers, and permission rule storage.
- Exact post-deletion searches: each exact slash literal and corresponding `SlashKind`; `allowlistArgCompletionPrefix`; command-specific handler names.
- Dependencies: none.
- Stop if: deleting `/reset` changes `/new` or `/clear`, or deleting `/allowlist` removes permission rule enforcement.
- Owner decision on `/allowlist`: delete it. `/permissions` (mode only: ask/auto/yolo/reset) is the retained TUI surface and auto mode is the real usage. Persistent allow rules are a headless/RPC concern; Phase 3 owns them as a CLI surface, not a slash command.

### Slice 16: inherited media and history slash commands

- Paths and symbols: kinds, specs, dispatch, handlers, completions, and tests for `/image`, `/images`, `/img`, `/paste`, and `/copy` in the same registry and app files as Slice 15; affected cases in `tests/e2e/tui-slash-extra.test.ts`, `tui-slash-menu.test.ts`, and `tui-command-permissions.test.ts`.
- Retained by owner decision: `/undo` and `src/core/workspace/change_tracker.zig` (`undoLast`, `app_commands.zig:1185`) stay. It is the only revert of an agent edit that does not go through git, and the tracker is separately live for prompt-context injection. `/trace` (`handleTraceReport`, `app_commands.zig:558`) is deferred to Phase 6: it is the built-in diagnostic report and demolition is when it is most needed.
- Retained invariants: composer paste/drop attachment, native clipboard image attachment, `ask --image`, clipboard host support, and retained change tracking.
- Exact post-deletion searches: each deleted slash literal and kind; the command-only copy handler. Do not search-and-delete `undoLast` or the trace handler.
- Dependencies: Slice 15 should land first to reduce shared-registry conflicts.
- Stop if: an image or clipboard symbol is used by retained composer, diagnostics, or permission behavior.

### Slice 17: fast, statusline, and sound commands

- Paths and symbols: `/fast`, `/statusline`, and `/sound` kinds/specs/dispatch in command registry files; handlers and menus in `src/core/app/app_commands.zig`; `fast_mode` and `fast_mode_model_bound` in `src/core/config/config_runtime.zig` and `settings_store.zig`; command completions; owned cases in `tests/e2e/config-persistence.test.ts`, `notifications.test.ts`, and `tui-slash-menu.test.ts`.
- Retained invariants: model picker, status rendering, notification runtime and configured cue handling. Remove only persisted `fast_mode`; session-record fast fields wait for Phase 3 model-routing decisions.
- Exact post-deletion searches: slash literals `/fast`, `/statusline`, `/sound`; `fast_mode`, `fast_mode_model_bound`; their command handler and completion names.
- Dependencies: Slice 15.
- Resolution 5 applies: delete the `/sound` command only. `sound_level`, the notification runtime, and terminal bells are retained.
- Stop if: a fast field is part of the current session record rather than profile settings.

### Slice 18: MCP connect flag and stale ACP launch flags

- Paths and symbols: `mcp list --connect`, `parseAcpArgs`, ACP model/log fields and help in `src/core/cli/cli_surface.zig`, `src/core/cli/acp_runner.zig`, and `src/builtins/commands.zig`; their Zig tests and ACP help cases in `tests/e2e/cli.test.ts`.
- Retained invariants: ordinary `mcp list`, MCP connection runtime, ACP startup, and ACP model selection through `session/set_config_option`.
- Exact post-deletion searches: `mcp list [--connect]`, exact `"--connect"` in MCP parser, ACP launch `"--model"`, ACP launch `"--log-file"`, `model_override`, `log_file`.
- Dependencies: none.
- Stop if: a flag occurrence belongs to ask, another command, or an internal test runner rather than ACP launch.

### Slice 19: strip the CDN contract and dev channel from the updater

Owner decision: `src/core/upgrade/` is retained and stays compiled and wired. This slice removes only the rejected distribution contract, not the updater. This reverses the design's resolved position that the module must be deleted; with the CDN base URL gone and the startup auto-check removed, no forbidden contract remains in the binary.

- Paths and symbols: `src/core/upgrade/upgrade_helpers.zig` (`cdn_base = "https://releases.fx.sh"`, `resolveCdnBase`, and the `/latest.txt` and `/dev.json` branches of `fetchTarget`); `src/core/upgrade/update_target.zig` (`Channel.dev` and its comparison paths); `upgrade --channel` parser and dispatch in `src/core/cli/cli_surface.zig` plus the flag in the `src/builtins/commands.zig` spec; `update_channel` in the settings store and config runtime; build channel in `src/ui/render.zig` and `build.zig`; `FX_AUTO_UPGRADE` startup auto-check wiring in `src/core/app/app_entry_runtime.zig`, `app_bootstrap_runtime.zig`, and `app_lifecycle.zig`; channel assertions in `tests/e2e/cli.test.ts`.
- `fetchTarget` takes its base URL from configuration with no compiled-in default. Phase 6 supplies the GitHub Releases lookup.
- Retained invariants: the `upgrade` command; download, verification, and install in `upgrade_runtime.zig`; the validated relaunch handoff in `app_upgrade_runtime.zig` and `app_entry_runtime.zig:323-403`, including teardown ordering and the resume-id passthrough; `FX_E2E_UPGRADE_BASE_URL` as the test hook; version output; `ctrl+g` and other non-upgrade key behavior.
- Exact post-deletion searches: `releases.fx.sh`, `latest.txt`, `dev.json`, `resolveCdnBase`, `cdn_base`, `Channel.dev`, `update_channel`, `update-channel`, `FX_AUTO_UPGRADE`. Do not search-and-delete `core/upgrade`, `upgrade-relaunch`, or top-level `.upgrade`.
- Dependencies: none. No Gateway URL debris exists inside `src/core/upgrade/`, so Slice 11 is not a prerequisite.
- Stop if: removing the auto-check breaks the relaunch handoff, or a channel field has a consumer outside distribution.

### Slice 20: workflows, macOS Intel, stale release tests, and docs

Owner decision: CI and release workflows are stripped of Vercel and Intel work, not deleted. Signing and notarization prior art is retained.

- Delete outright: `.github/workflows/cdn-backfill.yml` (162 lines, entirely `blob.vercel-storage.com` PUTs) and `dev-release.yml` (Vercel blob publishing for the removed dev channel, plus an Intel target).
- Strip `release.yml`, do not delete: remove the `build-macos-x86_64` job (around lines 88-108) and its entry in the `needs` list (around line 191), and the Vercel blob publish steps (around lines 249-265). Retain `sign-macos-arm64`, `scripts/sign-and-notarize-macos.sh`, and the version check. Phase 6 replaces the publish step with a GitHub Release upload.
- Strip `prepare-release.yml`, do not delete: remove the Vercel AI Gateway changelog generation (around lines 133-140) and the `vercel-labs` leak-check regex (around line 174). Retain commit-signature verification (around line 297).
- Leave `full-ci.yml` untouched.
- Remove macOS Intel matrix entries from `.github/workflows/ci.yml` and `binary-size.yml`; update `scripts/tests/test_binary_size.py`; remove stale publish-libfx, dev-release, and Intel assertions from `scripts/tests/test_macos_signing.py`.
- Strip removed CDN, installer, Vercel/Grok, `/feedback`, and dev-channel instructions from `README.md` and `CONTRIBUTING.md`. Keep `upgrade` documentation minus the channel flag.
- Retained invariants: Linux x86_64, Linux arm64, macOS arm64, `pgso-macos-arm64.yml`, MCP conformance npm development tooling, Apache-2.0 attribution, and macOS signing and notarization.
- Exact post-deletion searches: `cdn-backfill`, `dev-release`, `publish-libfx`, `blob.vercel-storage.com`, `releases.fx.sh`, `dev.json`, `ai-gateway.vercel.sh`, `vercel-labs`, `macos-15-intel`, `x86_64-macos`, `macos-x86_64`, `fx.sh/setup.sh`, `login grok`, `Vercel AI Gateway`, `/feedback`. Do not search-and-delete `prepare-release` or `sign-and-notarize`.
- Dependencies: Slice 19 before removing updater documentation.
- Stop if: an Intel string is a negative guard proving Intel is rejected, an npm use belongs to MCP conformance, or a historical changelog/required attribution match is encountered.

## Later-phase backlog

### Phase 2: Fiber identity cutover

- Rename `fx`, all retained `FX_*`, `~/.fx/`, `.fx.json`, artifacts, fixtures, tape and relationship signatures, context and vision contract names, internal terminal flags, ACP metadata, HTTP user agents, and retained Keychain services.
- Rename the retained native HTTP/gateway terminology where it expresses product identity rather than a generic provider boundary.
- Add `NOTICE`, concise upstream attribution, and the independent Fiber release identity. Do not add compatibility readers.

### Phase 3: contract implementation

- Land `auth`, `/auth`, permissions mode and rule commands, `mcp login`, `mcp doctor`, session remove, retry, context usage, usage-by-session, and complete JSON output.
- Replace old ask permission flags with `--permission-mode`; replace `--no-color` with `NO_COLOR`; add ask model and effort controls.
- Align ACP config and modes, including context usage and session removal.
- Resolve `/new` as canonical with `/clear` as alias and keep `/exit` as `/quit` alias.

### Phase 4: simplification

- Collapse `runtime_profile`, one-element provider selection, provider identity arrays/enums, OAuth transport pass-through, one-adapter host vtables, and one-source auth picker UI only after Phase 3 fixes the final contracts.
- Keep genuine seams: stream provider with injected test fakes, permission reviewer provider, provider-neutral search adapter contract, and useful test dependency injection.
- `host.SecretStore` is not one of these seams and Slice 10 deletes it. A future Databricks or API-key provider does not want it back: its signature is a single unkeyed blob (`load_fn(alloc) -> ?[]u8`) with no account, expiry, or refresh, while `docs/ideas/databricks-provider-support.md` requires per-workspace credentials with expiry and scheduled refresh. The reusable asset is `src/core/hosts/native_keychain.zig`, which Slice 10 retains; generalizing its three MCP-named entry points to take a service and account key is the whole cost.
- Review dormant search input fields after the retained backend contract is fixed; do not pre-design the deferred Fiber backend.

### Phase 5: repair and exhaustive verification

- Convert fake-Gateway E2E callers to `fakeCodexEnv` or `startFakeCodex` one suite at a time. `rg -l 'startFakeGateway|FAKE_GATEWAY_MODEL|/v3/ai/language-model|/v1/generation' tests/e2e` currently returns 38 files, including shared helpers. Preserve `FX_E2E_GATEWAY_MODELS_URL` and its production test hook until these callers move; then delete the hook if no caller remains. Do not delete mixed suites merely because their fixture is rejected.
- Convert the two test-only `buildAgentRequest` callers in `src/core/tooling/tool_runtime.zig` and `src/core/agent/runtime/tests/support.zig` to a Responses/Codex fixture, then delete `src/gateway/agent_request_body.zig` and the fixture-only builder in `src/builtins/gateway.zig` if no caller remains.
- Exercise ACP, TUI, ask, JSON automation, Codex search gating, sessions, subagents, and editor integration.

### Phase 6: final documentation and release preparation

- Rewrite `AGENTS.md`, `CONTRIBUTING.md`, README, changelog, platform, CI, and release guidance around observed Fiber behavior.
- Decide direct GitHub Release artifacts, signing, and local fast/exhaustive gates before `0.0.1`.
- Point the retained `fetchTarget` at a GitHub Releases lookup and restore a release publish step to `release.yml` in place of the removed Vercel blob PUTs.

## Ambiguities requiring human decisions

Resolved by the owner (2026-09-02). No ambiguity remains open.


1. **`release.yml`:** retain and strip. Remove the macOS Intel job and the Vercel blob publish steps; keep the arm64 signing and notarization jobs. See Slice 20.
2. **`full-ci.yml`:** retain untouched. It does not run unless triggered and costs nothing to keep as Phase 6 input.
3. **Signing script:** retain `scripts/sign-and-notarize-macos.sh`. Its caller in `release.yml` survives the strip, and notarization is the most expensive thing in this repo to re-derive.
4. **Legacy background migration:** delete. Phase 2 renames the state root and requires fresh authentication, so pre-cutover records are unreachable regardless of this code. Slice 4 proceeds as written.

5. **Notification sound:** resolved. Slice 17 deletes only the `/sound` slash command. `sound_level` is a first-class settings entry (`src/core/config/settings_catalog.zig:264`, options `off`/`on`/`max`) reachable through retained `/settings`, so the command is a redundant shortcut. The notification runtime, terminal bells, and the `sound_level` setting are all retained.
6. **Model catalog filtering:** resolved. Change nothing. The model catalog is already provider-neutral and self-pruning, and every rejected-vendor row in it is inert rather than merely unused. Slice 12 does no catalog work.
   - `ModelProviderFilter` (`src/core/app/model_cache_runtime.zig:88`): retain. `modelProviderFilterAvailable` (:258) returns false for every specific filter unless the catalog spans two or more provider families (`specific_count > 1`), and `ProviderTabs.build` (`src/ui/footer/model_menu_presentation.zig:204`) skips unavailable filters. Under a Codex-only catalog the provider tab row does not render at all. Reducing the enum changes nothing a user can see.
   - `featured_picker_families` (`src/core/gateway/model_catalog.zig:414`): retain. Unmatched rows `break` immediately in `projectPickerModelCatalog` (:429-435) and surface nothing. A row can only promote a model the live catalog already serves.
   - `modelProviderRank` (:374): retain. It returns a constant under one vendor, so `sortModelCatalog` falls through to release date and then id, which is the correct single-vendor ordering.
   - `modelTierRank` (:386): retain unmodified. It is a substring matcher over model ids; unmatched entries cost nothing, while removing entries silently mis-ranks those models if a later provider serves them. Do not strip `opus`, `sonnet`, `haiku`, `flash`, or `grok-4` from it.
   - `projectPickerModelCatalog` (:424) is already provider-generic after the featured pass: it enumerates providers from the live catalog alphabetically with per-provider limits, explicitly not inheriting a Gateway ranking.

   Rule applied: delete a lookup table only when a stale row does something observable, whether that is rendering, ranking incorrectly, or misleading a reader. These rows are unreachable data behind a seam that is being retained.
7. **Settings unknown-key behavior:** resolved. Write no compatibility code. Removed keys are simply not read: not preserved, not warned about, not rejected. Fiber is a new product and does not carry fx settings compatibility; Phase 2 renames the state root, which makes any surviving fx settings file unreachable anyway. Rejection is specifically wrong during the WIP window because the owner's live `~/.fx/settings.json` carries `update_channel: "dev"`, pointing at the channel Slice 19 deletes.

   Owner's current `~/.fx/settings.json` contains `provider` (Slice 12), `fast_mode` and `fast_mode_model_bound` (Slice 17), and `update_channel` (Slice 19). It does not contain `codex_model` or `grok_model`; it already uses the `models.codex` shape. No pre-slice cleanup is required.

Resolved by the authoritative design:

- `ask --resume` is removed; only `ask --resume-id` survives.
- ACP launch `--model` and `--log-file` are removed even though the current parser supports them. ACP clients configure the model through ACP.

Reversed by the owner:

- The design held that the updater module must be deleted during WIP because retaining it preserves the forbidden CDN contract. Slice 19 instead strips the CDN base URL, the dev channel, and the startup auto-check, and keeps the updater runtime and relaunch handoff.

## Coverage appendix

Every worker finding is mapped once below. Repeated evidence is assigned to one primary cluster rather than creating duplicate work.

| Worker finding | Final destination | Controller disposition |
| --- | --- | --- |
| A: SDK, artifacts, build options, SDK CI/npm already absent | E01 through E08 | accepted |
| A: dead `is_wasm` branches | Slices 5 through 7 | accepted; primary owner embedding/host |
| A: cooperative agent path | Slice 8 | accepted after caller checks |
| A: stale publish-libfx signing test | Slice 20 | accepted; distribution owns it |
| A: host profile and host vtables | Phase 4 backlog | accepted as later work |
| B P1: feedback, validator, web-search shims, dead env/picker/error remnants | Slice 1 | accepted |
| B P2: credits chain | Slice 2 | accepted |
| B P3: teams/tenant fields | Slice 9 | accepted; merged with deferred usage |
| B P4: Gateway request fixture builder | Phase 5 backlog | reclassified from pending because two real test callers remain |
| B P5: Gateway catalog ranks/tabs | No action | rejected on evidence: ranks, featured families, and provider tabs are inert under a single-vendor catalog and the tab row does not render. See resolution 6 |
| B P6: legacy provider settings | Slice 12 | accepted |
| B P7: active provider residue | Slice 12 plus Phase 4 runtime collapse | split by phase |
| B P8: fake-Gateway E2E suites | Phase 5 backlog | reclassified; most files retain product behavior and only share a rejected fixture |
| B P9: search input remnants | Slice 11 for exact dead URL plumbing; remainder Phase 4 | narrowed to avoid damaging retained search contract |
| B P10: stale rejected-provider docs | Slices 1 and 20 | accepted |
| B P11: CDN updater overlap | Slices 19 and 20 | accepted; distribution/updater own it |
| C A: pr and issue wrappers | Slice 13 | accepted |
| C B: resume aliases | Slice 14 | accepted |
| C C: session migrate | Slice 14 | accepted |
| C D: inherited slash commands | Slices 15 through 17 | accepted and split by command family |
| C E: ask permission flags | Phase 3 backlog | reclassified as atomic replacement work |
| C F: no-color flag | Phase 3 backlog | reclassified as atomic replacement work |
| C G: upgrade | Slice 19 | accepted |
| C H: fast command and setting | Slice 17; session-record fields Phase 3 | split by ownership |
| C I: MCP connect flag | Slice 18 | accepted |
| C J: credits plumbing | Slice 2 | deduplicated into provider owner |
| C K: feedback remnants | Slice 1 | deduplicated into rejected-provider debris |
| C L: login/logout slash commands | Phase 3 backlog | replacement must preserve auth access |
| D: CDN backfill, dev release, prepare release | Slice 20 | accepted |
| D: updater and channels | Slice 19 | accepted |
| D: macOS Intel matrices | Slice 20 | accepted |
| D: stale signing workflow tests | Slice 20 | accepted |
| D: stale release/install docs | Slice 20 | accepted |
| D: release.yml and signing ambiguity | Human decision 1 and 2 | preserved unresolved |
| E A: session migrate | Slice 14 | accepted |
| E B: automatic legacy session import | Slice 3 | accepted |
| E C: legacy background migration | Slice 4 | accepted with human decision 3 |
| E D: resume/recovery aliases | Slice 14 and Phase 3 retry | split by phase |
| E E: inherited slash commands | Slices 15 through 17 | deduplicated into command owner |
| E F: updater/CDN | Slices 19 and 20 | deduplicated into updater/distribution owner |
| E: identity strings and fixture names | Phase 2 backlog | accepted as rename, not demolition |
| F: WASI target conditionals | Slices 5 through 7 | deduplicated into embedding owner |
| F: cooperative mode | Slice 8 | accepted |
| F: credits | Slice 2 | deduplicated |
| F: chat URL override chain | Slice 11 | accepted |
| F: SecretStore seam | Slice 10 | accepted |
| F: deferred usage/team machinery | Slice 9 | accepted |
| F: orphan auth modules, team picker, Grok key | Slices 1 and 12 | accepted |
| F: live one-implementation provider/host seams | Phase 4 backlog | accepted as later work |
| E/F claim that `session migrate` is absent from command specs | Rejected | falsified by `src/builtins/commands.zig` usage/help entries and live parser/dispatch |

## Audit completion statement

Every explicit deletion or removal statement in `docs/ideas/fiber-product-transition.md` has an evidence-backed classification above. Every current pending-deletion cluster belongs to exactly one ordered slice. Replacement contracts, identity renames, retained-behavior test conversion, simplification, final verification, and release design are separated into their later phases rather than being smuggled into demolition.
