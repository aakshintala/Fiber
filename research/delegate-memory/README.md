# Delegate memory: threads or processes

This note answers [#76](https://github.com/aakshintala/fiber/issues/76): how
much resident memory a delegate costs as threads in its parent's process,
compared with running as its own process. It feeds the open question on
[#21](https://github.com/aakshintala/fiber/issues/21).

Numbers come from three platforms, and every table names its platform:

- macOS arm64: Apple M3 Pro, 18 GiB, macOS 26.6.2, rustc 1.98.1, release
  build
- Linux x86_64: GitHub Actions `ubuntu-latest`, 4 vCPUs, 16 GiB, Ubuntu with
  kernel 6.17 (Azure), glibc 2.39, rustc 1.98.1, release build
- Linux arm64: GitHub Actions `ubuntu-24.04-arm`, the same except the CPU

## The probe

The probe is a throwaway Rust program in
[`probe/`](probe/): `src/main.rs`, `measure.sh`, `grid.sh` (round 1),
`round2.sh` and `fetch.sh` (round 2), and `mcp/mcp_measure.py`. Raw macOS
output is in `probe/results/` and `probe/mcp/`. The Linux numbers come from a
temporary GitHub Actions workflow on the `research/delegate-memory-2` branch:
run 35927424303 for both rounds' grids, and run 35928420729 for the MCP
servers. Their raw output is in `probe/results/linux-*`.

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
measured 2 seconds after every session reported ready. On macOS the whole
grid ran twice. The runs agree within 1%; the tables use the second run. On
Linux it ran once on each runner.

On macOS the probe reports `phys_footprint` (from `footprint <pid>`), which is
what macOS charges a process. It counts private dirty and compressed memory,
not shared code pages. On Linux it reports PSS from `/proc/<pid>/smaps_rollup`,
which splits each shared page between the processes that map it, so PSS sums
to the real total. RSS counts shared pages in every process, so summing RSS
across processes overstates the real cost. Process-mode totals exclude the
launcher, which sits at the idle baseline. Footprint and PSS are different
measures, so compare designs within a platform rather than across platforms.

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

## Results (Linux)

Stripped binary: 4.1 MB on x86_64 (4,060,720 bytes), 3.7 MB on arm64
(3,690,112 bytes).

Idle process with nothing initialised: 1.1 MiB PSS and 3.0 MiB RSS on x86_64,
0.9 MiB PSS and 2.3 MiB RSS on arm64.

### Total PSS, MiB

| Conversation | Mode | Platform | N=1 | N=10 | N=110 | Per session, N=10 to 110 |
|---|---|---|---|---|---|---|
| 200 KB | threads, shared TLS config | Linux x86_64 | 3.8 | 9.3 | 68.8 | 609 KB |
| 200 KB | threads, shared TLS config | Linux arm64 | 3.5 | 9.0 | 68.9 | 613 KB |
| 200 KB | threads, TLS config per session | Linux x86_64 | 3.8 | 9.4 | 70.1 | 623 KB |
| 200 KB | threads, TLS config per session | Linux arm64 | 3.5 | 9.1 | 70.3 | 627 KB |
| 200 KB | processes | Linux x86_64 | 3.4 | 11.8 | 95.5 | 857 KB |
| 200 KB | processes | Linux arm64 | 3.1 | 11.1 | 92.6 | 835 KB |
| 2 MiB | threads, shared TLS config | Linux x86_64 | 6.9 | 40.6 | 413.6 | 3,820 KB |
| 2 MiB | threads, shared TLS config | Linux arm64 | 6.7 | 40.3 | 413.7 | 3,823 KB |
| 2 MiB | threads, TLS config per session | Linux x86_64 | 6.9 | 40.7 | 414.9 | 3,833 KB |
| 2 MiB | threads, TLS config per session | Linux arm64 | 6.7 | 40.4 | 415.1 | 3,836 KB |
| 2 MiB | processes | Linux x86_64 | 6.5 | 43.1 | 440.2 | 4,065 KB |
| 2 MiB | processes | Linux arm64 | 6.3 | 42.4 | 437.2 | 4,043 KB |

A single process has a lower PSS than a single thread-mode session because it
shares its code pages with the idle launcher.

### Total RSS, MiB

| Conversation | Mode | Platform | N=1 | N=10 | N=110 | Per session, N=10 to 110 |
|---|---|---|---|---|---|---|
| 200 KB | threads, TLS config per session | Linux x86_64 | 5.8 | 11.3 | 72.2 | 623 KB |
| 200 KB | threads, TLS config per session | Linux arm64 | 5.0 | 10.6 | 71.8 | 627 KB |
| 200 KB | processes | Linux x86_64 | 5.8 | 57.9 | 638.7 | 5,947 KB |
| 200 KB | processes | Linux arm64 | 5.0 | 50.3 | 552.7 | 5,145 KB |
| 2 MiB | threads, TLS config per session | Linux x86_64 | 8.9 | 42.7 | 416.9 | 3,832 KB |
| 2 MiB | threads, TLS config per session | Linux arm64 | 8.2 | 41.9 | 416.5 | 3,836 KB |
| 2 MiB | processes | Linux x86_64 | 8.9 | 89.4 | 983.0 | 9,150 KB |
| 2 MiB | processes | Linux arm64 | 8.2 | 81.6 | 897.2 | 8,352 KB |

### Each component's cost per session (Linux, PSS)

| Component | Linux x86_64 | Linux arm64 |
|---|---|---|
| Conversation, 2 MiB | 3,557 KB | 3,558 KB |
| Conversation, 200 KB | 350 KB | 350 KB |
| SQLite connection | 135 KB | 135 KB |
| Lua state with a 5 KB script | 91 KB | 91 KB |
| rustls config, built per session | 14 KB | 15 KB |
| rustls config, shared through `Arc` | under 1 KB | under 1 KB |
| Blocked thread | 11 KB | 11 KB |

RSS per component matches PSS to within 1 KB on Linux.

## What is shared and what is duplicated

A separate process adds about 1.4 MiB of footprint per delegate on macOS
(2,005 KB against 606 KB, and 5,227 KB against 3,789 KB). That is the process
itself: dirty data segments, dynamic loader state, allocator zones and
metadata, the main thread's stack and page tables. Threads in one process pay
it once.

On Linux a separate process adds much less: about 230 KB of PSS on x86_64
(857 KB against 623 KB) and 210 KB on arm64 (835 KB against 627 KB). glibc
did not raise the thread-mode cost: a thread-mode session costs about the same
on Linux as on macOS.

The code pages are shared either way. The operating system maps them once, so
they appear in each process's RSS but not in its footprint, and PSS splits
them between processes. That is why summed RSS for processes is 5 to 6 MiB per
process on Linux.

The rustls config is the only session component that threads can share and
processes cannot. It is 14 to 28 KB, so sharing it saves little.

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
against processes once conversations are large.

On Linux the gap is smaller: about 230 KB of PSS per process on x86_64 and
210 KB on arm64. At 110 sessions with 200 KB conversations, processes use
96 MiB against 70 MiB for threads on x86_64, and 93 MiB against 70 MiB on
arm64.

## Round 2: state one process can share

The sections above measure only what each session owns. This round measures
the state that delegates running as threads in one process can share, and
that separate processes each hold their own copy of: MCP servers, compiled
extension code and a provider model catalog.

The platforms and measures are the same as above: footprint on macOS arm64,
PSS on the two Linux runners. The probe gained two modes, `luaset` and
`json`, plus `round2.sh`, `fetch.sh` and `mcp/mcp_measure.py`.

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
measured its whole process tree. On macOS, two runs agreed to within 100 KB.

| Server | Footprint, macOS arm64 | RSS, macOS arm64 | Tools | Tied to a workspace |
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

On Linux, quotabar and cursor-delegate were cloned from their public GitHub
repositories (ClaudeBar at 7dc3517, cursor-delegate at 0d94e2c), installed
with `npm ci`, and run under Node 24 (24.21.0 on x86_64, 24.20.0 on arm64).
They need no secrets to start and list tools. node_repl ships only inside the
macOS ChatGPT app, so it was not measured on Linux. Four measurements over
two CI runs agreed to within 3 MiB; the figures are the first measurement of
the second run.

| Server | Platform | PSS | RSS | Anonymous |
|---|---|---|---|---|
| quotabar | Linux x86_64 | 93.3 MiB | 97.0 MiB | 46.9 MiB |
| quotabar | Linux arm64 | 91.6 MiB | 94.3 MiB | 46.3 MiB |
| cursor-delegate | Linux x86_64 | 79.3 MiB | 82.9 MiB | 34.2 MiB |
| cursor-delegate | Linux arm64 | 76.4 MiB | 79.1 MiB | 32.5 MiB |

A lone instance's PSS on Linux includes about 45 MiB of pages read from the
Node binary and its libraries. A second copy of the same server shares those
pages, so it adds roughly its anonymous memory (its private heap and stacks).
macOS footprint already leaves such shared pages out.

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
servers the owner runs every day through Claude Code and pi:

- macOS arm64: 104,448 KB (102.0 MiB) footprint for each set
- Linux x86_64: 176,785 KB (172.6 MiB) PSS for the first set, and 83,040 KB
  (81.1 MiB) anonymous for each further set
- Linux arm64: 172,054 KB (168.0 MiB) PSS for the first set, and 80,752 KB
  (78.9 MiB) anonymous for each further set

#### Remeasured on 2026-09-26

The owner's daily set changed after the rows above were measured. quotabar
now runs as a Claude Code hook with no process of its own. cursor-delegate is
a Rust binary (`aakshintala/cursor-delegate` at 3ad0683, 736 KB). Three
running instances, each serving a live session, measured with `footprint` on
macOS arm64: 1,200 to 1,264 KB footprint and 1,120 KB RSS each. Linux was not
measured.

The daily set is therefore one server of about 1.2 MiB, against 102 MiB for
the Node pair. With it, the "Processes, MCP in every process" formula below
gives about 96 MiB for 8 delegates on macOS, where the Node pair gave
1,003 MiB.

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
1,450,042 bytes on every platform. Measured with N states in one process,
slope from N=10 to N=40, footprint on macOS and PSS on Linux:

| How each state loads the set | macOS arm64 | Linux x86_64 | Linux arm64 | Held once per process |
|---|---|---|---|---|
| Compile the source | 1,809 KB | 1,681 KB | 1,684 KB | 508 KB of source, freed after loading |
| Load shared bytecode, debug info kept | 1,536 KB | 1,597 KB | 1,600 KB | 703 KB of bytecode |
| Load shared bytecode, debug info stripped | 1,263 KB | 1,321 KB | 1,321 KB | 506 KB of bytecode |

Lua 5.4 cannot share compiled functions between states. Loading bytecode
still builds a private copy of every function prototype, constant and string
in each state. So sharing bytecode saves only the parser's leftover heap
(about 270 KB per state on macOS, 85 KB on Linux) and, if stripped, debug
information such as line numbers (a further 270 KB on every platform). A
separate process gets the same saving by loading the same bytecode from a
file and freeing the buffer. The extension set costs about 1.5 MiB per session
in both designs, on every platform.

mlua's `Lua` cannot be called from several threads at once. By default it is
not `Send`. With mlua's `send` feature it is `Send + Sync`, but every call
takes a reentrant mutex (`src/types/sync.rs`), so calls from several threads
wait for each other. Each session therefore needs its own Lua state, unless
every hook call from every session runs one at a time on one Lua thread.

### Provider model catalog

OpenRouter's public model list (`https://openrouter.ai/api/v1/models`, 457
models, about 750 KB) parsed into one `serde_json::Value`, measured above the
idle process:

- macOS arm64: 6,256 KB footprint (file fetched 2026-09-23, 749,714 bytes)
- Linux x86_64: 5,797 KB PSS (fetched in CI, 751,032 bytes)
- Linux arm64: 5,864 KB PSS (fetched in CI)

That is about 8 times its size on disk.

The models.dev catalog is about 11 times its size parsed the same way: on
macOS, opencode's cached copy (`~/.cache/opencode/models.json`, 4,796,203
bytes) costs 52,208 KB footprint. On Linux, `https://models.dev/api.json`
fetched in CI costs 52,223 KB PSS on x86_64 and 52,244 KB on arm64. Parsing
into typed structs, or holding only the providers in use, would cost less;
that was not measured. The totals below use OpenRouter.

