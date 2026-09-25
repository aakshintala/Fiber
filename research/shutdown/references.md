# How pi, codex and Claude Code handle process shutdown

Sources: pi install at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/`
(referenced as `pi-dist/...`); codex source at `/tmp/codex-src/codex-rs` (referenced as
`codex-rs/...`); Claude Code binary at `~/.local/share/claude/versions/2.1.282` via
`strings -n 15` (referenced as "binary strings"), and code.claude.com ("docs").

## pi

### SIGTERM

A handler is installed in all three run modes. `registerSignalHandlers` listens for
`SIGTERM`, and on non-Windows also `SIGHUP` (`pi-dist/modes/rpc/rpc-mode.js:275-287`,
`pi-dist/modes/print-mode.js:31-46`, `pi-dist/modes/interactive/interactive-mode.js:3452-3469`).
The handler first kills any tracked detached children, then runs an orderly shutdown:
`runtimeHost.dispose()` calls `session.dispose()`, which calls `agent.abort()`
(`pi-dist/core/agent-session-runtime.js:296-303`, `pi-dist/core/agent-session.js:822-829`).
Aborting the turn cancels the shared `AbortSignal`; a bash/shell tool call in flight sees
the abort and throws `Error("Command aborted")`, appended to partial output as the tool's
error result (`pi-dist/core/tools/bash.js:65-68, 91-93, 252-257`) — a killed tool call
gets a synthetic completion, not nothing, since `dispose()` is awaited before
`process.exit`.

Exit code: in print and rpc mode, 143 for SIGTERM and 129 for SIGHUP
(`pi-dist/modes/print-mode.js:40`, `pi-dist/modes/rpc/rpc-mode.js:283`). In interactive
mode the signal path always calls `process.exit(0)` after terminal cleanup
(`pi-dist/modes/interactive/interactive-mode.js:3369-3382`); this differs from the other
two modes, and the code does not explain why.

### SIGINT / Ctrl+C

`registerSignalHandlers` in interactive mode only lists `SIGTERM`/`SIGHUP`
(`interactive-mode.js:3454-3457`) — Ctrl+C is read as a keypress from the raw terminal, not
as a process signal. `handleCtrlC` clears the input editor on the first press; a second
press within 500 ms calls `shutdown()` (`interactive-mode.js:3342-3351`). Ctrl+D
(`handleCtrlD`) calls `shutdown()` directly, no second press needed
(`interactive-mode.js:3352-3355`). Print mode and rpc mode register no SIGINT handler at
all in the files read; not found in source examined.

### SIGHUP and closed stdin

SIGHUP is handled identically to SIGTERM except for the exit code (129 instead of 143,
see above). A code comment notes this was changed: "SIGHUP no longer hard-exits: graceful
shutdown emits session_shutdown first, then attempts terminal restore"
(`interactive-mode.js:3460-3463`). What a closed stdin does in `--mode rpc` / `--mode json`
specifically (as opposed to a delivered SIGHUP): not found in the rpc-mode.js and
print-mode.js sections read.

### Child cleanup at exit

The bash/shell tool spawns with `detached: process.platform !== "win32"` (own process-
group leader on Unix), pid tracked via `trackDetachedChildPid`/`untrackDetachedChildPid`
(`pi-dist/core/tools/bash.js:50-62, 102-104`). On abort or timeout, `killProcessTree` does
`process.kill(-pid, "SIGKILL")` — the whole group, straight to SIGKILL, no SIGTERM grace
(`pi-dist/utils/shell.js:184-214`); a shutdown signal's `killTrackedDetachedChildren()`
walks the tracked set the same way (`shell.js:175-180`). Separately, `execCommand` (used
by extensions/custom tools) sends SIGTERM first, then SIGKILL after a 5000 ms grace period
(`pi-dist/core/exec.js:21-31`). No total shutdown deadline was found; the only fixed wait
in the interactive shutdown path is `this.ui.terminal.drainInput(1000)` (1000 ms, twice, at
`interactive-mode.js:3379,3389`). No MCP SDK or MCP-server-launch file was found under
`pi-dist/`; not found in source examined. What happens when a child will not die: the
SIGKILL call is unconditional, with no follow-up check that the group exited; not found
in source examined beyond that.

### Crash / SIGKILL of the harness, and pid/lock files

No `PR_SET_PDEATHSIG`/`prctl`, pid file, lock file, socket path, or kqueue-based reaper
was found anywhere in `pi-dist/` (`grep -rl` for `.lock`, `pidfile`, `.pid` returned
nothing). Because tool children are spawned `detached: true` (their own process group),
a SIGKILL of pi itself leaves any in-flight shell command's process group running with no
cleanup mechanism found in source; the gap looks accepted rather than handled.

## codex

### SIGTERM

At the app-server (`codex app-server`, the headless RPC mode), a Unix signal handler is
installed with `tokio::signal::unix::signal(SignalKind::terminate())`, alongside
`ctrl_c()` and `SignalKind::hangup()` (`codex-rs/app-server/src/lib.rs:210-223`). SIGTERM
and SIGINT are both `ShutdownSignal::Forceable`. The first calls `begin_drain()` (stop
admitting new turns) and waits for `running_turn_count == 0 && active_admissions == 0`
before finishing — no fixed timer at this layer, only turn completion (`lib.rs:247-301`).
A second Forceable signal sets `forced = true` and finishes immediately regardless of
running turns (`lib.rs:255-257, 280-290`).

The stdio transport used by `app-server` layers a hard deadline on top of that: on
receiving SIGTERM it logs "SIGTERM received; closing stdio connection (45s shutdown
deadline)" and arms a watchdog thread that sleeps 45 seconds
(`std::time::Duration::from_secs(45)`) then calls `std::process::exit(1)` if the graceful
path has not already finished (`codex-rs/app-server-transport/src/transport/stdio.rs:1-4,
41-51, 158, 168-180`).

For a single shell command run via the `exec` tool, Ctrl+C (`tokio::signal::ctrl_c()`)
kills that command's process group immediately with SIGKILL and no grace period, recording
a synthetic exit status `128 + 9` (SIGKILL) as the tool result — this is a real
completion, not nothing (`codex-rs/core/src/exec.rs:1077-1081`, constants at
`exec.rs:67-69`). A turn-level cancellation (`ExecExpirationOutcome::Cancelled`) is
gentler: SIGTERM to the process group first, then a wait of
`CANCELLATION_TERMINATION_GRACE_PERIOD = 50 ms` (`exec.rs:71`) for the child to exit
before escalating to SIGKILL on the whole group (`exec.rs:1042-1073`) — this is the
already-known 50 ms figure, confirmed with its neighbours. `IO_DRAIN_TIMEOUT_MS = 2_000`
(`exec.rs:94`) bounds how long codex waits for a finished process's stdout/stderr pipes to
close before giving up and force-killing the group again (`exec.rs:1142, 1152`).

### SIGINT / Ctrl+C

In the TUI, an unhandled Ctrl+C interrupts the active turn/tool call rather than exiting;
`ChatWidget` "owns process-level decisions such as interrupting active work, arming the
double-press quit shortcut, and requesting shutdown-first exit"
(`codex-rs/tui/src/chatwidget.rs:509-511`). A double-press-to-quit shortcut exists
(`QUIT_SHORTCUT_TIMEOUT = Duration::from_secs(1)`, `codex-rs/tui/src/bottom_pane/mod.rs:224`)
but is currently switched off: `DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED: bool = false`, with a
comment that requiring a second press "feels janky in practice... rethink a better
quit/interrupt design" (`mod.rs:228-233`). At the app-server, SIGINT is treated exactly
like SIGTERM (both `Forceable`; see above).

### SIGHUP and closed stdin

At the app-server, SIGHUP is `ShutdownSignal::GracefulOnly` (`lib.rs:217, 221`) — unlike
SIGTERM/SIGINT it can never set `forced`, so a second SIGHUP still waits for running turns
to finish (`on_signal` only forces for the `Forceable` arm, `lib.rs:254-258`). For the
stdio transport specifically, a closed stdin (client EOF) arms the same 45-second
watchdog deadline as SIGTERM: "EOF can finish the transport before RPC or runtime cleanup.
Start the same process deadline even if no SIGTERM arrives"
(`app-server-transport/src/transport/stdio.rs:66-69, 125-133, 168-180`).

### Child cleanup at exit

Every spawned child is put in its own process group in `pre_exec`
(`codex-rs/utils/pty/src/process_group.rs:69-80`, `setpgid(0,0)`), and group-wide signals
go through `killpg`/`terminate_process_group`/`kill_process_group` (`process_group.rs:88-
289`). The default shell-command sequence is SIGTERM then, after
`CANCELLATION_TERMINATION_GRACE_PERIOD` (50 ms), SIGKILL of the group (`exec.rs:1042-
1073`); a hard timeout instead goes straight to SIGKILL, no grace (`exec.rs:1034-1040`).
MCP stdio servers launched locally are child processes of the orchestrator
(`codex-rs/rmcp-client/src/stdio_server_launcher.rs:1-13, 155-190`), closed via
`self.process.terminate().await?` when the transport closes (`Transport::close`). The
pid-managed app-server daemon has its own grace/force pair: `DEFAULT_SHUTDOWN_GRACE_SECONDS
= 60` (`app-server-daemon/src/settings.rs:15`), plus a fixed `STOP_FORCE_TIMEOUT =
Duration::from_secs(10)` on top, polled every `STOP_POLL_INTERVAL = 50 ms`
(`app-server-daemon/src/backend/pid.rs:31-33, 158-177, 226-236`) — total deadline there is
grace (default 60 s, configurable) + 10 s, after which `force_terminate_process` (SIGKILL)
runs and the stop loop errors out if the process is still alive (`pid.rs:239-241`).

### Crash / SIGKILL of the harness, and pid/lock files

On Linux, spawned children can be given `PR_SET_PDEATHSIG` so they receive SIGTERM when
their parent dies, with a race check against a re-fetched parent pid immediately after:
`set_parent_death_signal` (`codex-rs/utils/pty/src/process_group.rs:24-41`). This is
Linux-only (`#[cfg(target_os = "linux")]`); the non-Linux fallback is a no-op
(`process_group.rs:43-47`), so on macOS a SIGKILL of codex leaves its process-group
children orphaned with no reaping mechanism found in source. The app-server daemon's pid
file is written atomically (temp file then `fs::rename`,
`app-server-daemon/src/backend/pid_start.rs:295-312`) and removed (`fs::remove_file`) on
a failed or stale start/reservation, and by the stopper once it confirms the process gone
(`pid_start.rs:56, 86, 242, 289, 299`; `pid.rs:309, 321`); direct evidence that the
running daemon unlinks its own pid file on a clean voluntary exit was not found in the
files read.

