# Handoff: Phase 5 E2E repair, first slice

You are fixing end-to-end tests that the Fiber transition broke. Everything you
need is in this worktree. Read this file completely before editing anything.

## Where you are

- **Worktree**: `/private/tmp/fiber-repair`, branch `phase5-repair`, based on
  `642f67ce`. The binary is already built at `zig-out/bin/fiber` and
  `tests/e2e/node_modules` is already installed.
- **Do not push.** A push to any non-main branch triggers Full CI, which would
  cancel a baseline run currently in flight. Commit locally and stop.
- **Do not touch the main checkout** at `/Users/aakshintala/work/fiber`. Another
  session is running the full suite there.

## The one rule that matters

**Never edit `src/` to make a test pass.**

Four phases of transition deliberately changed product behaviour. Most failures
you will see are tests asserting the old behaviour, and the correct fix is to
update the test. But some failures are the transition having broken something
real, and those must not be papered over.

The test is wrong when the difference traces to a recorded decision — a renamed
flag, a changed help string, the `fx` to `fiber` rename, a deleted subcommand.
Update the assertion.

The product is wrong when the binary does something no decision asked for. **Stop,
write it in `FINDINGS.md` in this worktree with the evidence, and move to the
next item.** Do not fix it. Do not delete the test. A test you cannot classify
goes in `FINDINGS.md` too.

If you find yourself deleting an assertion to get green, you have almost
certainly crossed this line.

## Scope: exactly two files

Everything else in `tests/e2e/` is out of scope even if you notice it failing.
Other failures are being triaged separately and overlapping edits will collide.

### Task 1 — `tests/e2e/fixtures/mcp-stdio-dispatcher-driver.zig` (9 cases)

This Zig fixture no longer compiles, so 9 cases in `mcp-stdio.test.ts` fail
before running. Reproduce:

```sh
zig build run-mcp-stdio-dispatcher-e2e
```

Two errors, both caused by Phase 4's Slice 27b (`9d7dc063`, "sweep dead
declarations across the remaining subsystems"):

1. `:393` — `mcp_test_exports` has no member `AccessView`.
2. `:1456` — no member function `startupState` in
   `core.mcp.tool_subscription.State`.

**These deletions were wrong, and understanding why is the point of this task.**
Slice 27b used a declaration scanner that only ever scanned `src/`. Two Zig
files outside `src/` are compiled by `build.zig` — this fixture (`build.zig:100`)
and `tests/json-schema/corpus_runner.zig` (`build.zig:78`). Any declaration
referenced only from those two looked dead to the scanner and was swept.

`startupState` was a one-line accessor returning `self.startup_readiness.current()`,
and the `startup_readiness` field still exists at `tool_subscription.zig:118`.
So the fixture can reach the same value without it. Prefer changing the fixture
over restoring the accessor: the accessor genuinely has no `src/` caller, and
re-adding it re-adds dead code. Apply the same judgement to `AccessView` after
you find what replaced it — `snapshotAccessView` at
`src/core/app/app_mcp_runtime.zig:1758` is the thread to pull.

**Then do the systemic check this exposes.** Those two out-of-`src` files may
reference other symbols Phase 4 swept. Confirm both build:

```sh
zig build run-mcp-stdio-dispatcher-e2e
zig build run-json-schema-corpus
```

Anything else you find there is the same bug class. Fix it the same way and say
so in the commit message.

### Task 2 — `tests/e2e/cli.test.ts` (59 of 88 cases failing)

Stale assertions against the CLI surface. Failures by `describe` block:

| Block | Cases |
| --- | --- |
| `cli: sessions` | 10 |
| `cli: status` | 8 |
| `cli: ask success` | 5 |
| `cli: usage` | 4 |
| `cli: read-only no-create matrix` | 3 |
| `cli: help` | 3 |
| `cli: error handling` | 3 |
| `cli: workspace access` | 2 |
| `cli: removed task and background commands` | 2 |
| `cli: missing durable home` | 2 |
| `cli: doctor` | 2 |
| 5 blocks with 1 each | 5 |

Two known causes, both deliberate:

- **Phase 3 rewrote the command contract.** `ask`'s usage string changed from
  `[--auto|--yolo] ... [--prompt-permissions] [--no-color] [--resume <last|id>]`
  to `[--permission-mode <ask|auto|yolo>] [--model <model-id>] [--effort <level>]
  [--fast] ... [--retry] [--timeout <seconds>]`. The specs in
  `src/builtins/commands.zig` own that text and are the source of truth.
- **Phase 2 renamed the product.** One case asserts the product name appears
  exactly once in help output and now counts 12. That assertion was counting
  `fx`; it needs rethinking, not a bumped number — ask what it was actually
  protecting against.

Work block by block, smallest first. `cli: removed task and background commands`
is a good opener: it asserts deleted subcommands are rejected, so it should be
nearly correct already and will tell you fast whether your setup is sound.

## Verifying

Run only your file. The full suite takes over an hour right now and you do not
need it.

```sh
cd tests/e2e
TMUX_TMPDIR=/tmp/fr-$$ bun test --max-concurrency 1 \
  --reporter=junit --reporter-outfile=/tmp/out.xml ./cli.test.ts
```

Four traps, all of which have already cost this project time:

- **`TMUX_TMPDIR` must be a short path.** Unix sockets cap around 104 characters.
  A long temp directory fails with `error connecting to ... (File name too long)`
  and every tmux test dies in a way that looks like a product bug.
- **bun 1.4 hides passing tests from console output.** The text log shows only
  failures, so `28 pass` with no `(pass)` lines is normal. Use the JUnit XML when
  you need to know what passed.
- **`zig build test` can print `failed command:` while exiting 0.** Grep the
  output; do not trust the exit status.
- **Never retry a test to get it green.** A test that passes on the second run is
  a finding, not a pass. Record it.

After Task 1, `zig build -Doptimize=ReleaseSafe` must still succeed and
`zig build test -Doptimize=ReleaseSafe` must not regress.

## The baseline

`docs/transition/phase5-baseline.tsv` records every case that passed at the fork
point, harvested from the last green upstream CI run. Columns are
`status / platforms / file / case`.

Use it to answer "was this ever passing, and under what name". A case in the
baseline that no longer exists under any name is a case the transition dropped,
which is a finding, not a fix.

**The suite inherited no failures.** Everything red is transition-caused or
superseded by a transition decision. If you find yourself concluding "this was
always broken", you are wrong — write it in `FINDINGS.md` instead.

## Committing

One commit per task, on `phase5-repair`, only after that task's file passes.
Name the task in the subject. Say in the body what you changed and *why the old
assertion was wrong* — a reviewer must be able to tell an updated assertion from
a weakened one without rerunning anything.

Do not merge, push, tag, or open a pull request.

## Done means

1. `zig build run-mcp-stdio-dispatcher-e2e` and `zig build run-json-schema-corpus`
   both succeed.
2. `cli.test.ts` and `mcp-stdio.test.ts` report no failure you have not either
   fixed or written up in `FINDINGS.md`.
3. `zig build test -Doptimize=ReleaseSafe` has not regressed.
4. `FINDINGS.md` lists every failure you deliberately did not fix, with the
   evidence and why.

Report what you did not finish as plainly as what you did.