### Anything else

The rustls config (14 to 28 KB, round 1) is the only other shared state found. No
provider tokenizer is on disk: the only `tokenizer.json` files are for the
all-MiniLM-L6-v2 embedding model, which no provider uses, so none was
measured.

### Totals for 8 and 110 delegates

Each total is the root session plus N delegate sessions. Every session has a
200 KB conversation, an SQLite connection, the extension set loaded from
bytecode with debug info kept, and round 1's other parts. Figures are
footprint on macOS and PSS on Linux.

Parts, in KB:

| Part | macOS arm64 | Linux x86_64 | Linux arm64 |
|---|---|---|---|
| Round 1 session in a thread, shared TLS config (t) | 577 | 609 | 613 |
| Round 1 session as its own process (p) | 2,005 | 857 | 835 |
| Round 1's 5 KB Lua script, replaced by the extension set (l) | 89 | 91 | 91 |
| Extension set, per state (x) | 1,536 | 1,597 | 1,600 |
| Shared bytecode, kept by the root with threads (b) | 703 | 703 | 703 |
| OpenRouter catalog, once per process (c) | 6,256 | 5,797 | 5,864 |
| MCP set, first copy (m) | 104,448 | 176,785 | 172,054 |
| MCP set, each further copy (m2) | 104,448 | 83,040 | 80,752 |

