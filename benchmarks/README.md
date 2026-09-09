# Benchmarks and binary size


Startup latency benchmarks live in `benchmarks/` and run as the `bench` job of `ci.yml` on ready pull requests.

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

## Binary size observability

Every ready pull request runs the `binary-size` job of `ci.yml` across Linux
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

