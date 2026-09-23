# Delegate memory: threads or processes

This note answers [#76](https://github.com/aakshintala/fiber/issues/76): how
much resident memory a delegate costs as threads in its parent's process,
compared with running as its own process. It feeds the open question on
[#21](https://github.com/aakshintala/fiber/issues/21).

All numbers are from macOS arm64 only: Apple M3 Pro, 18 GiB, macOS 26.6.2,
rustc 1.98.1, release build. Linux is unmeasured, so PSS is unmeasured too.
No Linux machine, container or VM was available, and none was provisioned.

## The probe

The probe is a throwaway Rust program, kept out of the repository at
`/private/tmp/claude-501/-Users-aakshintala-work-fiber/d8d6e81c-d6ca-4d87-bb8b-96c612a16745/scratchpad/rss-probe/`
(`src/main.rs`, `measure.sh`, `grid.sh`, and raw output in
`results-macos-1.txt` and `results-macos-2.txt`). That directory is temporary.

It links mlua 0.12 (Lua 5.4, vendored), rusqlite 0.40 (bundled SQLite),
rustls 0.23 (ring provider, webpki-roots 1.0) and serde_json 1. One session
holds:

- one Lua state that has run a 5 KB script defining 40 functions
- one SQLite connection to its own file, in WAL mode, with 100 rows written
  and read back
- one rustls `ClientConfig` with the Mozilla root store, either shared through
  an `Arc` or built per session
- a synthetic conversation of `serde_json::Value` messages, 200 KB or 2 MiB
  when serialised
- one `std::thread` that builds the session and then blocks on a channel, as
  in ADR 0004

In thread mode, N sessions run in one process. In process mode, a launcher
spawns N copies of the same binary, each holding one session. Each case was
measured 2 seconds after every session reported ready. The whole grid ran
twice. The runs agree within 1%; the tables use the second run.

`phys_footprint` (from `footprint <pid>`) is what macOS charges a process. It
counts private dirty and compressed memory, not shared code pages. `ps` RSS
counts shared code pages in every process, so summing RSS across processes
overstates the real cost. Process-mode totals exclude the launcher, which sits
at the idle baseline.

## Results (macOS arm64)

Stripped binary: 3.3 MB (3,346,080 bytes).

Idle process with nothing initialised: 1.0 MiB footprint, 1.8 MiB RSS.

### Total footprint, MiB

| Conversation | Mode | N=1 | N=10 | N=110 | Per session, N=10 to 110 |
|---|---|---|---|---|---|
| 200 KB | threads, shared TLS config | 2.0 | 7.6 | 64.0 | 577 KB |
| 200 KB | threads, TLS config per session | 2.0 | 7.8 | 67.0 | 606 KB |
| 200 KB | processes | 2.0 | 19.5 | 215.4 | 2,005 KB |
| 2 MiB | threads, shared TLS config | 5.1 | 39.0 | 406.0 | 3,758 KB |
| 2 MiB | threads, TLS config per session | 5.1 | 39.0 | 409.0 | 3,789 KB |
| 2 MiB | processes | 5.1 | 51.1 | 561.6 | 5,227 KB |

`footprint` prints large single-process totals in whole MB, so thread-mode
slopes are accurate to about 10 KB.

### Total RSS, MiB

| Conversation | Mode | N=1 | N=10 | N=110 | Per session, N=10 to 110 |
|---|---|---|---|---|---|
| 200 KB | threads, shared TLS config | 4.2 | 10.2 | 69.1 | 603 KB |
| 200 KB | threads, TLS config per session | 4.2 | 10.4 | 72.0 | 631 KB |
| 200 KB | processes | 4.3 | 42.7 | 469.7 | 4,373 KB |
| 2 MiB | threads, shared TLS config | 7.4 | 41.5 | 411.2 | 3,786 KB |
| 2 MiB | threads, TLS config per session | 7.4 | 41.6 | 414.3 | 3,817 KB |
| 2 MiB | processes | 7.4 | 74.2 | 815.9 | 7,595 KB |

### Each component's cost per session

Each component was built alone, N=10 and N=110 in one process, and the slope
taken.

| Component | Footprint per session | RSS per session |
|---|---|---|
| Conversation, 2 MiB | 3,523 KB | 3,523 KB |
| Conversation, 200 KB | 342 KB | 347 KB |
| SQLite connection | 109 KB | 145 KB |
| Lua state with a 5 KB script | 89 KB | 92 KB |
| rustls config, built per session | 28 KB | 28 KB |
| rustls config, shared through `Arc` | under 1 KB | under 1 KB |
| Blocked thread | 22 KB | 21 KB |

The five components sum to about 590 KB, which matches the 606 KB thread-mode
slope. A conversation costs about 1.7 times its serialised size once parsed
into `serde_json::Value`.

## What is shared and what is duplicated

A separate process adds about 1.4 MiB of footprint per delegate on macOS
(2,005 KB against 606 KB, and 5,227 KB against 3,789 KB). That is the process
itself: dirty data segments, dynamic loader state, allocator zones and
metadata, the main thread's stack and page tables. Threads in one process pay
it once.

The 1.9 MB of code pages are shared either way. The operating system maps
them once, so they appear in each process's RSS but not in its footprint.

The rustls config is the only session component that threads can share and
processes cannot. It is 28 KB, so sharing it saves little.

The Lua state, SQLite connection, conversation and loop thread are private to
each session in both modes. The conversation dominates. At 2 MiB it is 93% of
a thread-mode session.

## Conclusion

On macOS, a delegate as its own process costs about 1.4 MiB more than a
delegate as threads. At the worst case of 110 sessions that is about 150 MiB
extra: 215 MiB against 67 MiB with 200 KB conversations, and 562 MiB against
409 MiB with 2 MiB conversations. The gap is a fixed cost per process. The
conversation held in memory is the largest cost in both modes, and it grows
with the session, so how Fiber holds a conversation matters more than threads
against processes once conversations are large. Linux has not been measured.
glibc gives each thread its own allocator arena, which could raise the
thread-mode cost on Linux, so re-run the probe there before relying on these
numbers for Linux.

## Round 2: state one process can share

The sections above measure only what each session owns. This round measures
the state that delegates running as threads in one process can share, and
that separate processes each hold their own copy of: MCP servers, compiled
extension code and a provider model catalog.

Same machine, same platform: macOS arm64 only. Linux is still unmeasured,
and no Linux machine was provisioned. Footprint is `phys_footprint`, as
above. The probe gained two modes, `luaset` and `json`, plus
`mcp/mcp_measure.py` and `round2.sh`. Raw output is in
`results-macos-round2.txt` and `mcp/results-macos-mcp.txt`, all in the same
temporary directory.

### MCP servers

These are the MCP servers the owner configures:

- Claude Code, user scope in `~/.claude.json`: `quotabar`
  (`node --experimental-strip-types ~/work/ClaudeBar/mcp/index.ts`)
- Claude Code, from the `cursor-delegate` plugin's `.mcp.json`:
  `cursor-delegate` (`node ~/work/cursor-delegate/dist/index.js`). pi also
  loads it: `~/.pi/agent/mcp-cache.json` lists it as pi's only server.
- Codex, `~/.codex/config.toml`: `node_repl` (a native binary shipped in
  ChatGPT.app), and `computer-use`, which is disabled
- `~/work/lens/.cursor/mcp.json`, a project-scoped Cursor config: `omnigent`

No project in `~/.claude.json` has its own servers, `~/.claude/settings.json`
defines none, and `~/.cursor/mcp.json` does not exist. The claude.ai
connectors that Claude Code shows are remote HTTP servers with no local
process.

`mcp_measure.py` started each server over stdio, sent `initialize`,
`notifications/initialized` and `tools/list`, left it idle for 5 seconds, then
measured its whole process tree. Two runs agreed to within 100 KB.

| Server | Footprint | RSS | Tools | Tied to a workspace |
|---|---|---|---|---|
| quotabar | 59.0 MiB | 91.3 MiB | `get_quotas` | No |
| cursor-delegate | 43.0 MiB | 82.2 MiB | `cursor_run`, `cursor_poll`, `cursor_cancel`, `cursor_wait`, `cursor_wait_any`, `cursor_wait_all`, `cursor_answer`, `doctor` | Yes, by default |
| node_repl, idle | 6.6 MiB | 16.7 MiB | `js`, `js_add_node_module_dir`, `js_reset`, `turn_ended` | No, but it keeps session state |
| node_repl, after one `js` call | 28.4 MiB | 77.0 MiB | as above | as above |
| computer-use | not measured | not measured | | Disabled in the Codex config |
| omnigent | not measured | not measured | | Its interpreter, `~/.local/share/uv/tools/omnigent/bin/python`, is not on disk |

The two Node servers are mostly V8 heap. The copies that one Claude Code
session had held for 16 hours were smaller, because macOS had compressed their
idle pages: quotabar at 39 MB footprint and 35 MiB RSS, cursor-delegate at
34 MB and 43 MiB. The totals below use the fresh numbers.

Whether each server is tied to a workspace:

- quotabar is not. Its one tool reads quota data from the QuotaBar app over
  local HTTP on port 8787 (`ClaudeBar/mcp/index.ts`).
- cursor-delegate is, by default. It records `process.cwd()` at startup as
  `serverCwd` (`dist/index.js:111`), runs `cursor-agent` there and reads the
  git HEAD there (`dist/runner.js:44,59`). A call can name another directory
  with the `CallerProvided` isolation type, which passes `--workspace <path>`
  (`dist/isolation.js`). So one instance can serve several worktrees only if
  every call names its worktree.
- node_repl is not tied to a workspace, but it keeps a JavaScript kernel whose
  variables persist between calls, and `turn_ended` marks turns. Sessions
  sharing one instance would share that kernel.

Neither Node server's code mentions MCP roots. The node_repl binary contains
the `roots/list` method name, probably from its MCP library; whether it calls
it was not tested. MCP gives one set of roots to each client connection, so a
single stdio connection cannot give different delegates different roots. A
root that multiplexes several delegates over one connection works for servers
like quotabar, which hold no workspace or session state. It does not work for
a server that reads roots or its working directory, or keeps per-session
state, unless each delegate gets its own instance.

The MCP set used in the totals below is quotabar plus cursor-delegate, the two
servers the owner runs every day through Claude Code and pi: 104,448 KB
(102.0 MiB) footprint.

### Extensions in Lua

The owner's pi-rig package (`aakshintala/pi-rig`, cloned read-only) has 18
extensions under `extensions/`, in 52 TypeScript files and 14,435 lines of
code excluding tests (588 KB). A further 1,475 lines of helpers sit in
`shared/`. The largest extensions are `context` (5,583 lines), `usage`
(2,452), `stamp` (1,245) and `subagents` (1,071).

The probe generates one Lua module for each extension with the same line
count, plus one module for `shared/`: 19 modules, 15,800 lines, 508 KB of
source and 1,274 functions. Each module defines functions, tables of string
constants and tool definitions, and registers every fifth function with a
host function, as a pi extension registers tools and hooks. It then calls
each of its functions once.

Lua's own allocator count for one state with the whole set loaded is
1,450,042 bytes. Measured by footprint, N states in one process, slope from
N=10 to N=40:

| How each state loads the set | Footprint per state | Held once per process |
|---|---|---|
| Compile the source | 1,809 KB | 508 KB of source, freed after loading |
| Load shared bytecode, debug info kept | 1,536 KB | 703 KB of bytecode |
| Load shared bytecode, debug info stripped | 1,263 KB | 506 KB of bytecode |

Lua 5.4 cannot share compiled functions between states. Loading bytecode
still builds a private copy of every function prototype, constant and string
in each state. So sharing bytecode saves only the parser's leftover heap
(about 270 KB per state) and, if stripped, debug information such as line
numbers (a further 270 KB). A separate process gets the same saving by loading
the same bytecode from a file and freeing the buffer. The extension set costs
about 1.5 MiB per session in both designs.

mlua's `Lua` cannot be called from several threads at once. By default it is
not `Send`. With mlua's `send` feature it is `Send + Sync`, but every call
takes a reentrant mutex (`src/types/sync.rs`), so calls from several threads
wait for each other. Each session therefore needs its own Lua state, unless
every hook call from every session runs one at a time on one Lua thread.

### Provider model catalog

OpenRouter's public model list (`https://openrouter.ai/api/v1/models`,
fetched 2026-09-23, 457 models, 749,714 bytes) parsed into one
`serde_json::Value` costs 6,256 KB of footprint above the idle process, about
8.5 times its size on disk.

For comparison, the models.dev catalog that opencode caches
(`~/.cache/opencode/models.json`, 4,796,203 bytes) costs 52,208 KB
(51.0 MiB) parsed the same way, about 11 times its size. Parsing into typed
structs, or holding only the providers in use, would cost less; that was not
measured. The totals below use OpenRouter.

### Anything else

The rustls config (28 KB, round 1) is the only other shared state found. No
provider tokenizer is on disk: the only `tokenizer.json` files are for the
all-MiniLM-L6-v2 embedding model, which no provider uses, so none was
measured.

### Totals for 8 and 110 delegates (macOS arm64, footprint)

Each total is the root session plus N delegate sessions. Every session has a
200 KB conversation, an SQLite connection, the extension set loaded from
bytecode with debug info kept, and round 1's other parts.

Per-session parts, in KB:

- round 1 session in a thread, shared TLS config: 577
- round 1 session as its own process: 2,005
- round 1's 5 KB Lua script, replaced by the extension set: minus 89
- extension set, per state: 1,536
- shared bytecode, once per process that keeps it: 703
- OpenRouter catalog, once per process: 6,256
- MCP set, once per set: 104,448

A delegate as threads adds 577 − 89 + 1,536 = 2,024 KB. The root process
costs 2,005 − 89 + 1,536 + 6,256 = 9,708 KB, and a delegate process costs the
same. With threads, the root also keeps the 703 KB of bytecode to load new
states.

| Design | Formula, KB | N=8 | N=110 |
|---|---|---|---|
| Threads, no MCP | 9,708 + 703 + N × 2,024 | 26.0 MiB | 227.6 MiB |
| Threads, MCP | 9,708 + 703 + 104,448 + N × 2,024 | 128.0 MiB | 329.6 MiB |
| Processes, no MCP | (N + 1) × 9,708 | 85.3 MiB | 1,052.3 MiB |
| Processes, MCP in every process | (N + 1) × (9,708 + 104,448) | 1,003.3 MiB | 12,374.3 MiB |
| Processes, MCP owned by the root | 9,708 + 104,448 + N × 9,708 | 187.3 MiB | 1,154.3 MiB |

Per delegate, that is 2.0 MiB as threads, 9.5 MiB as a process, and 111.5 MiB
as a process with its own MCP servers.

The threads-with-MCP row assumes one MCP set serves every delegate. That
holds for quotabar. It holds for cursor-delegate only if every call names its
worktree, and it would not hold for a server that reads roots. A delegate in
another worktree then needs its own instance of that server in every design.

With 2 MiB conversations, add 3,523 KB per session to every row. With the
models.dev catalog instead of OpenRouter, add 45,952 KB per process: once for
threads, N + 1 times for processes.

### Conclusion of round 2

Shared state widens the gap that round 1 found. Without MCP, a delegate costs
about 2 MiB as threads and about 9.5 MiB as a process, because each process
parses its own model catalog (6.1 MiB) and pays its own process overhead
(1.4 MiB). At 110 delegates that is 228 MiB against 1,052 MiB.

MCP servers dominate if each delegate process starts its own. The owner's two
daily servers use 102 MiB together, so 110 delegate processes would use about
12 GiB. If the root owns the MCP servers and delegates reach them through the
root, most of that goes away: 1,154 MiB at 110 delegates.

Extensions do not favour either design. Lua 5.4 cannot share compiled code
between states, so each session pays about 1.5 MiB for the extension set
either way.

The catalog is the part to watch. Parsed as generic JSON it takes 8 to 11
times its size on disk. Holding it once in the root, or in a smaller typed
form, stops it multiplying with the number of processes.

Linux has not been measured.
