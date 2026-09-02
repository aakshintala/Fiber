# Fiber product transition

Status: decided, ready for implementation planning

Priority: start now

Last updated: September 2, 2026

## Decision summary

Cut over from upstream fx to an independent native Fiber product.

Remove embedding products that Fiber will not ship. Rename the retained native runtime and its state, protocols, artifacts, and developer tooling to Fiber. Fiber does not provide fx compatibility aliases or migrate fx configuration, sessions, recordings, credentials, or other state.

Fiber is work in progress with one current user. The cutover keeps the working Codex path. OpenCode Go is planned work after the cutover and is not current behavior.

## Product boundary

Fiber is a native coding-agent runtime with these supported entry points:

| Entry point | Purpose |
| --- | --- |
| interactive CLI and TUI | direct terminal use |
| `fiber acp` | desktop applications, editors, and ACP clients |
| `fiber ask` | one-shot shell and automation use |
| `fiber ask --json` | structured automation and worker use |

The shipped runtime must not depend on Node.js, Bun, npm, JavaScript, a language toolchain, or a package manager. JavaScript development and test tooling may remain when useful.

ACP remains the process integration for editors and desktop applications. MCP remains the boundary for external tools and resources. Skills remain reusable prompt and instruction content.

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
- ACP
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

`fiber session remove` is net-new native work. The current native ACP implementation does not provide a working `session/remove` method. Implement session removal in the native runtime and expose it through the CLI and ACP.

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

`fiber auth status` without a provider reports every provider and supports structured output without secrets. `fiber auth login` and `fiber auth logout` may offer a provider picker only when stdin is a terminal. Without a terminal, an omitted provider fails immediately with a deterministic exit status and lists valid providers.

Keep `fiber permissions` as the read-only snapshot. Add `fiber permissions mode <mode>` and `fiber permissions rule list|add|remove`. Keep `/permissions` as the interactive UI.

Keep `fiber mcp add|remove|list|login|logout|path|trust` and add `fiber mcp doctor`. Rename `mcp auth` to `mcp login`. Move `mcp list --connect` behavior to `fiber mcp doctor` and remove the flag. Keep all `mcp trust` actions, including `reset`.

Keep `/skills` as the interactive skill UI. Defer the top-level `fiber skill` command. A broader extension or plugin contract needs its own design; the current typed hooks runtime is not a user-installable plugin system.

### Workspace, settings, models, and usage

Keep `fiber workspace list|add|remove|clear` and `/workspace`. Workspace commands own persisted directory configuration. The `--add-dir` and `--no-additional-dirs` launch flags set scope for one invocation and remain separate.

Do not add `fiber config`. Persisted settings remain in `settings.json`. Keep `/settings`, `fiber status`, and `fiber doctor` for interactive configuration, effective values, and actionable checks.

Make fast a model identifier property. Keep the model picker and use `fiber ask --model <id>:fast` for a fast-capable model. Remove the persisted `fast_mode` setting and do not add `--fast`.

Add `/context` to show current context usage and occupants. Include context usage in `fiber ask --json` and `fiber session show`. Do not add a top-level `fiber context` command.

Keep `/usage` as the interactive dashboard. Retain `fiber usage --period <24h|7d|30d>` for profile windows. Add `fiber usage --session <id>` for one saved session. Do not rename `--period` to `--scope`.

Keep `fiber models` and `/model`. Model selection uses `fiber ask --model <namespaced-id>`, explicit subagent overrides, and ACP session configuration.

Image attachment is composer behavior. Pasted or dropped paths attach automatically. Native clipboard images attach when available. Automation uses repeatable `fiber ask --image <path>`.

Keep `fiber ask --quiet` and `--no-save`. Remove `--continue-recovery` in favor of `--retry`.

Do not add a top-level `fiber background` command. Keep `/background` for interactive background-process inspection and termination.

### Target command surfaces

The top-level surface is:

