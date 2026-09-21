# Concurrency benchmarks (issue #8)

The `research/` directory holds small measurement programs that answered a specific design question and are kept so the numbers can be re-run later. Fiber’s real usage weight is on Linux, and none of these have been run there yet; Linux is where you should re-run before trusting timings. This is not Fiber’s own performance benchmark suite (those will live under `benchmarks/` when they exist) and it is not a place for design documents.

These programs answer whether Fiber can hold concurrent streaming work (SSE body, tty, file writes, background jobs) without an async runtime, with idle CPU comparable to a parked `std::thread`, and what cancellation and HTTP client choices look like in that model.

Every timing and CPU number in `results/` was measured on **macOS arm64 only** (Darwin 25.6.0, Apple M3 Pro, 11 logical CPUs, rustc 1.98.1). Linux was not measured — no Docker, podman, or VM was available on the machine that ran them. **Linux is where Fiber’s real usage weight sits; re-run these benchmarks on Linux before treating any of their timings as Fiber’s.** Thread counts, `cargo tree` edges, and whether a crate pulls tokio generalise across platforms; the timings do not.

Full analysis: [issue #8 comment](https://github.com/aakshintala/fiber/issues/8#issuecomment-5756312384).

When a root `Cargo.toml` is added for Fiber itself, list `research/concurrency` in that workspace’s `exclude` so this standalone workspace is not pulled into Fiber’s build.

## What each crate measures

| Crate | Measures |
| --- | --- |
| `measure` | Shared helper: CPU (`getrusage`), threads/RSS (`proc_pidinfo`), wakeups (Mach `TASK_POWER_INFO`). |
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
| `cancel_ureq_connector` | Whether a custom ureq Connector can stash a TcpStream so another thread can shutdown() a blocked body read; chunked decode still works. |
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