## Claude Code

No source is available; findings below are from the documented behaviour at
code.claude.com and from strings/JS text embedded in the compiled (Bun) binary at
`~/.local/share/claude/versions/2.1.282`.

### SIGTERM

Documented for `-p` (headless) runs: "If you stop a `claude -p` run with SIGTERM...
Claude Code exits with code 143. Claude Code leaves the turn that was in progress
unfinished and records no result for it... On SIGTERM, Claude Code terminates the process
tree of any Bash command that is still running. Claude Code then runs `SessionEnd` hooks
and exits. While exiting, Claude Code starts no new tool call, sends no new model
request, and runs no hook other than `SessionEnd`." (docs, code.claude.com/docs/en/
headless, "Stop a run with SIGTERM"). For the step in progress: "Running a command:
Claude Code records the command as killed in the session" — a synthetic "killed"
completion, not nothing (same section). A permission prompt is left unanswered by a raw
SIGTERM, but is actively cancelled if the Agent SDK closes the session first (same
section); resuming the session continues the unfinished turn (same section). Separately,
an interrupted tool-use turn is recorded in the transcript with the literal marker string
`[Request interrupted by user]` / `[Request interrupted by user for tool use]` (binary
strings).

### SIGINT / Ctrl+C

Documented: "Ctrl+C ... Interrupts a running operation. If nothing is running, the first
press clears the prompt input and a second press exits Claude Code."
(docs, code.claude.com/docs/en/interactive-mode, "General controls" table). This matches
two literal strings embedded in the binary: "Press Ctrl-C again to exit" and "(press
Ctrl+C again to exit, or Ctrl+D)" (binary strings). For `-p` runs: "To end the turn
instead, send SIGINT, or call the Agent SDK's `interrupt()`, before you stop the process"
(docs, code.claude.com/docs/en/headless) — i.e. SIGINT cancels the turn only, distinct
from SIGTERM's abandon-and-exit.

