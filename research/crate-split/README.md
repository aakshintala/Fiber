# Crate-split benchmark (issue #7)

The `research/` directory holds small measurement programs that answered a specific design question and are kept so the numbers can be re-run later. This is not Fiber’s own performance benchmark suite (those will live under `benchmarks/` when they exist) and it is not a place for design documents.

This benchmark asked whether splitting a Rust binary into a cargo workspace actually scopes compilation and testing, versus keeping the same code in one crate. It generated two equivalent synthetic codebases (~39,000 lines each): Shape A is one package with eight logical modules as `mod`; Shape B is a workspace with one crate per module plus a binary crate. Clean builds, incremental rebuilds, scoped `cargo test -p`, and `cargo --timings` were measured on both.

The two codebases are **not** committed. `python3 generate.py` recreates `shape_a/` and `shape_b/` under this directory (on the order of hundreds of megabytes of source plus any local `target/` trees if you build). Do not check them in.

Every timing in `results/` was measured on **macOS arm64 only** (Darwin 25.6.0, Apple M3 Pro, 11 logical CPUs, rustc 1.98.1). Linux was not measured. **The structural findings generalise to Linux; the seconds do not.** Those findings are: `cargo test -p <crate>` compiles only that crate and its dependencies; a single crate parallelises backend codegen but not its type-checking frontend; a workspace overlaps its own crates’ frontends across CPU cores.

Full analysis: [issue #7 comment](https://github.com/aakshintala/fiber/issues/7#issuecomment-5756970986).

## sccache / rustc wrapper

The machine that ran these measurements had a global `rustc` wrapper (sccache) that rejects incremental compiles. That silently invalidated the first run. `measure.py` invokes cargo through `no_wrapper.sh`, which is an identity wrapper so cargo does not route through sccache. If you re-run elsewhere, check for the same trap (`RUSTC_WRAPPER`, `~/.cargo/config.toml`).

## How to re-run

From this directory (`research/crate-split/`):

```text
python3 generate.py
python3 measure.py
```

`measure.py` writes `results/results.json` and resumes from partial progress if that file already exists. Delete `results/results.json` (or the whole `results/` directory) to measure from scratch. Generated build trees go under `artifacts/` locally; that directory is also not committed.
