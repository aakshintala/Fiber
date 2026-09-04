# Fiber product transition

Status: decided, ready for implementation planning

Priority: start now

Last updated: September 4, 2026

## Decision summary

Cut over from upstream fx to an independent native Fiber product.

Remove embedding products that Fiber will not ship. Rename the retained native runtime and its state, protocols, artifacts, and developer tooling to Fiber. Fiber does not provide fx compatibility aliases or migrate fx configuration, sessions, recordings, credentials, or other state.

Fiber is work in progress with one current user. The cutover keeps the working Codex path. OpenCode Go is planned work after the cutover and is not current behavior.

## Product boundary

Fiber is a native coding-agent runtime with these supported entry points:

| Entry point | Purpose |
| --- | --- |
| interactive CLI and TUI | direct terminal use |
| `fiber ask` | one-shot shell and automation use |
| `fiber ask --json` | structured automation and worker use |

The shipped runtime must not depend on Node.js, Bun, npm, JavaScript, a language toolchain, or a package manager. JavaScript development and test tooling may remain when useful.

MCP remains the boundary for external tools and resources. Skills remain reusable prompt and instruction content.

## Remove embedding products

The audited embedding inventory contains:

- 45 files and 6,561 lines under `sdk/`
- 1,495 lines of WebAssembly and JavaScript-host Zig code
- 1,246 lines of Node-API Zig code
- 3 dedicated SDK jobs in continuous integration
- one npm publishing workflow

Remove:

- the JavaScript and npm SDK under `sdk/`
- `fx-core.wasm` and `fx-term.wasm`
- browser terminal and JavaScript host adapters
- the Node-API addon and fetch bridge
- the `-Dwasm-surface` and `-Dnapi-surface` build options
- SDK-specific continuous-integration jobs
- npm publishing for `libfx`
- SDK demos, packaging, tests, and documentation
- WebAssembly target branches with no remaining caller

This removes browser WebAssembly as a product target. It does not rule out a future WebAssembly extension sandbox.

Simplify abstractions that have one implementation after this removal. Do not retain host profiles or target branches only because removed products needed them.

## Keep the native runtime

Retain:

- the CLI and TUI
- `ask` and structured JSON output
- durable sessions and subagents
- cancellation and progress events
- permission enforcement
- model usage reporting
- the Codex provider and subscription authentication path

Fiber is Codex-only at cutover. Remove Vercel AI Gateway, Vercel OAuth, team selection, and related credentials. Remove the Grok provider, Grok OAuth, and related configuration. Remove `/feedback` and its upstream endpoint. Defer OpenCode Go.

Keep web search separate from model-provider transport. The retained capability has layered adapters:

- use provider-native search only when the selected provider, model, and route support it
- use a configured Fiber-owned backend when one exists
- use an explicitly selected MCP search tool as an alternative, not a silent fallback
- omit search when no adapter is available

No Vercel search adapter exists to remove. Retain and verify the provider-neutral contracts, MCP search plumbing, and provider-native gating. Do not select or implement a replacement backend during the cutover. Verify Codex-native search separately.

Remove the Vercel-specific host stream provider, including its upstream Referer, title, Vercel protocol, and team headers. Keep the shared native HTTP client for Codex and rename its Fiber identity values.

## Simplify the command surface

Design operational commands for automation: stable structured output, explicit identifiers, deterministic exit status, bounded output, and no surprise prompts. Keep a small convenience layer for direct terminal use.

Remove these upstream-service commands:

- `setup`
- `teams`
- `credits` and its `balance` alias
- `/credits` and `/balance`
- `/feedback`

Remove the global `provider` command and active-provider setting. Model selection, not a profile-wide provider setting, determines each main agent or subagent route.

Remove the top-level `pr` and `issue` wrappers. Pull-request and issue workflows belong in ordinary requests or future skills.

Remove these inherited commands and aliases:

- `/alias`
- `/reset`
- `/stats` and `/cost`
- `/fast`
- `/image`, `/images`, `/img`, and `/paste`
- `/undo` and `/copy`
- `/statusline` and `/sound`
- `/trace`
- `/allowlist`
- `/version`
- `session migrate`

Keep `/exit` as an alias for `/quit`.

### Sessions and recovery

Consolidate saved-session operations under `fiber session list|show|resume|recover|rename|remove`.

`fiber session remove` exposes existing native work. `session_store.deleteCommittedSession` already implements durable removal; the CLI has no path to it. Wire the command to that function.

Keep:

- `fiber sessions` as shorthand for `fiber session list`
- `fiber resume` as the interactive picker
- `fiber continue` to resume the most recent saved session without a picker
- `fiber session resume <id>` as the automation form
- `fiber ask --resume-id <id>` where a one-shot request resumes a specific session
- session-list pagination through `--limit` and `--continuation`