A delegate as threads (T) adds t − l + x. The root process, and each delegate
process (P), costs p − l + x + c.

| Platform | T | P |
|---|---|---|
| macOS arm64 | 577 − 89 + 1,536 = 2,024 | 2,005 − 89 + 1,536 + 6,256 = 9,708 |
| Linux x86_64 | 609 − 91 + 1,597 = 2,115 | 857 − 91 + 1,597 + 5,797 = 8,160 |
| Linux arm64 | 613 − 91 + 1,600 = 2,122 | 835 − 91 + 1,600 + 5,864 = 8,208 |

| Design | Formula, KB | Platform | N=8 | N=110 |
|---|---|---|---|---|
| Threads, no MCP | P + b + N × T | macOS arm64 | 26.0 MiB | 227.6 MiB |
| | | Linux x86_64 | 25.2 MiB | 235.9 MiB |
| | | Linux arm64 | 25.3 MiB | 236.7 MiB |
| Threads, MCP | P + b + m + N × T | macOS arm64 | 128.0 MiB | 329.6 MiB |
| | | Linux x86_64 | 197.8 MiB | 408.5 MiB |
| | | Linux arm64 | 193.3 MiB | 404.7 MiB |
| Processes, no MCP | (N + 1) × P | macOS arm64 | 85.3 MiB | 1,052.3 MiB |
| | | Linux x86_64 | 71.7 MiB | 884.5 MiB |
| | | Linux arm64 | 72.1 MiB | 889.7 MiB |
| Processes, MCP in every process | (N + 1) × P + m + N × m2 | macOS arm64 | 1,003.3 MiB | 12,374.3 MiB |
| | | Linux x86_64 | 893.1 MiB | 9,977.5 MiB |
| | | Linux arm64 | 871.0 MiB | 9,732.3 MiB |
| Processes, MCP owned by the root | (N + 1) × P + m | macOS arm64 | 187.3 MiB | 1,154.3 MiB |
| | | Linux x86_64 | 244.4 MiB | 1,057.2 MiB |
| | | Linux arm64 | 240.2 MiB | 1,057.8 MiB |

