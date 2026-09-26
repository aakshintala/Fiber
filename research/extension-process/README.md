# Extension processes and extension state

Evidence for [Extension system: what an extension can build, and where its state lives](https://github.com/aakshintala/fiber/issues/39). The contract is `docs/extensions.md`.

## What a process extension costs

`drive.py` starts a small echo program, sends one JSON line and reads the reply, then measures the program's idle memory and 2,000 round trips at each message size. It also starts a fresh process for each of 20 calls, as a command hook does in Claude Code and codex. Everything is timed from one Python process.

Run on macOS 26.6.2, arm64, on September 25, 2026. Node 26.8.1, Bun 1.4.0, Python 3.9.6.

| Runtime | Start to first reply | Idle RSS | 256 B round trip, median | 16 KiB round trip, median (p99) | A new process per call, median |
|---|---:|---:|---:|---:|---:|
| Node | 31.6 ms | 39.8 MiB | 14.1 µs | 55.7 µs (86.2 µs) | 29.5 ms |
| Bun | 42.0 ms | 20.1 MiB | 23.6 µs | 64.3 µs (270.4 µs) | 16.9 ms |
| Python | 21.6 ms | 9.6 MiB | 19.0 µs | 78.8 µs (99.7 µs) | 20.6 ms |

For comparison, handing a 16 KiB value to Lua and back takes under 10 µs, and a Lua VM costs about 120 to 150 KiB (`research/hook-conversion-cost/`, `research/extension-runtime/`).

The round trips include the Python driver's own JSON encoding, so they are an upper bound on the pipe. The timings are macOS only; Linux was not measured.

What this means:

- A process that stays up adds about 50 µs to a hook. A tool call takes milliseconds or more, so this is small.
- A new process per call costs 17 to 30 ms and remembers nothing between calls, so it can keep no timer, connection or memory. Fiber keeps a process extension running for the session.
- Memory is the real cost: 10 to 40 MiB per extension before any of its own code runs.

## How other harnesses run hook programs

- codex: `HookHandlerConfig` has `Command`, a program started per event, and `McpTool`, a tool call on a running MCP server (`codex-rs/config/src/hook_config.rs`).
- Claude Code 2.1.282: hook types `command`, `http`, `mcp_tool`, `prompt`, `agent` and `callback`, from `strings` on the binary.
- pi: an extension is TypeScript in pi's own Node process. `pi install` runs `npm install` (or the configured bun or pnpm) for npm and git packages, without `--ignore-scripts` (`dist/core/package-manager.js` in the installed pi).

None lets a hook program register a tool other than through MCP, keep state in the session, or add a command.

## What the owner's pi extensions use

A search of `~/work/pi-extensions` (19 extensions, tests and the `shared/` libraries excluded) for what Fiber's Lua extensions lacked:

| Capability | Extensions using it |
|---|---:|
| Timers (`setTimeout`, `setInterval`) | 10 |
| Starting programs | 6 |
| Direct file access | 7 |
| Sockets or `fetch` | 0 |

The timers poll (quota, job output, fleet refresh), put deadlines on work (git, monitor, process groups), animate (a spinner, tool display) and debounce (git status in the footer). Of pi's 78 bundled examples, only the three custom providers make network calls, which `host.http` covers.

## How big extension state is

A scan of the owner's pi session logs from the last 60 days, temporary directories excluded: 629 sessions, 605 with at least one extension state entry (`appendEntry`, pi's `custom` entries).

| | Entries | Median | 99th percentile | Largest |
|---|---:|---:|---:|---:|
| All types | 10,652 | 162 B | 3,066 B | 26,923 B |
| `pi-stamp` (one per turn) | 9,175 | 162 B | 656 B | 1,263 B |
| `subagents:record` (one per run) | 514 | 1,828 B | 16,545 B | 26,923 B |
| `goal-state` | 7 | 349 B | 350 B | 350 B |

The two biggest users write one record per turn or per run, not a growing value. That is why Fiber's extension state takes one key per record for history, and why a 64 KiB cap per value leaves room: 2.4 times the largest entry seen. The 64 KiB figure was chosen, not measured.

## Files

- `drive.py`: the driver
- `echo.js`: the Node and Bun echo program
- `echo.py`: the Python echo program