Remove the remaining resume aliases and flags, including `-r`, `--resume`, `--resume-last`, `--continue`, `-c`, and `--resume-<id>`. The parser currently accepts only a subset of the spellings inherited help advertises; remove both the accepted forms and stale help.

Rename recovery continuation to `/retry` and `fiber ask --retry`. It replays an interrupted user turn from its checkpoint. Keep `fiber session recover` separate because it works on saved session state.

Defer branching, rewind, tree navigation, and fork semantics to a session-history design.

### Authentication, permissions, MCP, and skills

Replace top-level `login` and `logout` with `fiber auth list|status|login|logout`.

`fiber auth list` reports every provider Fiber supports and whether the profile is signed in to each. `fiber auth status` reports the active credential: which provider, whether it is expired, and whether it can refresh. Neither emits a secret. They answer different questions and both remain useful with one provider configured.

`fiber auth login` and `fiber auth logout` may offer a provider picker only when stdin is a terminal. When exactly one provider exists, login proceeds directly rather than picking. Without a terminal, an omitted provider fails immediately with a deterministic exit status and lists valid providers.

Shape every auth surface for several providers and implement it against the one that exists. `ProviderId` is a retained seam with a single variant today; arrays, required or picked provider arguments, and per-provider state cost nothing now and avoid a contract break when a second provider lands. `fiber status` already emits `connected_providers` as an array and is the precedent.

Keep `fiber permissions` as the read-only snapshot. Add `fiber permissions mode <mode>` and `fiber permissions rule list|add|remove`. Keep `/permissions` as the interactive UI.

Keep `fiber mcp add|remove|list|login|logout|path|trust`. Rename `mcp auth` to `mcp login`. Keep all `mcp trust` actions, including `reset`. `mcp list --connect` is already removed from `src/`; stale callers remain in the end-to-end suite. `fiber mcp doctor` is net-new diagnostic capability and moves to [`../enhancements/pending.md`](../enhancements/pending.md).

Keep `/skills` as the interactive skill UI. Defer the top-level `fiber skill` command. A broader extension or plugin contract needs its own design; the current typed hooks runtime is not a user-installable plugin system.

### Workspace, settings, models, and usage

Keep `fiber workspace list|add|remove|clear` and `/workspace`. Workspace commands own persisted directory configuration. The `--add-dir` and `--no-additional-dirs` launch flags set scope for one invocation and remain separate.

Do not add `fiber config`. Persisted settings remain in `settings.json`. Keep `/settings`, `fiber status`, and `fiber doctor` for interactive configuration, effective values, and actionable checks.

Fast is a per-request service tier, not a model identifier property. `fast_mode` combined with the catalog's per-model `supports_fast_mode` resolves to `provider_options.fast`, which Codex sends as `service_tier: priority` and other routes send as `gateway.speed = fast`. The model id does not change. A `-fast` id suffix is a different thing entirely: it names a distinct model and only lights the footer indicator.

Choose fast with the model, not as a standing mode. Keep the model picker's fast stage and `/model <id> <effort> normal|fast`, which persist the choice to the session record. Remove the "Fast mode" row from the `/settings` menu — the row, not the command: switching tiers moves a request off its cached prompt prefix provider-side, so it should cost a deliberate trip through the model picker rather than one keystroke. `/fast` is already removed.

Add `fiber ask --fast` for the non-interactive path, which otherwise cannot reach the tier at all. The persisted `fast_mode` *setting* is already gone from `settings.json`; the session-record preference and the recovery checkpoint's `requested_fast_mode`/`fast_mode` pair stay, because the checkpoint records what a turn requested against what it actually routed after a provider-outage fallback.

Add `/context` to show current context usage: tokens used, the model's window, and the percentage. Do not add a top-level `fiber context` command. Showing *occupants* — the per-component breakdown of what fills the window — needs token accounting that does not exist anywhere in the tree, as does surfacing context usage in `fiber ask --json` and `fiber session show`. Both move to [`../enhancements/pending.md`](../enhancements/pending.md).

Keep `/usage` as the interactive dashboard. Retain `fiber usage --period <24h|7d|30d>` for profile windows. Do not rename `--period` to `--scope`. `fiber usage --session <id>` is a net-new query dimension and moves to [`../enhancements/pending.md`](../enhancements/pending.md).

Keep `fiber models` and `/model`. Model selection uses `fiber ask --model <namespaced-id>` and explicit subagent overrides.