Per delegate, that is about 2 MiB as threads and 8 to 9.5 MiB as a process on
every platform. A delegate process with its own MCP servers costs about
111 MiB on macOS and 87 to 89 MiB on Linux.

The Linux rows that multiply MCP servers assume each further copy shares the
Node binary's pages with the first and costs only its anonymous memory. That
was not measured with several copies running.

The threads-with-MCP row assumes one MCP set serves every delegate. That
holds for quotabar. It holds for cursor-delegate only if every call names its
worktree, and it would not hold for a server that reads roots. A delegate in
another worktree then needs its own instance of that server in every design.

With 2 MiB conversations, add about 3.5 MiB per session to every row
(3,523 KB on macOS, 3,557 KB on Linux). With the models.dev catalog instead
of OpenRouter, add about 45 MiB per process (45,952 KB on macOS, 46,426 KB on
Linux x86_64, 46,380 KB on Linux arm64): once for threads, N + 1 times for
processes.

### Conclusion of round 2

Shared state widens the gap that round 1 found, on every platform measured.
Without MCP, a delegate costs about 2 MiB as threads and 8 to 9.5 MiB as a
process. Most of the difference is the model catalog, which each process
parses for itself (about 6 MiB). At 110 delegates that is about 230 MiB for
threads against 885 to 1,052 MiB for processes.

MCP servers dominate if each delegate process starts its own. The owner's two
daily servers use 102 MiB together on macOS and about 170 MiB for a first copy
on Linux, so 110 delegate processes would use about 10 to 12 GiB. If the root
owns the MCP servers and delegates reach them through the root, most of that
goes away: about 1.1 GiB at 110 delegates on every platform.

Extensions do not favour either design. Lua 5.4 cannot share compiled code
between states, so each session pays about 1.5 MiB for the extension set
either way.

The catalog is the part to watch. Parsed as generic JSON it takes 8 to 11
times its size on disk. Holding it once in the root, or in a smaller typed
form, stops it multiplying with the number of processes.
