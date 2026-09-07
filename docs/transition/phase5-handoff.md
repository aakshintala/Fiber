# Handoff: Phase 5, after the first E2E measurement

Written 2026-09-06. Phase 4 is closed; this is the state of Phase 5 after its
opening measurement, first repairs, and first delegation.

## Where you are

```
  main              993688a5 [origin/main]   the fork point, and the PR base
* transition-main   07a93f89                 177 commits, all transition work
  ticket02-runaway-reference cacbf093        2 orphan commits, deliberately kept
```

One worktree, `/Users/<you>/work/fiber`, on `transition-main`. All Phase 5
work continues there; a PR to `main` opens at the end of the transition.
**Do not push to `origin/main`.** Pushing any other branch triggers Full CI.

## Read these, in order

1. `phase5-baseline.md` and `phase5-baseline.tsv` — every case that passed at the
   fork point, harvested from the last green upstream CI run before its logs
   expire around 2026-12-01. This is the phase's exit oracle.
2. `phase5-triage.md` — what the first full local run found, and the three root
   causes it resolves to.
3. `plan.md`, Phase 5 — the original scope, including the 16 session-recovery
   cases and the TUI state-transition matrix.
4. `phase5-delegate-brief-example.md` — the brief that produced two good commits
   from a delegate for $0.17. Reuse its shape.

## The measurement

macOS arm64, ReleaseSafe, serial, no retry: **961 cases, 684 failing (71%), 254
passing, 23 skipped, across 51 files**, in 212 minutes. Every one of those passed
at the fork point.

**Two holes in that number.** Four files hit a 900-second cap and produced no
result at all — `tui-composer-edit-contracts`, `tui-decision-prompts`,
`tui-gateway-stream-lifecycle`, `tui-resume` — so their whole baseline
contribution currently lands in the diff's DISAPPEARED bucket and inflates it.
Thirteen more ran against a Debug binary after a stray `zig build` replaced
ReleaseSafe mid-run; their results are void. Both sets need re-running before any
DISAPPEARED count means anything.

## The finding that shapes the phase

**684 failures are not 684 problems.** Three causes account for roughly 280 of
them, and none is a defect in the product:

1. **The fake Gateway no longer authenticates.** Every test driving `fiber ask`
   through one gets `MissingCredentials` — Fiber is Codex-only and
   `FX_GATEWAY_BASE_URL` no longer satisfies the credential check. Largest
   cluster in the suite.
2. **`mcp list` no longer opens transports**, so every assertion about connection
   state fails. Deliberate; `mcp doctor` is the deferred replacement.
3. **The identity rename overflowed a Unix socket path.** `fx` to `fiber` added
   six characters to a path that fit under macOS's 104-byte limit by one. The
   product correctly takes its hashed-fallback path; the test only knows the old
   location.

Triage by signature, never by case. And note the pattern is a finding rather than
a rule: the next cluster may be a real defect, and the point of the phase is to
be able to tell.

## Repair queue

| Work | Cases | Files | Notes |
| --- | --- | --- | --- |
| fake-gateway to fake-codex | ~150+ | shared `startFakeGateway` / `fixtureEnv` helpers | Highest leverage. `764533fa` did this for one file and stopped; `web-search-fake-codex.test.ts` is the template |
| `terminal-host` endpoint | 54 | `terminal-host.test.ts` | Fully diagnosed. The test must resolve the hashed fallback the way `host.zig:120` does, or use a short HOME |
| `mcp list` renderer | — | `src`, then tests | Owner decided: stop printing fields it cannot fill. Source change first |
| `mcp-http`, `mcp-auth` | ~74 | those two files | **Blocked** behind the renderer change, or the assertions get written twice |
| `mcp-stdio` remainder | ~74 | `mcp-stdio.test.ts` | Heterogeneous, lower confidence |
| session-recovery rebuild | 16 | new | Spec transcribed in `plan.md`; approach already decided |
| TUI state-transition matrix | 7 scenarios | new | See the fuzzing entry in `../enhancements/pending.md` — a generator covers this space better than seven cases |

