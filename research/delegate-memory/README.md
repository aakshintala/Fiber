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
