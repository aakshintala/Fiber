# Benchmarks and binary size


Startup latency benchmarks live in `benchmarks/` and run as the `bench` job of `ci.yml` on pull requests that select the full CI pipeline.

```bash
./benchmarks/startup.sh            # full run (100 iterations, builds ReleaseSafe, needs hyperfine)
./benchmarks/startup.sh --quick    # quick run (20 iterations)
```

The job builds a ReleaseSafe binary, measures the startup path plus `help`, `status --json`, `doctor --json`, and `sessions --json` with hyperfine, and enforces per-command latency budgets. A pull request that exceeds a budget fails the check. Budgets are absolute, so no baseline from `main` is needed and none is stored.

The startup benchmark uses `FIBER_BENCH=1`, an environment variable that runs through arg parsing and CLI dispatch, then exits before TTY initialization. This lives in `src/core/app/app_entry_runtime.zig`.

Current raw wall-clock contract:

* Linux CI: 2ms for every command
* Non-Linux local runs: informational raw means

The Linux CI runner is the authoritative product budget. Local macOS process
and dynamic-loader floors vary enough to exceed 2ms independently of fiber, so
local runs report raw means without assigning a substitute product budget. The
process baseline is diagnostic only and is never subtracted.

When adding features, consider their impact on startup latency. The `fiber help` path is the baseline cold-start benchmark.

## Peak resident memory

The same `bench` job measures peak RSS for the six heavy workloads from the
PGSO corpus and fails when one exceeds its budget:

| workload | measured peak | budget |
| --- | ---: | ---: |
| file-index-100k | 18.36 MiB | 40 MiB |
| ui-activity | 2.23 MiB | 8 MiB |
| approval-transcript | 13.91 MiB | 32 MiB |
| approval-diff | 4.31 MiB | 12 MiB |
| approval-payload | 10.05 MiB | 24 MiB |
| approval-combined | 16.77 MiB | 40 MiB |

Measured peaks are macOS arm64 ReleaseSafe medians across three runs (spread
under 0.05 MiB per workload). Every budget is at least 2x the measured peak,
leaving headroom for Linux runner variance. Reproduce locally with:

```bash
python3 benchmarks/measure_memory.py   # builds benches, writes benchmarks/results/memory.json
python3 benchmarks/check_budgets.py    # enforces latency and memory budgets
```

Measurement uses `getrusage(RUSAGE_CHILDREN).ru_maxrss` from the Python
standard library, which reports bytes on macOS and kilobytes on Linux, so no
GNU time dependency is needed. Enforcement is Linux-only, matching the latency
gate: local runs report peaks as informational. The job summary lists the
per-workload table.

## Binary size observability

Every pull request that selects the full CI pipeline runs the `binary-size`
job of `ci.yml` across Linux
x86_64, Linux arm64, and macOS arm64. Each matrix job builds the pull
request merge commit and its base commit as stripped ReleaseSafe binaries on
the same native runner, then reports the exact byte and MiB delta plus ELF or
Mach-O section changes.

Each platform check is informational. An increase of at least 52,429 bytes
(0.050000 MiB) emits a warning and retains that platform's binaries for
investigation, but does not reject the pull request. Investigate notable
unexplained growth before changing the threshold. The full macOS arm64 PGSO
release qualification remains authoritative for the 7.800 MiB production
ceiling and performance gates.

