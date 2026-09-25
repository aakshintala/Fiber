# Hook conversion cost

Answers one question for
[Hook points: what a hook can see and change](https://github.com/aakshintala/fiber/issues/48):
what it costs to hand a tool result or a model request to a Lua hook and take
its answer back. The path is the one Fiber would use: a Rust value becomes a
Lua table through mlua's serde support, the hook rewrites it, and the table
becomes a Rust value again.

Re-run with `./measure.sh`. **macOS arm64 only** (Darwin 25.6.0, rustc 1.98.1,
mlua 0.12 with vendored Lua 5.4). The Linux run belongs to
[#16](https://github.com/aakshintala/fiber/issues/16). Sizes generalise;
timings do not.

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
