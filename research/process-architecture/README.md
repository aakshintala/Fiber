# Process architecture: how four coding agents do it

This note answers the research question behind
[#81](https://github.com/aakshintala/fiber/issues/81): how pi, codex, opencode
and Claude Code split into processes. It covers, for each tool: whether the
terminal UI is a separate process from the agent loop and what protocol
connects them; whether a host-wide daemon exists; how a remote client reaches
a session; which process owns MCP servers and how they are shared; whether
sub-agents run as threads or processes; and which process runs an
extension's UI code.

Findings came from four background research passes, one per tool, each
working from primary sources: installed binaries, `--help` output, `strings`
on binaries with no public source, shipped documentation, and source clones.
Two things already in this repo were read first and reused rather than
re-derived: `research/mcp-client/README.md` (MCP protocol and lifecycle
details for pi, codex and Claude Code) and `research/pi-rewrite/README.md`
(pi's unbuilt rewrite, its facets and Chord runtime). This note does not
repeat their MCP wire-protocol findings; it covers process topology only.

Every claim below carries its source: a file path and line, a command and
its output, or a URL. Where a pass could not confirm something, it says so
and what it tried.

## pi

Sources: the installed package at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` (shipped
v0.87.x) for what users run today; a clone of the same repository the
existing research notes cite as `earendil-works/pi` (cloned here from
`badlogic/pi-mono`, commit `b455975`, 2026-09-23) for the unbuilt rewrite;
the `pi-mcp-adapter@2.37.0` unpacked source for MCP. Two generations of
design exist side by side: shipped code, and an experimental rewrite gated
behind `PI_EXPERIMENTAL=1`. Both are reported below, kept apart.

1. Process layout. Shipped pi is one process, always: the terminal UI is the
   agent-loop process. `docs/cli-integration.md` in the installed package
   says "All four modes [Interactive, Print, JSON, RPC] use the same agent,
   sessions, resources, and tools." RPC mode (`pi --mode rpc --no-session`)
   is a long-lived child process a host spawns and talks to over stdio,
   strict JSONL, one record per line (`docs/rpc.md`: "RPC mode runs Pi as a
   long-lived subprocess controlled through JSON records on stdin and
   stdout"). It is per-invocation, not host-wide. The unbuilt rewrite
   specifies a different shape: one server process, one session worker
   process per session, and any number of presentation processes (TUI now,
   web later). `packages/agent/docs/plugins.md:13-31`: "A session worker
   normally owns one session... A server facet is instantiated once per
   server process and is shared across every session and presentation
   connected to it... There is no direct presentation to session-worker
   connection; the server routes." The transport is Chord's own multiplexed
   connection per client, not named as HTTP or websocket in any doc found;
   the earlier pi-rewrite research describes it as length-prefixed CBOR.

2. Daemon. Shipped pi has none: every mode's process lifetime is tied to its
   invocation. The rewrite's server is long-lived and shared by design, but
   no document found says who starts or stops it, how a stale socket is
   handled, or what happens on a pi-binary upgrade while sessions are live —
   not confirmed, searched `daemon`, `socket`, `pidfile`, `lockfile`,
   `launchd`, `systemd` and `stale socket` across `packages/agent/docs` and
   `packages/chord` with no relevant hits beyond the routing description
   above. `plugins.md:604-692` shows the server authorising a client against
   a `ClientIdentity` per session, but the concrete authentication mechanism
   (token, socket permission, TLS) is not documented — not confirmed.

3. Remote clients. `mobile-handoff/` is not a mobile client feature. Its own
   title is "pi — design handoff" (`packages/agent/docs/mobile-handoff/
   README.md:1`), and every "mobile" occurrence found is the phrase "mobile
   assistant-output handoff", naming a portable spec package handed between
   engineers, not a phone app. A repo-wide search for `mobile`, `android`,
   `ios app`, `react native` and `phone client` found only Termux (an
   Android terminal emulator) CLI docs and this handoff-naming pattern. The
   rewrite's presentation model allows a non-TUI client in principle
   (`plugins.md:16`: "A presentation host (TUI today, web later)"), but that
   is the entire textual basis for it, and it is spec-only and unbuilt. Not
   confirmed: no mobile client exists to trace.

4. MCP servers. `pi-mcp-adapter` is a pi extension loaded in-process — its
   `package.json` declares `"pi": {"extensions": ["./index.ts"]}`, matching
   the earlier finding that extensions run inside the agent process. One
   `McpServerManager` instance exists per extension activation, keyed by the
   working directory (`init.ts:148`), holding its own connection map
   (`server-manager.ts:265`). Since shipped pi is one process per
   invocation, MCP servers are one set per process (equivalently, per
   session); they are not shared across separate pi invocations.

5. Sub-agents. Shipped pi has no sub-agent concept: a search for `subagent`
   across `packages/coding-agent/src`, `packages/agent/src/agent.ts` and the
   installed docs found nothing. The unimplemented Pico5 spec
   (`packages/durable/docs/pico-v5.md`) defines a "task" as "a durable state
   machine attached to one conversation" (line 44), run as an in-process
   async operation — an `AbortController` plus a completion promise
   (§5.4, around line 1273) — not a thread or a process. Ownership is
   separate from history: "`parent` controls inherited entries and
   historical documents. `owner` controls task authorization, subtree abort,
   and subtree idle waits" (lines 204-207). Separately, the spec-only
   `facets.md:343` mentions a `spawn_subagent` tool that "needs the server's
   session management", implying a heavier mechanism that goes through the
   rewrite's server. pi's own docs do not reconcile this with Pico5's
   in-process task, and neither does this note.

6. Extensions with UI. Shipped pi extensions are one in-process module with
   full rights to draw in the TUI, already established in
   `research/pi-rewrite/README.md`. The newer, spec-only `facets.md` (its
   own header says it supersedes `plugins.md`) changes how the code gets to
   the presentation process without changing which process runs it: "A
   presentation ships with no plugin facets... All plugin facets arrive over
   the wire as built bundles" (around line 383), and the code still executes
   in the presentation process — flagged as a trust boundary at lines
   415-416: "attachment-generation bundles are third-party code arriving
   from a project directory and executing in the user's presentation
   process." The older, partly-built `plugins.md:46-48` states the general
   rule: "A server, Session worker, TUI, and future web host execute
   different bundles in different processes... Each process loads only
   facets built for that process."

## codex

Sources: the installed binary `~/.codex/packages/standalone/current/bin/
codex` (`codex-cli 0.155.1`), its `--help` and subcommand `--help` output,
and a sparse clone of `openai/codex` at `codex-rs` (crates `cli`, `tui`,
`app-server`, `app-server-daemon`, `app-server-transport`,
`app-server-protocol`, `codex-mcp`, `rmcp-client`, `core`, `agent-graph-
store`, `agent-roles`, `plugin`, `cloud-tasks-client`, `features`).

1. Process layout. The TUI is not hard-wired to run the agent loop in its
   own process. It is always a client of an internal `AppServerClient`
   abstraction with three variants: `Embedded` (in-process), `LocalDaemon`
   (unix socket to a locally shared daemon), and `Remote` (websocket)
   (`tui/src/lib.rs:310-319`). By default the TUI tries to attach to a
   shared local app-server daemon over a unix socket, falling back to an
   embedded, same-process app-server only if the daemon is excluded or
   unavailable (`tui/src/lib.rs:540-600`, `tui/src/daemon_startup.rs:24-
   51`). This default is the stable, enabled-by-default feature
   `daemon_auto_start` (`features/src/lib.rs:931-935`). Flags such as
   `--no-daemon`, `--oss` and `--profile` force embedded-only mode
   (`tui/src/daemon_startup.rs:24-88`). `codex app-server` is a distinct,
   experimental subcommand with its own `daemon`, `proxy`, `generate-ts`
   and `generate-json-schema` subcommands; its listen transport defaults to
   `stdio://` and also accepts `unix://`, a unix socket path, or
   `ws://IP:PORT`. It speaks a first-party JSON-RPC-shaped "app-server
   protocol", not MCP, and is named in its own help text as used by "first-
   party use cases like the VSCode IDE extension." `codex mcp` only manages
   external MCP servers codex connects to as a client; no MCP server mode
   for codex itself was found. `codex exec` runs the agent loop non-
   interactively as a standalone invocation. Scope: host-wide — `codex
   agents --help` says plainly "Browse all agent sessions on the shared
   local app-server daemon."

2. Daemon. Yes. `codex app-server daemon` is a long-lived, host-wide
   background process that outlives any one terminal, with subcommands
   `bootstrap`, `start`, `restart`, `update`, `enable-remote-control`,
   `disable-remote-control`, `stop` and `version`. It starts implicitly on
   first connection (per the auto-start default above) or explicitly via
   these subcommands. Stale sockets and PIDs are handled with PID-file
   records carrying process-identity verification and an explicit stale-
   record refresh path (`app-server-daemon/src/backend/pid.rs:139,168,221,
   317`). Live upgrade is explicit and disruptive by the tool's own
   description: `codex app-server daemon update` is documented as "Update
   the standalone installation and restart the managed daemon (may
   interrupt work)"; a connecting client also checks feature compatibility
   with the already-running daemon before attaching and can surface a
   required-restart error rather than silently using a mismatched daemon
   (`tui/src/daemon_startup.rs:118-186`). Authentication: for a non-
   loopback listener, `codex app-server` requires either a capability
   token or a signed bearer token (JWT-style, with a shared secret, issuer,
   audience and clock-skew tolerance); for loopback or unix-socket
   connections, `--remote-auth-token-env` supplies a bearer token. Strings
   in the binary confirm an explicit local-versus-remote bind distinction
   ("direct WebSocket connections require a loopback destination").

3. Remote clients. `codex cloud` is a wholly separate, OpenAI-hosted
   execution environment, not a client reaching a locally running session.
   Its client crate is a plain HTTP client against OpenAI's backend
   (`cloud-tasks-client/src/http.rs:296,579-581`, hitting `/api/codex/
   tasks/{id}` or, for the ChatGPT backend, `/wham/tasks/{id}`). `codex
   cloud`'s subcommands are `exec` (submit a task), `status`, `list`,
   `apply` ("Apply the diff for a Codex Cloud task locally") and `diff` —
   the task runs remotely, and the only local action is pulling the
   resulting diff and applying it with git. No evidence was found of any
   web or cloud client reaching into a local codex process; the daemon's
   remote-control feature (§2) only ever accepts a client dialing in, never
   OpenAI's cloud dialing out to a user's machine.

4. MCP servers. MCP server child processes are spawned directly by
   `LocalStdioServerLauncher::launch_server`, using `tokio::process::Command`
   in their own process group, with an explicit file-descriptor allowlist on
   Unix (`rmcp-client/src/stdio_server_launcher.rs:266-282`). This runs
   inside whichever process is currently running codex's core for that
   thread — the shared daemon if attached, or the embedded app-server
   inside the TUI or `exec` process otherwise. No separate MCP broker
   process exists. Scoping is per thread/session, not host-wide:
   `core/src/session/session.rs:1561-1563` says "Hooks and extensions share
   one stable thread-owned MCP runtime handle." One narrow exception: a
   built-in "Codex Apps" connector's tool catalogue can be cached and
   shared within a process if it is not using an environment bearer token
   (`codex-mcp/src/connection_manager/startup.rs:34-39`); ordinary
   configured MCP servers are not shared.

5. Sub-agents. Codex has a first-class, built-in multi-agent concept, gated
   by the `multi_agent_mode` feature, implemented in `core/src/agent/
   control/spawn.rs` with supporting crates `agent-graph-store` (parent and
   child topology for spawned agents) and `agent-roles`. A spawn creates a
   new sub-agent session under a capacity-limited slot reservation
   (`agent_max_threads` in config, `spawn.rs:638,655`). It runs as a
   `tokio::spawn` async task inside the same OS process, not a child
   process (`spawn.rs:775`); a search of the source tree for any self-
   invocation of the codex binary in the spawn path found none. Because a
   sub-agent is a task in the parent's own process, it dies when the parent
   process dies — there is no separate process lifecycle to manage or
   signal. Stopping a sub-agent is cooperative in-process cancellation
   through an interrupt operation, not an OS signal (`core/src/agent/
   control/interrupt.rs:16-40`); the root agent cannot be interrupted and
   an agent cannot interrupt itself.

6. Extensions with UI. Codex's plugin system (`codex plugin add/list/
   marketplace/remove`) does not let a plugin draw custom UI into the TUI.
   Its manifest schema allows only skills, MCP servers, hooks, an apps
   resource, and static marketplace metadata (display name, description,
   category, free-text capability tags, logos, screenshots)
   (`plugin/src/manifest.rs:1-81,41`); no field lets a plugin register a
   view, widget or renderer, and a search of the plugin crate for `ui`,
   `render`, `widget` and `draw` found only that one metadata comment. The
   TUI itself has a fixed, built-in plugins browser that lists installed
   and available plugins from this static metadata; the plugin supplies
   data for that fixed panel, not its own rendering.

## opencode v2

Sources: `git ls-remote` against `anomalyco/opencode` found no `v2` ref; the
actively developed branch is `2.0` (package version 1.4.3 at clone time),
cloned as `git clone --depth 1 --branch 2.0 https://github.com/anomalyco/
opencode`. It is a Bun/TypeScript monorepo (`packages/opencode`, `packages/
app`, `packages/desktop`, `packages/desktop-electron`, `packages/web`,
`packages/plugin`, `packages/sdk`). There is no separate Go TUI in this
branch; the TUI is TypeScript/SolidJS via `@opentui/solid`.

1. Process layout. Running plain `opencode` with no subcommand runs the
   default command defined in `packages/opencode/src/cli/cmd/tui/thread.ts:
   68-70,125-138`, which spawns a Bun `Worker` thread — not a separate OS
   process — running `worker.ts`, hosting the actual Hono server app
   (`Server.Default().app.fetch`). The main thread runs the TUI and talks
   to the worker over an in-process RPC channel (`Rpc.client`,
   `thread.ts:149`). Two modes exist depending on whether network flags
   (`--port`, `--hostname`, `--mdns`) were passed (`thread.ts:186-204`):
   with none, the TUI calls the server purely in-process through a fetch
   shim and an in-process event source, with no real TCP listener opened;
   with any given, the worker binds an actual port and the TUI talks HTTP
   to it. So by default `opencode` is one OS process with two threads; a
   genuine socket-connected client/server split happens only when
   networking is explicitly requested, or via the separate `opencode
   serve`/`opencode attach <url>` invocations. `opencode serve`
   (`serve.ts:9-24`) and `opencode web` (`web.ts:31-70`) both call
   `Server.listen` and block forever — a standalone server process serving
   plain HTTP, with routes for control-plane, instance, and UI concerns.
   The server itself is host-wide (one Hono app, one port), but
   application state is scoped per project directory through a directory-
   keyed cache of contexts (`packages/opencode/src/project/instance.ts:
   18,57-71`), so one server process can serve several projects at once,
   each with its own cached context; it is not one server per directory or
   per session. The default port is `0`, letting the OS assign an ephemeral
   port, unless overridden.

2. Daemon. No code was found that daemonises, detaches, or forks the
   server to the background, and no pidfile or lockfile specific to the
   server process was found (a generic `Flock` advisory-lock utility
   exists but is used elsewhere). `serve` and `web` run in the foreground
   and block; for several terminals to share one server, a user has to run
   `serve` or `web` themselves and point other clients at it with `opencode
   attach <url>` — not confirmed whether opencode ever auto-shares a
   server between independent terminal sessions. The default ephemeral
   port means each invocation gets a fresh port; no stale-socket recovery
   code was found, plausibly because there is no fixed port to go stale —
   not confirmed. Upgrade: `upgrade()` (`src/cli/upgrade.ts:7-30`) checks
   for a newer version and, for patch-level bumps on a known install
   method, downloads and installs it, then fires an event so the TUI can
   notify the user; it does not restart a running server or swap the in-
   memory binary, so a new version only takes effect on the next launch.
   Not confirmed: behaviour when upgrading while several remote clients
   are attached to a long-running `serve`. Authentication is HTTP Basic
   Auth, gated by the `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`
   environment variables, enforced only if a password is set
   (`src/server/middleware.ts:39-50`); otherwise the server is completely
   open, and `serve`/`web` print an explicit warning when unsecured.
   `attach` sends the password as a Basic auth header. CORS is restricted
   to localhost, 127.0.0.1, Tauri and `*.opencode.ai` origins, plus an
   explicit allowlist flag.

3. Remote clients. `packages/web` is the marketing and documentation site;
   it does not talk to a running server. The actual GUI client is
   `packages/app`, a shared SolidJS app consumed by `packages/desktop` (a
   Tauri app) and by the UI `opencode web` serves. It builds an SDK client
   against the running server's own HTTP URL — the same Hono server from
   questions 1 and 2, not a separate cloud relay; no cloud-relay code was
   found for either the desktop or the web UI. `packages/desktop-electron`
   exists as a second desktop shell and was not further inspected — not
   confirmed whether it differs.

4. MCP servers. The MCP client lives in `src/mcp/index.ts`. The server
   process itself starts MCP servers: local ones are spawned as child OS
   processes through `StdioClientTransport`
   (`src/mcp/index.ts:384-393`), remote ones connect over streamable HTTP
   or SSE. Route handlers under the instance routes expose MCP status,
   add, connect, disconnect and OAuth endpoints, confirming the
   connections are server-owned, not TUI-owned. Scope: MCP connection
   state is created through `InstanceState`, explicitly keyed to the
   current directory-scoped instance context (`src/effect/instance-
   state.ts:16-40`) — MCP servers are scoped per project directory and
   cached in that directory's instance, so clients or sessions working
   against the same directory on the same server share the same MCP
   connections, while a different directory gets its own set.

5. Sub-agents. The `task` tool (`src/tool/task.ts`) is opencode's sub-
   agent mechanism. It creates a new session record
   (`sessions.create({parentID: ctx.sessionID, ...})`, lines 70-98) and
   runs the sub-agent's turn in-process, as an async computation inside
   the same server process — there is no `child_process` or `Worker`
   spawn in this file. Cancellation is cooperative: the tool registers an
   abort listener on the parent's abort signal that cancels the sub-
   session (lines 121-128,164-166). If the parent server process dies, the
   in-process sub-agent computation dies with it, since there is no
   separate process to survive; a sub-agent can be resumed later by
   passing the same session id back in, because it is the persisted
   session state, not a live process, that is durable.

6. Extensions with UI. Two separate plugin systems exist. A server-side
   hooks plugin system (`src/plugin/index.ts`, `src/plugin/loader.ts`) runs
   inside the server process, used for things such as provider auth hooks,
   and has no UI-drawing surface. A TUI-side plugin runtime
   (`src/cli/cmd/tui/plugin/runtime.ts`, `api.tsx`), typed against
   `@opencode-ai/plugin/tui`, wires plugin-exposed APIs directly to TUI-
   only primitives: dialogs, toasts, routes, keybinds and Solid UI slots.
   This runtime loads and runs in the TUI's own process or thread — the
   main thread of the CLI process in the default local layout described in
   question 1 — not in the server or worker thread. So whenever the TUI is
   architecturally separate from the server, as with `opencode attach` or
   the networked worker-thread mode, it is the TUI client that runs any
   plugin code that draws UI, not the server.

## Claude Code

Sources: the installed binary at `~/.local/share/claude/versions/2.1.281`
(`claude --version` reports "2.1.281 (Claude Code)"; `which claude`
resolves to a symlink to the same file), its `--help` and subcommand
`--help` output, a `strings -a` dump of the binary filtered to printable
lines, and Anthropic's own published docs at docs.claude.com and
code.claude.com, fetched live and cited by URL. There is no public source
for Claude Code.

1. Process layout. Running plain `claude` is a single OS process containing
   both the TUI and the agent loop; there is no client/server split in the
   default case. `--print`/`-p` and `--output-format stream-json` only
   change I/O framing within the same process. `claude mcp serve` makes
   Claude Code act as an MCP server for another client, such as Claude
   Desktop — a different question from whether its own TUI is a client of
   a core. Background sessions (`claude --bg`) are each still a full
   single-process `claude` instance; a lightweight daemon (`claude
   daemon`) only supervises their lifecycle and proxies a pseudo-terminal
   over a per-session unix socket (strings: `.pty.sock`, `.claim.sock`,
   `--bg-pty-host`, "must exec, not daemonize") — it does not itself run
   any session's agent loop. A distinct "sdk" MCP transport kind exists
   for in-process embedding (established in `research/mcp-client/
   README.md`). `claude gateway` is an unrelated enterprise auth and
   telemetry relay, not a session core. No server is per-directory; the
   closest thing to per-host is the optional background daemon below.

2. Daemon. Yes, but scoped to background sessions rather than to the
   primary agent loop: "The background daemon manages `& <prompt>` jobs
   and `claude agents`" (strings). It starts lazily on first background-
   session use ("No background daemon is running. Run 'claude daemon
   install' to set it up as a persistent service.") and can optionally be
   installed as an OS service — a `com.anthropic.claude-daemon` launchd
   plist on macOS, a WMI-based service on Windows — so it survives
   reboots; without installing it, it is only a foreground process
   (`claude daemon run`). Stale handling: a versioned lock file
   (`daemon.lock`) records the holder's PID; a holder that cannot be
   verified as the real daemon is left alone, and the user is told to run
   `claude daemon stop --any` or delete the lock. Live upgrade: telemetry
   event names (`tengu_daemon_self_restart_on_upgrade`,
   `tengu_daemon_upgrade_refused_stale_binary`) show the daemon restarts
   itself on a version bump and can refuse to serve a stale binary;
   `claude respawn <id>|--all` lets a background session pick up a new
   binary without the daemon itself restarting it. Authentication: the
   daemon's IPC is a peer-authenticated unix socket or named pipe, named
   `cc-daemon-<16 hex characters>`, gated by peer-UID verification and a
   "daemon control key" nonce. Separately, an auto-updater runs inside
   every foreground `claude` process at startup — this is not itself a
   daemon; `claude update` triggers the same check on demand.

3. Remote clients. Two distinct mechanisms exist. Cloud sessions
   (`claude --cloud`, `--environment`, sessions started from claude.ai/code
   or the Claude mobile app's "Code" tab) run in a genuinely separate
   place: Anthropic's docs state a cloud session "runs on cloud
   infrastructure instead of on your machine... in an isolated, Anthropic-
   managed VM" (docs.claude.com/code.claude.com, "Claude Code on the
   web"), confirmed in the binary's strings ("the cloud container's own
   configuration"; "this Claude Code cannot serve tools to cloud
   sessions"). Remote Control (`claude --remote-control`, `/remote-
   control`) is different: the docs say it "lets you monitor and steer a
   local CLI session from claude.ai or the Claude app" — the session keeps
   running on the user's machine, and the web or mobile client is a thin
   remote control, not a separate execution environment, confirmed by the
   string "The session keeps running on this machine. Use your other
   devices as a remote control." The wire connection for Remote Control is
   a websocket bridge (`wss://bridge.claudeusercontent.com`). `--teleport`
   pulls a cloud session's branch and history down into a local terminal,
   one-way.

4. MCP servers. The main `claude` process itself owns and spawns its
   configured MCP servers; a search of the full strings dump for "broker"
   found only OAuth identity-broker terminology, no MCP connection broker.
   Each session or process is independently responsible for its own MCP
   connections and their OAuth state — a background session's MCP servers
   belong to that session's own process, shown by the string "Can't
   authenticate MCP servers while no terminal is attached to this
   background session." Approval is scoped per project through `.mcp.json`,
   but each running process still makes its own connections; they are not
   shared or multiplexed across concurrently running sessions on the same
   host.

5. Sub-agents. Not confirmed to be separate OS processes; the available
   evidence points to in-process, same-process, task-based execution for
   the default case. Strings include the literal phrases "In-process
   teammates cannot spawn background agents" and "Task id of the in-
   process background subagent". Nesting depth is described in task-graph
   terms, not an OS process tree ("Deepest spawn: 1 = started by the main
   thread, 2 = by a depth-1 subagent"). A subagent is stopped through a
   `TaskStop` tool call or the `/tasks` command, not an OS signal. A
   separate `isolation: "remote"` launch mode for the Agent tool does run
   as a genuinely separate, cloud-hosted execution, explicitly
   distinguished from the in-process default in the same strings; a
   `worktree` isolation mode still runs locally in-process and only
   isolates the git checkout. Anthropic's docs (docs.claude.com/en/docs/
   claude-code/sub-agents) do not state what happens to a subagent if the
   parent process is killed; given the in-process, main-thread language
   found, a same-process subagent should end when its parent process ends
   by construction, but this exact claim is not directly documented — not
   confirmed beyond the in-process architecture itself.

6. Extensions with UI. Hooks are out-of-process: Anthropic's docs
   (code.claude.com/docs/en/hooks) say "Hooks are user-defined shell
   commands, HTTP endpoints, MCP tool calls, LLM prompts, or subagents",
   and for a command hook, "Claude Code spawns a separate process to run
   your shell command", passing JSON on stdin and reading exit code and
   stdout for the result; a hook that reaches its timeout is cancelled.
   The statusline is out-of-process too, configured as an external script;
   `--bare` mode explicitly lists statusline execution among the things it
   skips. Plugins are mixed: they can bundle skills and commands, which
   are prompt text loaded in-process into the system prompt with no
   execution, plus hooks and MCP servers as components, which run out-of-
   process exactly as standalone hooks and MCP servers do. No evidence was
   found of any plugin component executing as loaded code inside the main
   process.

## Comparison

| | pi (shipped) | pi (rewrite, unbuilt) | codex | opencode v2 | Claude Code |
|---|---|---|---|---|---|
| TUI and agent loop | one process | separate: TUI is a presentation process, server routes to a session-worker process | TUI is a client of an app-server; embedded in-process by default fallback, or a shared local daemon by default | one process, two threads by default; a real socket only with network flags or `serve`/`attach` | one process |
| Protocol between them | none (RPC mode uses stdio JSONL to an external caller) | Chord's own multiplexed connection, not named as HTTP or websocket | unix socket by default, or websocket for `Remote`; a first-party JSON-RPC-shaped protocol, not MCP | in-process RPC by default; HTTP if networked | none by default |
| Host-wide daemon | none | server is long-lived and shared, but startup and auth mechanics are not documented | yes, `codex app-server daemon`, on by default (`daemon_auto_start`) | none found; `serve`/`web` run in the foreground and must be started by hand | yes, but scoped to background sessions only, not the primary loop; opt-in persistence as an OS service |
| Remote client reaches | nothing (no remote feature found) | not confirmed; presentation model allows "web later" | separate: `codex cloud` is a wholly separate OpenAI-hosted environment; the local daemon's own remote-control is a different, opt-in path | the same local or self-hosted server over HTTP, with optional Basic auth | two paths: cloud sessions run on a separate Anthropic-managed VM; Remote Control steers a session still running locally, over a websocket bridge |
| MCP servers started by | the agent process, via an in-process third-party extension, keyed by working directory | not documented in the spec reviewed | whichever process runs the core for that thread (daemon or embedded); own process group per server | the server process, as child processes or remote connections | the main `claude` process itself |
| MCP sharing scope | one set per process/session | not documented | per thread/session; one narrow shared-cache exception for a built-in connector | per project directory, shared by clients/sessions on that directory | per session/process; not shared across sessions |
| Sub-agents run as | none exist | in-process async operation (Pico5 spec); a second, unreconciled `spawn_subagent` path goes through the server | `tokio::spawn` task in the parent's own OS process | in-process async computation in the server process | in-process, task-based (not confirmed as OS-process-based); a separate cloud isolation mode is a genuine separate execution |
| Sub-agent dies with parent | n/a | implied by in-process design, not directly documented | yes, by construction — no separate process lifecycle | yes, by construction — no separate process to survive | not directly documented; implied by in-process design |
| Plugin UI runs in | the single agent/TUI process | the presentation process, receiving facet bundles over the wire at attach time rather than bundled ahead of time | nowhere — plugins cannot draw custom TUI UI at all | the TUI's own process/thread, separate from the server | nowhere in-process — hooks and the statusline run as external, out-of-process commands; plugins carry no UI-drawing component |

## What this means for Fiber's choices

- None of the four tools runs a sub-agent or delegate as a separate OS
  process by default. Where the mechanism was found (codex, opencode,
  Claude Code's in-process evidence, and pi's spec-only Pico5), it is a
  task or async operation inside the parent's own process, ending when the
  parent process ends. The one place a genuinely separate execution
  appears is Claude Code's `isolation: "remote"` launch mode, which is a
  cloud-hosted execution, not a local child process.
- Every tool that spawns MCP server child processes does so from whichever
  process is already running the agent core for that session, rather than
  from a dedicated broker process. Scoping differs: pi and Claude Code
  scope MCP connections to one process/session; codex scopes them to a
  thread within its daemon or embedded core, with one narrow shared-cache
  exception; opencode scopes them to a project directory, shared across
  clients and sessions working in that directory on the same server.
- Two of the four (codex, Claude Code) ship an optional or default host-
  wide daemon that outlives the terminal and can be shared across
  sessions; codex's is on by default, Claude Code's exists only to manage
  background sessions. opencode has no daemon in the codebase, but its
  `serve` command produces the same shape by hand. pi's shipped code has
  no daemon at all; a daemon-shaped server exists only in pi's unbuilt
  rewrite.
- Where a daemon or shared server accepts non-loopback connections, every
  tool that has one gates it behind an explicit credential: codex requires
  a capability token or signed bearer token, Claude Code's daemon IPC
  requires peer-UID verification plus a control-key nonce and its Remote
  Control uses a websocket bridge, and opencode's server enforces HTTP
  Basic Auth only if a password environment variable is set (and is
  otherwise open, with an explicit warning printed).
- Two shapes of remote client were found across the four tools: a thin
  remote control of a session still running on the user's own machine
  (Claude Code's Remote Control, codex's local daemon remote-control,
  opencode's desktop/web app against its own server), and a wholly
  separate cloud-hosted execution that the local machine never runs at all
  (codex cloud, Claude Code cloud sessions). No tool was found to let a
  remote client directly drive an MCP server or delegate that isn't
  already running somewhere.
- Where a plugin or extension can draw its own UI, that code runs in
  whichever process renders the UI, not in the core: pi's shipped
  extensions and its unbuilt rewrite's presentation facets, and
  opencode's TUI-side plugin runtime, all execute in the TUI's own process
  or thread. codex and Claude Code both stop short of letting a plugin
  draw custom UI at all; where Claude Code lets an extension act
  (hooks, statusline), it does so as an external process, not loaded code.