### SIGHUP and closed stdin

No documented behaviour for SIGHUP, and no `SIGHUP`-specific string beyond the generic
Node/Bun signal-name table (`SIGHUP` appears only in a bundled list of all signal names,
not in application logic reachable by search); not found in source examined. For closed
stdin in `-p` (headless) runs generally: "If Claude Code can't read stdin, for example
because the process that started it disconnected its end, Claude Code prints a warning to
stderr and continues with the prompt from the command line" (docs,
code.claude.com/docs/en/headless, "Pipe data through Claude") — this describes stdin
being unreadable at startup, not a mid-session close in `--input-format stream-json`;
that specific case was not found in the docs pages fetched.

### Child cleanup at exit

Documented, for `-p` background Bash tasks: "that shell is terminated about five seconds
after Claude has returned its final result and stdin has closed. The grace period lets a
task that finishes right after the result still deliver its output." A background
subagent or workflow instead keeps the process open until it completes, capped at "10
minutes of continuous idle waiting" by default (env var
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, 0 disables it), after which "Claude Code stops
whatever is still running and drops its partial result" (docs,
code.claude.com/docs/en/headless, "Background tasks at exit"). A message template in the
binary, `killEscalation: task {} still unsettled {}ms after kill; killed process groups of
{}`, shows this escalates to killing whole process groups after a child fails to die
within some interval following the initial kill (binary strings). A separate,
heavier-weight background-orchestration feature (a "self-hosted runner" that manages one
child Claude Code process per session, flags `--capacity`, `--exec-path`) logs
"[runner:session] Abort signal received, sending SIGTERM to process group pgid=..." then
"...ms, sending SIGKILL to process group pgid=..."; its post-session lifecycle hook gets
its own SIGTERM-grace-then-SIGKILL pair, and a `--drain-wait-sec` flag lets an in-flight
turn or background task finish before the session's own SIGTERM is sent (binary strings).
The runner's numeric ms defaults for `SESSION_STOP_GRACE`, `POST_SESSION_HOOK_TIMEOUT` and
`BG_RESULT_GRACE` are computed at runtime and were not resolved to literals from
`strings`; `POST_TURN_SETTLE_MS` is documented in its own help text as "normally about two
seconds" (binary strings).

