# Concurrency benchmarks (issue #8)

The `research/` directory holds small measurement programs that answered a specific design question and are kept so the numbers can be re-run later. This is not Fiber’s own performance benchmark suite (those will live under `benchmarks/` when they exist) and it is not a place for design documents.

These programs answer whether Fiber can hold concurrent streaming work (SSE body, tty, file writes, background jobs) without an async runtime, with idle CPU comparable to a parked `std::thread`, and what cancellation and HTTP client choices look like in that model.

The files directly under `results/` were measured on macOS arm64 (Darwin 25.6.0, Apple M3 Pro, 11 logical CPUs, rustc 1.98.1). `threads_scale`, the three `mini_*` programs and `cancel_ureq_connector` were also run on Linux x86_64 and Linux arm64 (issue #16). Those results are in `results/linux/` and summarized in [Linux results](#linux-results-issue-16). Thread counts, `cargo tree` edges, and whether a crate pulls tokio generalise across platforms; the timings do not.

Full analysis: [issue #8 comment](https://github.com/aakshintala/fiber/issues/8#issuecomment-5756312384).

When a root `Cargo.toml` is added for Fiber itself, list `research/concurrency` in that workspace’s `exclude` so this standalone workspace is not pulled into Fiber’s build.

## What each crate measures

| Crate | Measures |
| --- | --- |
| `measure` | Shared helper: CPU (`getrusage`). macOS: threads/RSS (`proc_pidinfo`), wakeups (Mach `TASK_POWER_INFO`). Linux: threads/RSS (`/proc/self/status`), context switches summed over every thread. |
| `sse_server` | Tiny HTTP/1.1 server for chunked streaming and hang tests (library, not a bench binary). |
| `idle_std` | One thread blocked on `mpsc::recv`, no runtime. |
| `threads_scale` | N parked threads on `mpsc::recv`; idle CPU/wakeups/RSS vs thread count and stack size. |
| `idle_tokio_mt` | Multi-thread tokio parked on `pending()` plus an unused channel. |
| `idle_tokio_ct` | Current-thread tokio parked on pending work on a dedicated driver thread. |
| `idle_tokio_io` | Multi-thread tokio with an idle TCP `read` on the reactor. |
| `idle_tokio_sleep` | Multi-thread tokio with a 24-hour `sleep` on the time driver. |
| `idle_smol` | Smol `block_on(pending())`. |
| `idle_async_std` | async-std parked on `pending()`. |
| `idle_polling` | One thread in `polling::Poller::wait(None)` on a silent pipe. |
| `idle_poll16` | `Poller::wait(Some(16ms))` loop (frame-timer shape without a tty). |
| `tui_idle` | Blocking TUI shape: crossterm event thread, hanging HTTP read, render on `mpsc`. |
| `tui_poll16` | Ratatui-style `event::poll(16ms)` loop. |
| `cancel_tcp` | Latency to unblock `read()` via `TcpStream::shutdown` from another thread. |
| `cancel_timeout` | Latency to escape `read()` with `SO_RCVTIMEO` plus a cancel flag. |
| `cancel_http_ureq` | Whether ureq’s body read can be cancelled; owned-socket control path. |
| `cancel_ureq_connector` | Whether a custom ureq Connector can stash a TcpStream so another thread can shutdown() a blocked body read, over HTTP and HTTPS, 20 times each; chunked decode still works. |
| `http_ureq` | Chunk arrival times streaming with ureq (rustls). |
| `http_attohttpc` | Chunk arrival times with attohttpc (tls-rustls). |
| `http_minreq` | minreq `send()` vs `send_lazy` streaming behavior. |
| `http_isahc` | Chunk arrival times with isahc (libcurl). |
| `http_rustls` | Blocking rustls `StreamOwned` client; chunk arrival times. |
| `mini_blocking` | Same mini harness on `std::thread` + blocking `TcpStream` (SSE stream + subprocess + fsync log + cancel). |
| `mini_smol` | Same mini harness on smol. |
| `mini_tokio` | Same mini harness on multi-thread tokio. |

Raw measurement copies from the macOS run live under `results/`.

## How to re-run

From this directory (`research/concurrency/`):

```text
cargo build --release -p idle_std -p idle_tokio_mt -p idle_tokio_ct -p idle_tokio_io -p idle_tokio_sleep -p idle_smol -p idle_async_std -p idle_polling -p idle_poll16 -p tui_idle -p tui_poll16
IDLE_SECS=60 SETTLE_SECS=3 ./target/release/idle_tokio_mt
cargo run -p http_ureq
CANCEL_ITERS=40 cargo run --release -p cancel_tcp
cargo tree -p http_ureq -i tokio
```

Idle windows use the release binaries. HTTP arrival timestamps use debug binaries. Cancellation latencies use release binaries. For other idle crates, use `IDLE_SECS=60 SETTLE_SECS=3 cargo run --release -p <name>`.

## Linux results (issue #16)

Linux does not weaken [ADR 0004](../../docs/adr/0004-blocking-threads-no-async-runtime.md). Parked threads cost less idle CPU than on macOS and never context-switch. The three `mini_*` programs still differ by almost nothing. A read blocked inside ureq unblocks in under 0.2 ms over TLS as well as plain HTTP.

The shipped Linux binaries are static musl (`docs/releasing.md`), so every program ran on the musl target. The glibc target ran beside it, because musl's memory allocator is the known performance risk. Results are one CI run on September 26, 2026.

Hosts: GitHub-hosted `ubuntu-24.04` (AMD EPYC 7763, 4 vCPUs) and `ubuntu-24.04-arm` (Neoverse-N2, 4 vCPUs), kernel 6.17, glibc 2.39, rustc 1.98.1. These are shared virtual machines, so timings are noisy. RSS, sizes, thread counts and context switches are more reliable than microseconds. `linux-probe/` holds the script and workflow that produced the files in `results/linux/`.

### Parked threads

`threads_scale`, 10-second idle window, default stack. CPU is milliseconds over the window. RSS is MiB at the end of the window.

| threads | macOS arm64 | x86_64 musl | x86_64 glibc | arm64 musl | arm64 glibc |
|---:|---|---|---|---|---|
| 1 | 0.12 ms, 1.6 MiB | 0.05 ms, 0.5 MiB | 0.04 ms, 2.2 MiB | 0.05 ms, 0.5 MiB | 0.05 ms, 1.8 MiB |
| 32 | 0.08 ms, 2.2 MiB | 0.03 ms, 0.6 MiB | 0.04 ms, 2.6 MiB | 0.04 ms, 0.7 MiB | 0.03 ms, 2.3 MiB |
| 128 | 0.16 ms, 4.1 MiB | 0.05 ms, 1.2 MiB | 0.06 ms, 3.6 MiB | 0.07 ms, 1.2 MiB | 0.05 ms, 3.2 MiB |
| 512 | 0.35 ms, 11.4 MiB | 0.16 ms, 3.2 MiB | 0.11 ms, 7.5 MiB | 0.18 ms, 3.2 MiB | 0.14 ms, 7.2 MiB |

What it shows:

- Every run counted one context switch across all threads in the window: the measuring thread waking up. The parked threads switched zero times. One x86_64 musl run counted 2.
- The 60-second check that `docs/performance.md` gates on also reached one context switch, from the measuring thread: `idle_std` and 32 parked threads, both on musl, both architectures (`idle60_musl.txt`).
- musl uses less than half glibc's RSS at every thread count.
- A 64 KiB stack changed nothing on musl or on x86_64 glibc. On arm64 glibc it raised 512 threads from 7.2 MiB to 9.2 MiB.

Reading every thread's `/proc` status file costs CPU: 13 ms for 512 threads on x86_64. `measure` excludes that from the window and prints it as `snapshot_cpu_us`.

### The same program three ways

`mini_blocking`, `mini_smol` and `mini_tokio`, medians of three runs. Every run on every platform took 0.50 s and delivered all 10 events.

| | macOS arm64 | x86_64 musl | x86_64 glibc | arm64 musl | arm64 glibc |
|---|---|---|---|---|---|
| blocking: stripped, peak RSS, cancel | 517 KB, 1.9 MiB, 88 µs | 681 KB, 1.9 MiB, 90 µs | 556 KB, 2.4 MiB, 103 µs | 660 KB, 1.6 MiB, 163 µs | 529 KB, 2.0 MiB, 173 µs |
| smol | 862 KB, 2.2 MiB, 42 µs | 993 KB, 1.7 MiB, 36 µs | 878 KB, 2.5 MiB, 35 µs | 989 KB, 1.6 MiB, 30 µs | 858 KB, 2.2 MiB, 21 µs |
| tokio | 915 KB, 2.5 MiB, 27 µs | 1062 KB, 1.9 MiB, 71 µs | 939 KB, 3.2 MiB, 71 µs | 1053 KB, 1.6 MiB, 123 µs | 922 KB, 2.3 MiB, 112 µs |

The ordering holds: blocking is the smallest binary, and the gap to tokio stays about 400 KB. musl binaries are about 120 KB larger than glibc ones, because they carry libc. On musl all three programs peak within 0.3 MiB of each other. Cancel latency varies run to run by up to 100 µs, which is noise at this scale.

### Cancelling a read blocked inside ureq, including over TLS

`cancel_ureq_connector`, median of 20 cancellations. The HTTPS server runs in-process with a self-signed certificate, and ureq's rustls stack sits between the blocked read and the socket.

| | macOS arm64 | x86_64 musl | x86_64 glibc | arm64 musl | arm64 glibc |
|---|---:|---:|---:|---:|---:|
| HTTP | 68 µs | 109 µs | 65 µs | 103 µs | 73 µs |
| HTTPS | 67 µs | 174 µs | 95 µs | 154 µs | 102 µs |

Closing the stashed socket unblocks the read over TLS on every platform. Each read returned `Peer disconnected`. The chunked stream still arrived decoded. The macOS figures are in `results/cancel_ureq_connector_macos.txt`.

### musl against glibc

musl is slower wherever a program allocates a lot of memory, and uses less RSS. The ureq cancel is 1.4 to 1.8 times slower on musl. The Lua hook conversion (`research/hook-conversion-cost/linux/`) is 11% to 48% slower on musl, depending on the row. musl uses less than half glibc's RSS for parked threads, and 0.4 to 1.3 MiB less peak RSS in the `mini_*` programs. No measured slowdown reaches a millisecond on a per-event path.

### Replacing musl's allocator

Replacing musl's allocator with mimalloc or jemalloc removes the slowdown, but costs 30 to 40 times the RSS with parked threads. musl's own allocator uses the least memory of the four in every test. ripgrep uses jemalloc on its musl builds, but ripgrep does not hold hundreds of parked threads.

`linux-probe/allocators.sh` built `threads_scale` and the Lua hook conversion benchmark four ways, as one CI run on September 26, 2026: musl with its own allocator, musl with mimalloc 0.1.52, musl with jemalloc (`tikv-jemallocator` 0.7.0), and glibc with its own allocator. Results are in `results/linux/allocators/`. jemalloc did not build for arm64 musl: its `configure` found no atomics through Ubuntu's `musl-gcc` wrapper.

Parked threads, RSS in MiB at the end of a 10-second idle window, x86_64:

| threads | musl | musl + mimalloc | musl + jemalloc | glibc |
|---:|---:|---:|---:|---:|
| 1 | 0.6 | 4.7 | 10.9 | 2.2 |
| 32 | 0.7 | 10.8 | 97.1 | 2.6 |
| 128 | 1.2 | 31.2 | 101.0 | 3.6 |
| 512 | 3.2 | 116.8 | 119.8 | 7.5 |

arm64 matches: musl 3.2 MiB, mimalloc 112.8 MiB and glibc 7.2 MiB at 512 threads. mimalloc adds about 225 KiB per thread. jemalloc jumps to 97 MiB by 32 threads, one arena per thread up to its arena limit. Every Rust thread allocates when it starts, so this is the least a thread costs under each allocator, not the most.

Lua hook conversion, median of three runs:

| | musl | musl + mimalloc | musl + jemalloc | glibc |
|---|---:|---:|---:|---:|
| x86_64: tool result, 16 KiB | 212 µs | 148 µs | 145 µs | 152 µs |
| x86_64: model request, 1000 messages | 8799 µs | 5858 µs | 5924 µs | 6139 µs |
| x86_64: peak RSS | 6.2 MiB | 29.3 MiB | 11.1 MiB | 9.1 MiB |
| arm64: tool result, 16 KiB | 140 µs | 115 µs | | 116 µs |
| arm64: model request, 1000 messages | 6443 µs | 4855 µs | | 5406 µs |
| arm64: peak RSS | 6.0 MiB | 29.1 MiB | | 8.6 MiB |

mimalloc and jemalloc run as fast as glibc, about 30% faster than musl's allocator. The time saved is under 3 ms on the largest request. mimalloc also adds about 150 KB to the stripped binary, and jemalloc about 470 KB.

Both allocators ran with default settings. Tuning, such as fewer jemalloc arenas or no per-thread caches, was not tried.