Image attachment is composer behavior. Pasted or dropped paths attach automatically. Native clipboard images attach when available. Automation uses repeatable `fiber ask --image <path>`.

Keep `fiber ask --quiet` and `--no-save`. Remove `--continue-recovery` in favor of `--retry`.

Do not add a top-level `fiber background` command. Keep `/background` for interactive background-process inspection and termination.

### Target command surfaces

The top-level surface is:

- default interactive TUI, `help`, and version output
- `ask`
- `auth`, `permissions`, `models`, and `mcp`
- `session` and `sessions`, plus `resume` and `continue`
- `status`, `doctor`, `usage`, and `workspace`
- hidden `fiber debug trace|replay`
- `upgrade` only after Fiber has a GitHub Releases update path

The interactive surface is:

- `/help`, `/quit`, `/exit`, and `/status`
- `/new` and `/clear`, `/resume`, `/rename`, `/retry`, and `/compact`
- `/login` and `/logout`, `/model`, `/context`, and `/usage`
- `/permissions`, `/mcp`, `/skills`, `/settings`, `/workspace`, and `/background`

Use `/new` as the canonical fresh-conversation command. Keep `/clear` as its alias, in the catalog's existing alias mechanism rather than as a second kind, the way `/exit` aliases `/quit`. Do not consolidate `/login` and `/logout` under a `/auth` parent: the slash catalog is a flat list of verbs and has never mirrored the CLI, and grouping costs a keystroke on the action most often repeated. Keep `/compact` as a manual context-projection control. It must not destroy canonical session history.

Retain a command only when it expresses a supported Fiber capability, a necessary diagnostic or recovery path, a deliberate development interface, or a small human convenience.

## Simplify flags and output

Keep these global launch flags, applied before any command:

- `--context-limit`
- `--add-dir`
- `--no-additional-dirs`

Replace `fiber ask --auto`, `--yolo`, and `--prompt-permissions` with `fiber ask --permission-mode <ask|auto|yolo>`. An unrecognized mode must fail with a deterministic exit status.

Add these per-invocation controls:

- `fiber ask --model <namespaced-id>`
- `fiber ask --effort <level>`
- `fiber ask --fast`

Remove `--no-color`. Honor the established `NO_COLOR` environment variable instead.

Support `--json` on every retained operational command. A command is **operational when a script can drive it to completion without a human**. That test, not interactivity during execution, decides the flag: `ask` streams and prompts for permissions but ends with a result a script consumes, so it qualifies; `auth login` waits on a browser, so it does not.

These commands reject `--json` as a usage error, the way `fiber login codex --json` already does: the default TUI, `resume`, `continue`, `session resume`, `auth login`, `mcp login`, and `help`. Everything else retained carries it, including mutating subcommands such as `permissions rule add`, `session remove`, and `workspace add`, which earn it for the error `code` rather than for a success payload. `fiber -v` prints a bare version string and needs no envelope.

Rename internal re-exec flags from `--fx-internal-terminal-*` to Fiber names without compatibility aliases. Review the generated shell bootstrap string by hand because it embeds the terminal-control flag.

Remove `upgrade --channel`. Disable automatic update checks and `fiber upgrade` during work in progress.

## Remove ACP

Delete the ACP surface. `fiber acp`, `src/acp/` (10,734 lines), `src/core/cli/acp_runner.zig`, and the dedicated end-to-end suite (8,416 lines) go, along with the ACP-shaped arms carried in core: `Wire.acp` and `Scope.acp_session` in MCP elicitation, `ConfigSource.acp`, `connectAllForAcp`, `startup_admission.acp_startup`, `ScopeKind.acp`, `TransportRole.acp`, and `EntryPoint.acp`.

Nobody drives Fiber through an ACP client. The cost is not the surface itself but that `src/acp/prompt.zig` is a second full agent host, 4,659 lines running on the same session store, permissions, and provider set as the CLI, so every session and permission change is built and proved twice. Deleting it before the contract work means the command, flag, and permission contracts are implemented once.

ACP is a leaf on imports — `src/core/` never imports it — so removal is bounded. Two things move rather than go: `session_test_controls.zig` is generic despite living under `src/acp/` and belongs in `src/core/session/`, and `jsonrpc.writeJsonStr` has a non-ACP caller in `src/builtins/hooks/herdr.zig`.

Fiber is an agent surface, not an orchestrator. Fleet views, cross-agent inboxes, cost aggregation, host management, and worktree supervision belong to a client, and Fiber no longer ships a protocol for one to attach to.

## Establish the Fiber identity

Rename all retained product identity, including executable names, CLI help, product text, configuration, state, documentation, package and artifact names, internal identifiers, filenames, fixtures, tests, and developer tooling.