### Crash / SIGKILL of the harness, and pid/lock files

No mechanism (pid file reaper, `PR_SET_PDEATHSIG`/`prctl`, kqueue, or documented
cleanup-on-next-start) was found for the ordinary CLI process, in docs or in binary
strings. No pid/lock/socket path string was found for the ordinary CLI either; the
self-hosted-runner feature does write a pid file per managed session (per its
`--base-dir`/checkout-directory help text), but its removal on exit was not confirmed
from strings. Not found in source examined.

## Summary table

| Harness | SIGTERM grace before SIGKILL | Total shutdown deadline | Children in their own process group | Crash leaves children running |
|---|---|---|---|---|
| pi | none for tool-call abort/timeout (straight to SIGKILL of the group); 5000 ms for `execCommand` (extension helper) only. `pi-dist/utils/shell.js:184-214`, `pi-dist/core/exec.js:21-31` | none found; only a 1000 ms terminal-drain wait in interactive mode. `interactive-mode.js:3379,3389` | yes, Unix only (`detached: true`). `pi-dist/core/tools/bash.js:52` | yes — no PDEATHSIG/pidfile reaper found |
| codex | 50 ms for turn-cancel (SIGTERM then SIGKILL); direct SIGKILL for Ctrl+C-during-exec and for hard timeouts. `codex-rs/core/src/exec.rs:71,1042-1081` | app-server stdio transport: 45 s hard watchdog from SIGTERM or stdin EOF. daemon stop: grace (default 60 s) + 10 s. `app-server-transport/.../stdio.rs:168-180`, `app-server-daemon/.../pid.rs:31-33,177` | yes, always (`setpgid` in `pre_exec`). `codex-rs/utils/pty/src/process_group.rs:69-80` | Linux: no, via `PR_SET_PDEATHSIG`. Other platforms: yes. `process_group.rs:24-47` |
| Claude Code | not found as a fixed number for the CLI's own subprocess kill (docs describe "terminate the process tree", no ms figure); the self-hosted-runner feature does SIGTERM-then-SIGKILL escalation with unresolved ms figures | `-p` background bash: ~5 s after result+stdin-close; background subagents/workflows: 10 min idle cap (configurable). docs, code.claude.com/docs/en/headless | not confirmed from source or docs for the ordinary CLI; the runner feature explicitly signals whole process groups (`pgid=`) | not established; no reaping mechanism found in docs or binary strings |
