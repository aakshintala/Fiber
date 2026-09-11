# Contributing

This document covers process: how to set up, verify your change, and get it
merged. Product and reference documentation will live under `docs/` once it is
written.

## Scope

Fiber is a command-line coding agent written in Zig. Contributions should keep
that direction:

- command-line first, rather than terminal-IDE behavior
- explicit contracts, rather than ad hoc strings and branches
- permission-first security
- small, reviewable changes
- documentation and status output that describe what exists

## Setup

You need:

- Zig 0.16.0 or later
- an interactive terminal, for manual shell testing
- a ChatGPT subscription session for model-backed work, through
  `fiber auth login codex`

Common commands:

```bash
zig fmt src/
zig build
zig build test
zig build run
```

## Verify your change

Keep the local loop narrow. Run the closest test to the code you changed, build,
then exercise the change with `./zig-out/bin/fiber`.

Always use that binary. A `fiber` on your `PATH` is a different build and is not
valid evidence.

Before you push, run the gate:

```bash
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
```

Read the test output rather than the exit status. `zig build test` can print
`failed command:` and still exit 0.

## Open a pull request

Push your branch and open a draft pull request straight away. A branch with no
pull request runs no continuous integration.

`ci.yml` is the only entrypoint, and what it runs depends on the state of the
pull request:

- a draft runs Linux x86_64 formatting, the public-surface audit, PGSO corpus
  validation, release-decision tests, build, unit tests, smoke, and the four
  Linux x86_64 end-to-end shards
- a ready pull request adds the remaining native platforms, the same four
  end-to-end shards on Linux aarch64 and macOS arm64, benchmarks, binary-size
  comparison, and the isolated MCP conformance package

One check, `CI`, aggregates the result. It is the only check `main` requires.

Marking a pull request ready re-runs everything on the same commit, so the ready
result replaces the draft one. Evidence must come from the current commit; a
passing run on an earlier commit does not count.

If a check fails, that is the answer. Fix the cause in a new commit and let it
run again. Do not rerun a failed test hoping for green.

Keep a ready pull request ready while you fix it. A draft skips the ready-only
jobs, so a fix pushed to a draft is never checked by the job that failed.

The macOS arm64 PGSO candidate workflow does not run on pull requests. If you
change `build.zig` or `scripts/pgso/`, run it by hand with `workflow_dispatch`
on your branch only after the ready run passes — it uses `cancel-in-progress`
on the branch ref, so dispatching earlier just gets cancelled by the next push
— and merge only after it passes. It produces size, behavior, and
performance evidence and changes no release artifact. Its pinned toolchain, local reproduction command,
and failure rules are in
[`scripts/pgso/README.md`](scripts/pgso/README.md).

`main` requires a pull request, a linear history, and resolved review threads.
It blocks force pushes and deletion. Merges are squash only.

## Classify every end-to-end test

Every root `tests/e2e/*.test.ts` file needs an entry in
`scripts/pgso/corpus.json`. Continuous integration rejects missing, duplicate,
stale, and unclassified files.

Choose one of three homes:

- training, for common or performance-sensitive behavior
- verification-only, for correctness, recovery, security, and rare behavior
- excluded, for nondeterministic, live-network, credentialed, sound-related, or
  harness-only coverage, with the reason recorded

Tests added to an existing file inherit its classification. Revisit that when a
feature changes what the file covers, and remove the entry when you delete the
file. A deleted file that keeps its entry, or a restored file that lost one,
both fail the corpus check.

## Repository layout

- `src/main.zig`: composition root only
- `src/core/`: contracts, runtimes, config, sessions, permissions, MCP, skills
- `src/tools/`: built-in tool implementations
- `src/ui/`: terminal rendering, event loop, input, transcript
- `src/gateway/`: model transport
- `scripts/`: build, release, and PGSO tooling
- `benchmarks/`: startup latency benchmarks

## Before you add a feature

Answer these first, and stop to define them if any is unclear:

1. Which module owns the behavior?
2. What is the typed contract?
3. Does it need persistence?
4. Does it need both text and JSON output?
5. What documentation and tests land with it?
6. How is its end-to-end test classified in the PGSO corpus?

## Benchmarks

Startup latency benchmarks run as the `bench` job of `ci.yml` on ready pull
requests. The job builds a ReleaseSafe binary and measures wall-clock time with
[hyperfine](https://github.com/sharkdp/hyperfine) against fixed budgets:

| Command                 | Budget | What it measures                        |
| ----------------------- | ------ | --------------------------------------- |
| `fiber` (startup)       | 2ms    | launch through command dispatch, no TTY |
| `fiber help`            | 2ms    | minimal startup, text output            |
| `fiber status --json`   | 2ms    | config read and JSON serialization      |
| `fiber doctor --json`   | 2ms    | system checks and subprocess spawns     |
| `fiber sessions --json` | 2ms    | session directory read                  |

The check fails if a command exceeds its budget. Budgets are absolute, so no
baseline from `main` is stored or needed.

This table is the Linux continuous integration contract. Local runs on other
systems report raw means without a substitute budget, because the host process
and dynamic loader can exceed 2ms on their own. The process baseline is
diagnostic and is never subtracted.

To run them locally:

```bash
brew install hyperfine             # macOS, one time
./benchmarks/startup.sh            # 100 iterations, builds ReleaseSafe
./benchmarks/startup.sh --quick    # 20 iterations
```

Results are written to `benchmarks/results/`, which is not tracked.

## Releases

Fiber publishes no releases yet. The version is `0.0.1-dev`, and `release.yml`
refuses to publish any prerelease, so merging to `main` cannot cut a release.
There is no installation or upgrade path, and building one is tracked as an
issue.

When a stable release does happen, the workflow owns it. On a push to `main` it
reads the version from `src/main.zig`. If that version is stable and its tag is
missing, it cross-compiles the platform binaries, creates the tag, and publishes
a GitHub Release. The release body is the content between the
`<!-- release:start -->` and `<!-- release:end -->` markers in `CHANGELOG.md`.

Never create a version tag by hand.

Release notes are public product copy. Describe what a user can observe, spell
the product Fiber, and leave out contributor attribution, tracker references,
infrastructure work, continuous integration and test detail, branch history, and
refactors with no visible outcome. Use commits and pull requests as research,
not as copy. Formatting rules are in [`docs/releasing.md`](docs/releasing.md).

## Future work

Anything worth doing later belongs in a GitHub issue, not in a planning file in
this repository.

## Working with upstream

Fiber was forked from [fx](https://github.com/vercel-labs/fx). That remote is
fetch-only.

Read upstream for ideas and reimplement anything worth taking under Fiber's
current contracts, with attribution. Never merge or cherry-pick upstream
history: the fork diverged deliberately, and those commits carry back the
identity, release machinery, and distribution Fiber removed.

## Agents

If you are an agent working in this repository, read [AGENTS.md](AGENTS.md). It
covers the same process plus the code style, architecture, and verification
rules you are held to.
