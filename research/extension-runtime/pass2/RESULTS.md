# Pass-2 results: streaming-provider RSS

Workload: N interpreters, each holding a provider extension that parses a
realistic 2000-delta Anthropic SSE transcript (`../transcript.sse`), filters
text deltas, and accumulates the message across 50 turns, then goes idle.
Idiomatic JSON per runtime (Lua/Luau serde via `LuaSerdeExt`, QuickJS native
`JSON.parse`). `verify=ok` on every run: output matches `../expected.txt`.

Re-run with `./measure.sh`. macOS arm64 local; Linux x86_64 + arm64 via CI.

## Peak RSS (KiB)

| inst | runtime | macOS arm64 | Linux x86_64 | Linux arm64 |
|---:|---|---:|---:|---:|
| 1 | Lua 5.4 | 3040 | 3572 | 2884 |
| 1 | Luau | 4336 | 6728 | 5860 |
| 1 | QuickJS | 3664 | 4500 | 3784 |
| 4 | Lua 5.4 | 3456 | 3924 | 3300 |
| 4 | Luau | 6928 | 8248 | 7488 |
| 4 | QuickJS | 4928 | 5812 | 5100 |
| 16 | Lua 5.4 | **4800** | **5416** | **4780** |
| 16 | Luau | 16512 | 14332 | 13676 |
| 16 | QuickJS | 10144 | 11020 | 10328 |

## Two costs, both against Luau

**Fixed baseline** (rss_start, one process, before work): Lua 2.4-3.0 MiB,
QuickJS 2.5-3.1, **Luau 4.3-5.6**. Luau pays a VM+sandbox tax once per process.

**Per-instance marginal** (Linux x86_64, (peak-start)/16): Lua ~150 KiB,
QuickJS ~500, Luau ~540. Lua 5.4 is ~3x leaner than either at scale, on every
platform. macOS exaggerates Luau's marginal cost (~870 KiB); Linux does not, but
Luau is still the heaviest overall on both terms.

## Bearing on the decision

Premise 2 allows several concurrent sessions, so both terms are paid per live
interpreter. On the efficiency axis the owner prioritises, **Lua 5.4 wins
decisively, QuickJS is the middle, Luau is last** - which reverses the earlier
lean toward Luau on the strength of its pass-1 safety story. Luau now has to
overcome a real memory penalty to stay in contention.

## Not yet measured

- JSON strategy variants (`ondemand` host-parses, hand-rolled visitor). Only the
  idiomatic path is wired. These could move Lua/Luau but not the QuickJS native
  baseline.
- The per-frame renderer shape (high call frequency, retained cache), where
  pass-1's enforcement-overhead differences would surface.
- Reclaim under an allocate-then-free burst (pass-1 tested this via OOM; this
  workload does not).
