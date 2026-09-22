# Pass-1 results

Three platforms. macOS arm64 (Darwin 25.6.0, 16 KiB pages) locally; Linux
x86_64 and Linux aarch64 (both 6.17.0-1022-azure, 4 KiB pages) via the
temporary workflow in `.github/workflows/extension-runtime-pass1.yml`.

Re-run with `./measure.sh`.

## Structural results: identical on all three platforms

| | Lua 5.4 | Luau | QuickJS |
|---|---|---|---|
| Deadline stops a bare infinite loop | yes | yes | yes |
| Deadline survives `pcall` / `try-catch` | **no** | yes | yes |
| Survives adversarial retry-the-catch loop | only with staged hook | yes, naive | yes |
| One interpreter per thread, moved across threads | yes | yes | yes |
| Script error: host survives, interpreter reusable | yes | yes | yes |
| Unbounded recursion: host survives | yes | yes | yes |
| Unbounded allocation against a cap: host survives | yes | yes | yes |
| `io` / `os` / `package` / `debug` reachable | no | no | n/a |
| Reads files from disk | no | **yes, `require`** | no |

Lua 5.4's `pcall` escape reproduces on all three platforms. It is a property of
the mechanism - mlua's `set_hook` raises an ordinary Lua error, and `pcall`
catches ordinary Lua errors - not a platform artifact.

The staged mitigation (`interrupt_escalate`: cheap hook normally, re-arm to
every-instruction from inside the hook once the deadline passes) holds on all
three, against `while true do pcall(function() while true do end end) end`.

## Memory reclaim: the platforms disagree

RSS in KiB, after hitting an 8 MiB cap and running two full collections.

| Runtime | Platform | before | peak | after GC | reclaimed |
|---|---|---:|---:|---:|---|
| Lua 5.4 | macOS arm64 | 2016 | 12816 | 12816 | **no** |
| Lua 5.4 | Linux x86_64 | 3052 | 11408 | 5428 | yes |
| Lua 5.4 | Linux arm64 | 2492 | 10848 | 4872 | yes |
| Luau | macOS arm64 | 3216 | 14240 | 14256 | **no** |
| Luau | Linux x86_64 | 5876 | 14196 | 6472 | yes |
| Luau | Linux arm64 | 5192 | 13396 | 5672 | yes |
| QuickJS | macOS arm64 | 2256 | 11456 | 11456 | **no** |
| QuickJS | Linux x86_64 | 3620 | 12164 | 12168 | **no** |
| QuickJS | Linux arm64 | 2848 | 11392 | 11396 | **no** |

**On Linux, Lua and Luau return memory to the OS and QuickJS does not.** On
macOS none of them do. This is allocator behaviour, not runtime behaviour, and
it is invisible on the development machine. It is the single result that
justified running the Linux pass.

## Enforcement cost

Same 2M-iteration integer loop, five runs, steady state after warmup. "Armed"
means the deadline mechanism is installed but has not fired.

| Runtime | Platform | clean | armed | overhead |
|---|---|---:|---:|---:|
| Lua 5.4 (hook n=1000) | macOS arm64 | 5.6 ms | 8.2 ms | +46% |
| Lua 5.4 (hook n=1000) | Linux x86_64 | 9.1 ms | 22.5 ms | **+147%** |
| Lua 5.4 (hook n=1000) | Linux arm64 | 7.2 ms | 17.7 ms | **+146%** |
| Luau (interrupt) | macOS arm64 | 7.4 ms | 17.6 ms | +137% |
| Luau (interrupt) | Linux x86_64 | 12.6 ms | 37.6 ms | +199% |
| Luau (interrupt) | Linux arm64 | 10.7 ms | 42.7 ms | +300% |
| QuickJS (interrupt) | macOS arm64 | 31.2 ms | 31.6 ms | **+1%** |
| QuickJS (interrupt) | Linux x86_64 | 67.6 ms | 68.2 ms | **+1%** |
| QuickJS (interrupt) | Linux arm64 | 58.9 ms | 58.9 ms | **+0%** |

Lua 5.4's hook overhead is 3x worse on Linux than on macOS, on the platform
that carries the usage weight. QuickJS's interrupt is free everywhere.

Lua 5.4 at every-instruction (the escalated state, only after a deadline has
already passed) costs 370-440 ms on Linux against a 7-9 ms baseline.

Absolute speed is not a decision axis - a provider's hot path is HTTPS and SSE,
not an integer loop - but the *overhead ratios* are, because enforcement is
always on.

## Platform differences worth knowing

- QuickJS reports a proper `Error: out of memory` on Linux; on macOS the
  exception is a bare null and the message is unusable.
- QuickJS stays usable after OOM on Linux, and is unusable until the cap is
  lifted on macOS. Either way a host would discard the interpreter.
- Idle RSS runs higher on Linux for Luau (5.2-5.9 MiB vs 3.2 on macOS) despite
  Linux's smaller pages.