Use these namespaces with no compatibility reader or alias:

- `fiber` executable
- `FIBER_*` environment variables, including test variables
- `~/.fiber/` profile and runtime state
- `.fiber.json` project configuration
- Fiber-named artifacts and extensions

Rename all retained `FX_*` variables. Remove variables that exist only for deleted Vercel or Grok features.

Rename all retained `~/.fx/` paths to `~/.fiber/`, including settings, sessions, recordings, credentials, logs, and test fixtures. Do not read, import, migrate, or fall back to fx state.

Rename these internal formats and identifiers:

- the terminal tape signature and subagent relationship-index signatures to Fiber-branded values
- `fx.shared_model_context.v1` and `fx_vision_evidence` contract names, with their evaluation expectations
- the generated terminal-control flag
- fx-branded fixture filenames
- UI labels, tags, and shared HTTP User-Agent values

Remove the Vercel AI Gateway Keychain service. Rename retained Codex-session and MCP OAuth Keychain services to Fiber names. Require fresh Fiber authentication and do not migrate credentials.

Rename the shared HTTP client and any retained native transport naming to Fiber. Do not rename the removed Vercel host-stream provider; delete it.

Keep Fiber under Apache-2.0. Preserve upstream copyright and required notice text. Add a `NOTICE` file and a concise README attribution that Fiber is forked from Vercel's fx. Outside attribution and unavoidable historical records, remove product-level fx references.

Start an independent Fiber release line at `0.0.1`. Start `CHANGELOG.md` with Fiber releases rather than upstream release notes. The cutover prepares the source tree but does not publish `0.0.1`.

## Release, distribution, and verification

Delete these inherited workflows and their documentation:

- `cdn-backfill.yml`
- `dev-release.yml`
- `publish-libfx.yml`
- `prepare-release.yml`

Remove the Vercel CDN contract and development update channel. Do not provide an installer or custom install domain during work in progress. Before the first release, design direct GitHub Release artifact distribution, signing, and update behavior.

Drop macOS x86_64 from Fiber support. Keep macOS arm64, Linux x86_64, and Linux arm64 as future release targets.

Retain `ci.yml`, `bench.yml`, `binary-size.yml`, and `pgso-macos-arm64.yml` temporarily. Remove macOS Intel work from retained workflows. Keep the macOS arm64 PGSO workflow and corpus until a local replacement proves equivalent qualification.

The local fast and exhaustive gate entry points, including local macOS arm64 PGSO qualification, are prerequisite follow-up work. They block preparation and publication of the first Fiber release, not the cutover. The local exhaustive gate must cover macOS arm64 runtime behavior, Linux x86_64 and Linux arm64 ReleaseSafe cross-builds, binary size, and performance qualification.

Rewrite `AGENTS.md`, `CONTRIBUTING.md`, and related process documents after the cutover. Record the temporary mismatch while the inherited process guidance still describes the old workflow and platform matrix.

## Delivery sequence

1. Remove embedding products and rejected provider paths while renaming the retained native product to Fiber.
2. Implement the chosen command, flag, state, and identity contracts.
3. Simplify native branches that no longer have multiple implementations.
4. Build and exercise the TUI, `ask`, JSON automation, and Codex as Fiber.
5. Rewrite process documentation after the cutover.
6. Build local fast and exhaustive gates before preparing Fiber `0.0.1`.

## Success criteria

The transition succeeds when:

- the repository builds a native Fiber binary
- removed SDK and embedding products leave no dead build or continuous-integration paths
- the retained product uses Fiber names and formats with no fx compatibility reads
- README and NOTICE provide the required upstream attribution
- the TUI, `ask`, JSON automation, and Codex-backed subagents work
- no ACP surface, entry point, or core arm remains
- `fiber ask --model <namespaced-id>`, `--effort`, and `--permission-mode` work without global provider state
- session removal, retry, and resume contracts match the chosen command surface
- every retained operational command supports `--json`
- the planned OpenCode Go work remains unobstructed
- macOS Intel is not a Fiber support target

## Deferred follow-up work

The transition ends at Phase 6. It is step one, not the release: Fiber is stamped `0.0.1` only after the enhancement work in [`../enhancements/pending.md`](../enhancements/pending.md) brings the product to where it should be. That file owns everything deferred out of the transition for being net-new capability rather than reshaping.

These items do not block the cutover:

- a Fiber-owned web-search backend
- a top-level skill command and a broader extension or plugin design
- session branching, rewind, tree navigation, and fork semantics
- GitHub Release publishing, signing, updater support, and local gate entry points before `0.0.1`
- additional OpenCode wire protocols and Databricks provider support
