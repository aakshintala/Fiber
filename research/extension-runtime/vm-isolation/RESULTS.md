# VM granularity and Lua 5.4 vs 5.5

Two decisions for the extension-runtime ADR, settled with measurement (macOS arm64).

## How many extensions per Lua VM?

`iso54`/`iso55`: N extensions as N separate `Lua` states vs one state with N
per-extension `_ENV` tables (metatable `__index` -> shared `_G`; writes rawset on
the private env). Isolation verified: each env keeps its own globals, nothing
leaks to shared `_G`, retained tables are distinct objects.

| N | separate VMs | one VM + per-_ENV |
|---:|---:|---:|
| 1 | 2176 KiB | 2192 KiB |
| 8 | 3136 KiB | 2464 KiB |
| 32 | 6016 KiB | 2928 KiB |

Separate VMs cost ~120 KiB/extension (a second Lua state reuses the mapped
liblua code, adds only its own heap) - not the ~2 MiB feared. Shared+_ENV is
~23 KiB/extension. At realistic N (<~12) the gap is < 1 MiB.

**Decision: separate VM per extension, lazily instantiated.** Memory is trivial
at realistic N, and separate states give per-extension memory caps
(`set_memory_limit` is per-state), separate GC, no builtin-repoint bleed, and
crash containment - none of which a shared VM offers without extra machinery.
Shared+_ENV is the documented fallback if a session ever loads dozens of
extensions and memory tightens.

## Lua 5.4 vs 5.5

Streaming workload (pass-2), peak RSS:

| instances | 5.4 | 5.5 |
|---:|---:|---:|
| 1 | 3056 KiB | 2960 KiB |
| 4 | 3424 KiB | 3328 KiB |
| 16 | 4896 KiB | 4896 KiB |

0-3%, identical at 16. Peak RSS here is retention-bound, so 5.5's incremental
major GC (a pause-latency / floating-garbage win) does not show. Latency is
irrelevant on an I/O-bound provider hot path.

**Decision: Lua 5.4.** 5.5's advantages don't convert on Fiber's workload; its
cost is far less model training mass (pass-3 made authoring the tie-relevant
axis) and less maturity, on a hard-to-reverse choice.