- default interactive TUI, `help`, and version output
- `ask` and `acp`
- `auth`, `permissions`, `models`, and `mcp`
- `session` and `sessions`, plus `resume` and `continue`
- `status`, `doctor`, `usage`, and `workspace`
- hidden `fiber debug trace|replay`
- `upgrade` only after Fiber has a GitHub Releases update path

The interactive surface is:

- `/help`, `/quit`, `/exit`, and `/status`
- `/new` and `/clear`, `/resume`, `/rename`, `/retry`, and `/compact`
- `/auth`, `/model`, `/context`, and `/usage`
- `/permissions`, `/mcp`, `/skills`, `/settings`, `/workspace`, and `/background`

Use `/new` as the canonical fresh-conversation command. Keep `/clear` as its alias. Keep `/compact` as a manual context-projection control. It must not destroy canonical session history.

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

Remove `--no-color`. Honor the established `NO_COLOR` environment variable instead.

Support `--json` on every retained operational command.

Rename internal re-exec flags from `--fx-internal-terminal-*` to Fiber names without compatibility aliases. Review the generated shell bootstrap string by hand because it embeds the terminal-control flag.

Remove `upgrade --channel`. Disable automatic update checks and `fiber upgrade` during work in progress.

## Keep ACP compatible and align its controls

Keep standard ACP methods behaving as ACP specifies. Extend ACP with Fiber-specific methods rather than replacing standard methods. The current editor ACP path must keep working.

Remove `provider` and `mode` from ACP `session/set_config_option`. Retain `model` and add `effort`. Use `session/set_mode` as the only permission-mode setter.

Ship modes named `ask`, `auto`, and `yolo`. Replace the current `code` name with `auto` and make yolo reachable. Keep the tested `ToolPolicy` field as a dormant seam for a future read-only mode. Ship no read-only mode now.

Expose context usage in `session/prompt` results and through a dedicated on-demand method.

Remove stale `fiber acp --model` and `--log-file` help. The native parser does not support these launch flags. ACP clients select a model through `session/set_config_option`.

Fiber is an agent surface, not an orchestrator. Fleet views, cross-agent inboxes, cost aggregation, host management, and worktree supervision belong to the client driving one or more `fiber acp` processes.

## Establish the Fiber identity

Rename all retained product identity, including executable names, CLI help, product text, configuration, state, ACP metadata, documentation, package and artifact names, internal identifiers, filenames, fixtures, tests, and developer tooling.

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
- ACP agent metadata, UI labels, tags, and shared HTTP User-Agent values

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
2. Implement the chosen command, flag, ACP, state, and identity contracts.
3. Simplify native branches that no longer have multiple implementations.
4. Build and exercise ACP, TUI, `ask`, JSON automation, and Codex as Fiber.
5. Rewrite process documentation after the cutover.
6. Build local fast and exhaustive gates before preparing Fiber `0.0.1`.

## Success criteria

The transition succeeds when:

- the repository builds a native Fiber binary
- removed SDK and embedding products leave no dead build or continuous-integration paths
- the retained product uses Fiber names and formats with no fx compatibility reads
- README and NOTICE provide the required upstream attribution
- ACP, TUI, `ask`, JSON automation, and Codex-backed subagents work
- the existing editor still drives Fiber through ACP
- `fiber ask --model <namespaced-id>`, `--effort`, and `--permission-mode` work without global provider state
- session removal, retry, and resume contracts match the chosen command surface
- every retained operational command supports `--json`
- the planned OpenCode Go work remains unobstructed
- macOS Intel is not a Fiber support target

## Deferred follow-up work

These items do not block the cutover:

- a Fiber-owned web-search backend
- a top-level skill command and a broader extension or plugin design
- session branching, rewind, tree navigation, and fork semantics
- GitHub Release publishing, signing, updater support, and local gate entry points before `0.0.1`
- additional OpenCode wire protocols and Databricks provider support
