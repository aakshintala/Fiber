# 4. Blocking threads, no async runtime

Date: 2026-09-21

## Status

Accepted. Settled by
[The threading and streaming model](https://github.com/aakshintala/fiber/issues/9).
The contract is the concurrency section of `docs/architecture.md`.

## Context

Fiber has to stream a model response off a socket, run tool subprocesses
alongside it, append to a log with an fsync on the critical path, draw a
terminal, and let a person cancel all of it mid-stream. Rust offers two ways
to write that: plain blocking `std::thread`, or an async runtime.

Idle CPU does not decide it. A parked tokio runtime costs the same idle CPU as
a parked `std::thread` (0.114 ms against 0.122 ms over 60 s,
[#8](https://github.com/aakshintala/fiber/issues/8)). Dependency graph size and
thread count needed measuring too.

Three measurements decided what the argument could rest on. All were run on
macOS arm64 (Darwin 25.6.0, Apple M3 Pro, rustc 1.98.1) and **none of them has
been run on Linux**, which by premise 9 carries the usage weight.

**Parked threads are cheap at any count Fiber will reach.**
`research/concurrency/threads_scale`, 10-second idle windows: 1 thread 1.6 MiB
RSS, 32 threads 2.3 MiB, 128 threads 4.2 MiB, 512 threads 11.6 MiB and 0.35 ms
of CPU, at 0.1 wakeups per second. A 64 KiB stack changed nothing, because RSS
counts committed pages rather than reserved stack. "One parked thread per
blocking thing" therefore survives every MCP server, background job and child
session v0.0.1 could plausibly have. This removed thread count as an argument.

**The same program, written three ways, differs by almost nothing.**
`research/concurrency/mini_blocking`, `mini_smol` and `mini_tokio` each stream
a response, run a subprocess alongside it, fsync per event, and take a
cancellation that interrupts the in-flight read. Medians of three runs:

| | stripped binary | peak RSS | wall | cancel | crates | SLOC |
|---|---:|---:|---:|---:|---:|---:|
| blocking threads | 517 KB | 2.03 MB | 506 ms | 88 µs | 2 | 132 |
| smol | 862 KB | 2.33 MB | 502 ms | 42 µs | 34 | 137 |
| tokio | 915 KB | 2.57 MB | 502 ms | 27 µs | 15 | 133 |

400 KB is 2% of a 20 MiB budget, the cancel latencies are three orders of
magnitude below human perception, and the wall times are identical because the
work is I/O. The line counts came out within five lines of each other, so
"easier to write" had no measured winner either. Two incidental findings: smol
pulls more crates than tokio, not fewer; and async-std is discontinued —
crates.io describes it as "Deprecated in favor of smol".

**Cancellation does not require writing an HTTP client.** #8 concluded that
escape-cancels-a-request "requires Fiber to own the `TcpStream`", because ureq
exposes no way to interrupt a blocked read. `research/concurrency/cancel_ureq_connector`
shows that ureq 3.4's custom-connector API gives Fiber the socket handle while
ureq keeps doing HTTP, chunked decoding and TLS: a thread stuck in ureq's body
reader returned 211 µs after another thread closed the socket, with the stream
still arriving decoded. Plaintext only — the test server has no TLS, so the
HTTPS path is inferred.

So the numbers do not decide it. Three things that are not performance do.

**Most of Fiber's blocking work is threads underneath in every design.**
tokio's own source says `tokio::fs` "will use ordinary blocking file
operations behind the scenes... using the `spawn_blocking` threadpool", and
"currently, Tokio will always use `spawn_blocking` on all platforms".
crossterm's async `EventStream` spawns a thread and wakes a future from it. Of
Fiber's four blocking activities, only the model socket is genuinely async; a
runtime wraps the other three rather than removing them.

**The design is already synchronous by decision.** `docs/architecture.md` on
the hook seam: "Synchronous: the loop stops, asks, waits and honours the
answer, under a timeout Fiber enforces." One turn at a time, one writer per
session, and `loop` as the only module that decides what happens next. The
overlap an async runtime is good at is overlap three earlier tickets chose not
to have.

**The two styles fail differently, and one failure is invisible.** Calling
something blocking from inside an async task stalls the executor for the
duration. It compiles, it passes tests, and it surfaces as the screen
stuttering while a tool runs. Fiber is unusually exposed to it: `mlua` is
synchronous, the hook seam is synchronous by contract, and fsync is on the
critical path by decision. The blocking equivalent — a deadlock or a missed
join — is a hang with a stack trace naming the function, which a gate with a
timeout catches and a delegate can fix. Fiber's Rust is written by delegates
and checked by gates, so which bugs a gate can catch is a first-order concern.

## Decision

**Fiber uses blocking `std::thread` and no async runtime.** HTTP is ureq over
rustls, behind a custom connector that keeps the `TcpStream` handle so a second
thread can close the socket to cancel a read.

## Consequences

Every "wait for whichever of these happens first" is written by hand with a
channel rather than with `select!`. Cancelling a read means handing a socket
clone to a second thread before the read starts, which is the one place the
blocking implementation is fiddlier than the async one, and that pattern
recurs in background jobs, subagents and MCP. This is accepted, not
overlooked.

The argument that would reopen this is a Linux measurement contradicting the
macOS ones, or a v0.0.1 requirement to hold enough concurrent sockets that
thread-per-socket stops being free. Neither is an argument from taste, and
neither is available today.
