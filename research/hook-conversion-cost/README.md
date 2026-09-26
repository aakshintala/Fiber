# Hook conversion cost

Answers one question for
[Hook points: what a hook can see and change](https://github.com/aakshintala/fiber/issues/48):
what it costs to hand a tool result or a model request to a Lua hook and take
its answer back. The path is the one Fiber would use: a Rust value becomes a
Lua table through mlua's serde support, the hook rewrites it, and the table
becomes a Rust value again.

Re-run with `./measure.sh`. The table is macOS arm64 (Darwin 25.6.0, rustc 1.98.1,
mlua 0.12 with vendored Lua 5.4). Sizes generalise; timings do not. Linux results
are below.

The hook is a redaction: `string.gsub` of a token pattern over every text part.
Each row is the median of 200 iterations after 20 warmup iterations, in one
process.

| value | JSON size | to Lua | hook | to Rust | total |
|---|---|---|---|---|---|
| tool result, 16 KiB content (default cap) | 16 KiB | 2 µs | 68 µs | 3 µs | 73 µs |
| tool result, 1 MiB content (artifact-sized) | 1036 KiB | 18 µs | 4124 µs | 34 µs | 4177 µs |
| model request, 200 messages | 66 KiB | 134 µs | 238 µs | 233 µs | 606 µs |
| model request, 1000 messages | 317 KiB | 647 µs | 1104 µs | 1144 µs | 2915 µs |

What it shows:

- Conversion is not the cost. A 16 KiB result crosses into Lua and back in
  under 10 µs; the redaction itself is 68 µs. Even a 1 MiB result, the size of
  a full artifact, converts in about 50 µs and spends 4 ms in `gsub`.
- A request is more expensive to convert than a result of the same size,
  because it is many small tables rather than one string: about 1 µs per
  message each way. A 1000-message request costs about 3 ms per model call,
  and that is paid on every step if a hook runs per request.
- Nothing here approaches the interrupt deadline or a model round trip.

The model request rows are for comparison only. `docs/prompt-cache.md` rules
out a hook that rewrites a message the model has already been sent, so no
per-request hook exists to pay this.

## Linux results

Measured for [#16](https://github.com/aakshintala/fiber/issues/16) on GitHub-hosted
`ubuntu-24.04` (AMD EPYC 7763) and `ubuntu-24.04-arm` (Neoverse-N2) runners, rustc
1.98.1, on September 26, 2026. Raw output is in `linux/`. Totals, median of 200:

| value | macOS arm64 | x86_64 musl | x86_64 glibc | arm64 musl | arm64 glibc |
|---|---:|---:|---:|---:|---:|
| tool result, 16 KiB | 73 µs | 210 µs | 152 µs | 141 µs | 116 µs |
| tool result, 1 MiB | 4177 µs | 10892 µs | 9207 µs | 7733 µs | 6959 µs |
| model request, 200 messages | 606 µs | 1858 µs | 1266 µs | 1296 µs | 1095 µs |
| model request, 1000 messages | 2915 µs | 9165 µs | 6213 µs | 6400 µs | 5496 µs |

The shared runners are about twice as slow as the M3 Pro. musl, the shipped target,
is 11% to 48% slower than glibc. The conversion columns slow down most, because
they allocate heavily and musl's allocator is slow: the 1 MiB result takes 627 µs
to reach Lua on x86_64 musl against 57 µs on glibc. The hook column is 4% to 29%
slower. The conclusion holds: every row stays small next to a model turn.

Replacing musl's allocator with mimalloc or jemalloc brings musl to glibc's speed,
at 30 to 40 times the RSS with parked threads. See "Replacing musl's allocator" in
`research/concurrency/README.md`.
