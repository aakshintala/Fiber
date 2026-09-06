# Phase 5 E2E baseline: the fork point

The transition ran four phases without ever executing the end-to-end suite, by
decision. This file is the missing measurement, harvested rather than
reconstructed. It is the oracle Phase 5's exit criterion is checked against.

## Provenance

`vercel-labs/fx` Full CI run **33592954041**, the head commit `a7111dbb` of
[PR 575](https://github.com/vercel-labs/fx/pull/575), 2026-09-02. All 24 jobs
succeeded. Harvested from the run log on 2026-09-06 by
[`phase5-harvest.py`](phase5-harvest.py), which reads `##[group]<file>:` markers
for file attribution and `(pass|fail|skip) <name>` lines for cases, taking the
last status per case so a retry's pass supersedes the original failure.

**It is the PR head, not the fork point.** Fiber forked at `4308bd43`, whose
parent is PR 575's merge commit `993688a5`. That merge commit's own CI was
**cancelled**, and `full-ci.yml` carries `branches-ignore: main`, so no merge to
main ever gets a Full CI run. `a7111dbb` is the closest green run, one merge
away. Anything else that landed on main between the PR branching and its merge
is not covered here.

**The source log expires.** GitHub retains run logs 90 days; this one goes around
2026-12-01. That is the reason the harvested data is committed rather than
re-fetched on demand.

## What it says

1,366 unique cases across 59 files, per platform:

| | pass | skip | fail |
| --- | --- | --- | --- |
| macos-aarch64 | 1297 | 69 | 0 |
| linux-x86_64 | 1297 | 69 | 0 |
| linux-aarch64 | 1297 | 69 | 0 |
| macos-x86_64 | 1297 | 69 | 0 |

The suite was green and stable. One file needed the CI retry across all 220
file-runs: `tui-permissions.test.ts` on macos-x86_64, which passed on the second
attempt. macos-x86_64 is not a Fiber target.

**So Phase 5 inherits no red.** Every failure the local run produces is caused by
the transition or superseded by one of its decisions. Nothing is "broken
already". This is a stronger criterion than `plan.md`'s "no failure signature is
new against the opening baseline" and replaces it.

12 cases legitimately differ across the three supported platforms — Keychain
cases that skip on Linux, and `fork`/binary-replacement cases that skip on macOS.
Each is recorded per platform in the TSV rather than collapsed.

## The data

[`phase5-baseline.tsv`](phase5-baseline.tsv), one row per case:

```
status  platforms  file  case
```

`status` is a single value when the three supported platforms agree, otherwise
`macos-aarch64=…;linux-x86_64=…;linux-aarch64=…`. macos-x86_64 is excluded
throughout: Fiber does not target it.

## Reading it against a local run

54 of the 59 files still exist, carrying 1,218 baseline cases. Five files are
gone and each deletion has a named commit:

| File | Cases | Removed by |
| --- | --- | --- |
| `acp.test.ts` | 111 | ACP deletion, Phase 1 Slice 23 |
| `web-search-fake-gateway.test.ts` | 17 | `764533fa`, which added `web-search-fake-codex.test.ts` in its place |
| `session-recovery.test.ts` | 16 | ACP deletion; the 16 cases are transcribed in `plan.md` and Phase 5 rebuilds them |
| `oauth-keychain-migration.test.ts` | 2 | `e0a5625c`, dormant provider credential and keychain paths |
| `web-search-live.test.ts` | 2 | `b286b323`, Gateway-backend live search |

`web-search-fake-codex.test.ts` is the only file with no baseline row.

**A case name present here and absent from a local run is the finding that
matters.** It resolves three ways: deleted on purpose (the table above),
renamed by the Phase 2 identity cutover or a Phase 3 contract change, or lost
silently. The third is what no other gate in this transition can catch, and it
is the reason the diff is by case name rather than by count.

Expect renames. Case names contain the product name, `fx ask` and `fx logout`
among them, so a naive diff reports the whole identity cutover as disappearances.
Match on the normalized name before treating one as lost.