Done so far: the two out-of-`src` Zig fixtures compile again, and `cli.test.ts`
is 84 pass / 1 skip / 0 fail, down from 59 failures.

## Running the suite

```sh
./docs/transition/phase5-census.sh <outdir>          # full census, ~3.5h while red
python3 docs/transition/phase5-diff.py <outdir>/results.tsv macos-aarch64
```

Iterate on single files instead; a full census is a checkpoint, not a gate.

```sh
cd tests/e2e
TMUX_TMPDIR=/tmp/fr-$$ bun test --max-concurrency 1 \
  --reporter=junit --reporter-outfile=/tmp/out.xml ./cli.test.ts
```

**Failing runs are far slower than passing ones.** The helpers poll a predicate
every 25ms against a deadline, so a pass returns in milliseconds and a failure
burns the full 15 seconds. 212 minutes now, ~40 at the fork point, and the gap
closes as you repair.

## Traps, each of which has already cost this project time

- **`TMUX_TMPDIR` must be short.** Unix sockets cap near 104 bytes; a long temp
  dir fails with `File name too long` and every tmux test dies looking like a
  product bug.
- **bun 1.4 hides passing tests.** The console prints only failures. Use
  `--reporter=junit` whenever you need to know what passed. This silently voided
  one run and was baked into `phase5-census.sh` until `07a93f89`.
- **Never run bare `zig build`.** It produces a Debug binary at
  `zig-out/bin/fiber` and silently replaces the ReleaseSafe one the suite is
  using. Always `-Doptimize=ReleaseSafe`.
- **`zig build test` prints `failed command:` while exiting 0.** Grep the output.
- **`git add -A` sweeps up other agents' untracked files.** It committed two
  scripts nobody reviewed, in `290efbdd`. Stage by path.
- **`--max-concurrency 1` is a no-op.** No test uses `test.concurrent`, so bun
  runs them sequentially regardless. The real serialization is CI's file loop.

## CI

Full CI runs on push to any branch except `main`, 3 platforms x 4 shards. The
first run of the transition lost 10 of 12 shards to the 120-minute cap, because
the per-file retry doubles a broadly-red suite. `8d12b338` added a
`retry_failed` dispatch input (default true) and raised the cap to 240 minutes.

**Dispatch with `retry_failed: false` for any run while the suite is red.** A
push cannot set it; only `workflow_dispatch` can.

`ci.yml` still names the deleted `session-recovery.test.ts` at line 134 and will
fail on it. Nothing guards that list. Unfixed.

## Delegation

One delegate produced two clean commits for $0.17 and did better than the brief
asked. What worked, from `phase5-delegate-brief-example.md`:

- Name the files, the case counts, and the failure clusters by `describe` block.
- State the one rule as a rule: **never edit `src/` to make a test pass.** Give
  it an escape hatch — a `FINDINGS.md` for anything it cannot classify — so the
  honest move is cheaper than the dishonest one.
- List the traps explicitly. It hit none of them.
- Give the verification command, and say to run only its own files.
- Say not to push.

**Verify the work rather than the claim.** The useful check for "did it weaken
assertions" is the ratio of exact to fuzzy matchers before and after: weakening
shows up as `toBe` falling while `toContain` and `toMatch` rise. Here everything
shrank proportionally with the three deleted tests, and each deletion named a
slice and pointed at behaviour I confirmed is gone.

## Open decisions

- **Publishing.** `origin/main` is still the fork point, 177 commits behind.
- **`ticket02-runaway-reference`** holds 2 unmerged commits, superseded work plus
  abandoned debug scratch. Kept because a ref is free.
- **Sharding and parallelism.** 4 shards is under-provisioned but the ceiling is
  the heaviest file (289s green). Running multiple files concurrently on one
  machine is the better lever and nothing prevents it — but not while the suite
  is red, since contention manufactures the flakes a baseline must not have.
