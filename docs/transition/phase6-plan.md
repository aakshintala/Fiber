# Phase 6: close the product transition

This plan replaces the earlier Phase 6 draft. Phase 6 ends with the tested
`transition-main` tree squash-merged into protected `main`. It does not publish
`v0.0.1` and does not define the full `v0.0.1` scope.

The transition specification and every other planning document are deleted
before the merge. Work that still matters moves to an owner-approved GitHub
issue. Current operating rules move to `AGENTS.md` or `CONTRIBUTING.md`, not to
a permanent transition archive.

## End state

The transition is closed only when all of these are true:

- `main` contains the final tested `transition-main` tree through a squash PR.
- The version is `0.0.1-dev`, and a push to `main` cannot publish it.
- Automatic upgrade checks default off. `fiber upgrade` fails honestly because
  no release source exists yet.
- Runtime output and current documentation name only commands and behavior that
  exist.
- `AGENTS.md` and `CONTRIBUTING.md` describe the post-transition repository.
- The README is a short, truthful overview. It does not promise installation,
  upgrade, embedding, or product documentation that does not exist.
- One CI workflow owns PR and manual checks and emits one required aggregate
  result.
- A `main` ruleset requires a current PR, the CI aggregate, resolved review
  conversations, and linear history. It blocks force pushes and deletion and
  has no bypass actor.
- Future work exists in approved GitHub issues rather than local planning files.
- `docs/transition/`, `docs/ideas/`, and `docs/enhancements/` are gone. If this
  leaves `docs/` empty, remove it too.
- No `v0.0.1` tag or GitHub Release exists.

## Not part of this phase

Known post-closeout work includes:

- GitHub-based binary installation and a real `fiber upgrade`
- full product documentation under `docs/` and a README index that lands with it
- deliberate `v0.0.1` release preparation, changelog markers, and atomic release
  validation before tag creation

These are known needs, not a complete release plan. Scope `v0.0.1` on `main`
after this transition closes.

The following are candidates for backlog triage, not promised release work:
OpenCode Go, Databricks, additional providers, a C API, builtin customization,
extensions, harness delegation, session traversal, GUI integration follow-ups,
resume image notices, upstream fx harvesting, live-model gates, eval repair, and
harness efficiency measurements.

Phase 6 also does not create a website, hosted documentation, a public roadmap,
a calendar release cadence, a local PGSO reconstruction, a permanent E2E census
script, or a broad design-decision archive.

## Locked operating decisions

- Execute one slice at a time on `transition-main`; never parallelize slices.
- The CI collapse is Slice 1 on purpose. Until it lands, the inherited
  `full-ci.yml` triggers on `push: branches-ignore: [main]` and runs the full
  three-platform matrix on every push to `transition-main`, including
  documentation-only ones. A `push` event runs the workflow files present at the
  pushed commit, so this cannot be fixed by landing CI changes on `main` first;
  only a commit on `transition-main` that deletes `full-ci.yml` stops it.
- Make one commit per slice with `Phase 6, Slice N:` in the subject.
- Do not merge, publish, tag, or change repository rules without the owner action
  required by the relevant checkpoint.
- Open a draft PR after committing this plan. Push each completed slice to that
  PR so the execution trail and remote checks remain visible.
- Routine post-transition PRs may auto-merge without an owner click only when
  they are small, reversible, test-backed implementations of an approved
  contract or existing behavior. They must add no dependency and touch no
  security, permission, authentication, persistence, release, CI, ruleset, or
  public compatibility boundary. Independent standards and spec reviews must
  have no unresolved blocker or concern.
- New behavior, ambiguous defects, scope changes, destructive work, and the
  final transition merge require owner approval.
- GitHub review approvals are not required because agents use the owner's
  account and the owner does not inspect every diff. The PR description records
  the issue or contract, verification, and independent review evidence.
- Keep the `vercel` remote for one-way research. Disable its push URL. Never
  merge or cherry-pick upstream history; reimplement only selected ideas under
  Fiber's current contracts.

## Verification rules

Before editing a slice, list its removal surface, retained invariants, exact
searches, and stop conditions in the working notes. Stop rather than widening a
slice silently.

For slices that change source, tests, build logic, release logic, CI, or delete
transition material, run and report each command and exit status:

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
```

Inspect the unit-test log for `failed command:` even when the command exits 0.
Run the narrowest relevant E2E files for changed output or runtime behavior.
Use only `./zig-out/bin/fiber` for live checks. A source slice is not complete
until the built binary exercises its changed happy path or intended error path
with clean, expected stderr.

Documentation-only slices use exact searches and link checks rather than local
product builds. The final deletion slice still runs the full transition gate
because it removes the process that defines that gate.

A failed required check is evidence. Do not retry it to green. Remote PR jobs
finish all platforms and shards so one run reports the full failure set. A
manual diagnostic run may repeat a failed test for classification, but the
first failure remains a failure.

## Setup checkpoint: commit the plan and open the draft PR

1. Confirm `transition-main` is based on the expected `main` and record both
   commit IDs.
2. Replace the previous untracked Phase 6 draft with this plan and commit it as
   the planning commit. Include `[skip ci]` in the commit message. This commit
   is documentation-only and predates the CI collapse, so without the marker the
   inherited `full-ci.yml` runs the full matrix on it.
3. Make the upstream remote fetch-only:

   ```sh
   git remote set-url --push vercel no-push
   ```

4. Push `transition-main` to `origin` and open a draft squash PR against `main`.
5. Record the PR URL in the execution handoff. Do not enable auto-merge.

Stop if `main` has unexpected commits, the push target is not
`aakshintala/Fiber`, or the PR base is not `main`.

## Slice 1: collapse CI to one workflow with one required aggregate

### Workflow shape

Merge `ci.yml` and `full-ci.yml` into a single `ci.yml` that is the only
top-level PR and manual entrypoint. It receives `workflow_dispatch` and
`pull_request` with explicit activity types
`[opened, synchronize, reopened, ready_for_review]`, and nothing else.
`ready_for_review` is not a default type; without it, marking a PR ready fires
no run and the draft run's light-scope success stays on the head commit as a
satisfied required check. Fold `bench.yml` and `binary-size.yml` in as jobs of
that workflow and delete their separate entrypoints. Keep
`release.yml` separate, and keep `pgso-macos-arm64.yml` callable by
`release.yml` and by `ci.yml`.

A final `aggregate` job runs with `always()`, `needs` every other job in the
workflow, and fails if any need failed or was cancelled. It succeeds when the
needs it did not select were skipped.

`aggregate` names itself by event:

```yaml
name: ${{ github.event_name == 'pull_request' && 'CI' || 'Manual CI' }}
```

`CI` is the only context the `main` ruleset requires. The two names are load
bearing: GitHub matches a required check by name on the head commit and ignores
which event produced it, so a `workflow_dispatch` run against a PR's branch
would otherwise post a satisfying `CI` check. Draft and ready runs share the
`CI` name deliberately, because `ready_for_review` reruns on the same commit and
the later check run supersedes the draft one.

There is no scope classifier, no reusable-module split, and no manual suite
selector. Draft versus ready is the only scope axis:

- Draft `pull_request`: Linux x86_64 formatting, public-surface, PGSO corpus,
  shellcheck, build, unit, and smoke checks.
- Ready `pull_request`: the full deterministic matrix. ReleaseSafe native
  checks and all four E2E shards on Linux x86_64, Linux aarch64, and macOS
  arm64, plus benchmarks, the three-platform ReleaseSafe size comparison, and
  the isolated MCP conformance package.

`pgso-macos-arm64.yml` is not touched. It keeps its own path-filtered
`pull_request` trigger and its `workflow_call` entry for `release.yml`. Its
`paths:` filter is safe because that check is not required, and folding a
macOS-15 qualification run into every ready PR would cost far more than the
duplicate entrypoint saves.
- `workflow_dispatch`: the same jobs as a ready PR, for diagnostics. Its
  aggregate is named `Manual CI`, which the ruleset never accepts.

Guard the heavy jobs with `if: github.event.pull_request.draft == false ||
github.event_name == 'workflow_dispatch'`. `aggregate` is never guarded.

### `main` and branches without a pull request

Neither triggers `ci.yml`. `push` is not an event this workflow accepts.

`main` runs only `release.yml`, which keeps its existing
`push: branches: [main]` trigger. Re-validating `main` after a merge is
redundant under this ruleset: strict up-to-date checks, linear history, and
squash-only merges mean every merge ran the full matrix against current `main`
moments earlier, and the squash commit's tree is that tested tree.

Nothing needs a `main` baseline. `benchmarks/check_budgets.py` enforces
absolute per-command thresholds rather than a delta against history, and
`binary-size.yml`'s comparison already runs inside the PR against
`github.event.pull_request.base.sha`.

Deleting `full-ci.yml`'s `push: branches-ignore: [main]` trigger changes an
existing habit: today a bare branch push runs the full three-platform matrix
with no PR. After this slice a pushed branch is silent until a pull request
exists. That matches the required workflow, where work starts from an issue and
a draft PR, and the draft scope gives faster feedback than the full matrix did.

Do not add a `schedule:` trigger. The only failure a post-merge run catches
that a pre-merge run does not is environment drift, such as a runner image or
toolchain bump breaking an unchanged tree. Add one when that actually happens.

Do not add path filtering. Every PR that is not a draft runs everything. Docs
edits are rare after Slice 6 removes `docs/`, and public-repo CI minutes are
free. If wasted minutes ever cost something, one `git diff --name-only` step
setting a job-level output is the upgrade path; a tested classifier package is
not.

### Cleanup and failure behavior

- Delete `ci.yml`'s `push: branches: [main]` trigger, `full-ci.yml` and its
  `push: branches-ignore: [main]` trigger, `bench.yml`, and `binary-size.yml`
  as the merged entrypoint supersedes them. `release.yml` keeps its own
  `push: branches: [main]` trigger.
- Remove `full-ci.yml`'s `retry_failed` input. Do not rerun a failed PR test to
  green.
- Derive aggregate evidence only from the current run's direct `needs` edges.
  Never query prior workflow or check runs, and never reuse a successful job
  from an ancestor commit.
- Keep matrix `fail-fast` off and let selected jobs finish.
- Keep one `concurrency` group per PR so superseded runs cancel.
- Size growth remains informational; failure to build or produce the size report
  is a CI failure.

### Verification

- Confirm `aggregate` fails when a selected job fails, fails when one is
  cancelled, and succeeds when unselected jobs are skipped. Prove this on the
  draft PR rather than by unit-testing YAML.
- Mark the draft PR ready with no new commit and confirm a fresh full run
  starts and replaces the draft `CI` check on the same commit.
- Dispatch the workflow against the PR branch and confirm its aggregate appears
  as `Manual CI`, not `CI`.
- Run `shellcheck` and any YAML lint the repository already has. Run the
  standard gate.
- Push the slice and inspect the draft PR run. Confirm exactly one workflow
  starts, the draft job set runs, the heavy jobs show as skipped, and
  `aggregate` reports success.
- Confirm `release.yml` still resolves and calls the PGSO workflow, and still
  triggers on a push to `main`.
- Confirm a push to a branch with no open PR starts no workflow run.

Stop if a ready PR can complete without a successful `CI` context from a run
on its own head commit, a `workflow_dispatch` run can produce a context the
ruleset would accept, a draft-scope `CI` result can survive as the satisfying
check after the PR is marked ready, or release can no longer call PGSO.

### Success criteria

- One workflow owns every PR and manual check.
- `aggregate` emits `CI` on pull requests and `Manual CI` on dispatches, `CI`
  is the only required context, and it always reports.
- Marking a PR ready always produces a new full-scope `CI` result.
- Draft PRs get fast Linux-only feedback; ready PRs get all current
  deterministic platform coverage.
- Benchmark, size, corpus, shell, conformance, and PGSO evidence survives the
  merge of the workflows.
- After Slice 2 removes `prepare-release.yml`, `.github/workflows/` contains
  `ci.yml`, `release.yml`, and `pgso-macos-arm64.yml` and nothing else.
- No workflow runs on a `push` except `release.yml` on `main`.

## Repository checkpoint: protect `main`

After Slice 1, temporarily mark the transition PR ready with auto-merge still
disabled. Let the full scope finish, record the actual `CI` context string as
GitHub reports it, and return the PR to draft before Slice 2. Ask the owner
before changing repository rules. Then create an active `main` ruleset with:

- pull requests required
- the `aggregate` job's emitted check required, selected from the actual
  successful check rather than a guessed context string
- strict up-to-date status checks
- resolved review conversations
- linear history
- force pushes and branch deletion blocked
- zero required GitHub approvals
- no bypass actor

Keep repository settings squash-only, auto-merge enabled, and merged-branch
deletion enabled. Do not require signed commits or a merge queue. GitHub does
not provide merge queue support for this user-owned public repository. Strict
checks preserve safety; agents update stale parallel PRs and rerun CI.

Verify the ruleset through the GitHub API. Do not test it with a direct push to
`main`.

## Slice 2: make the transition merge release-safe

### Changes

- Change `src/main.zig` from `0.0.1` to `0.0.1-dev`.
- Update `.github/workflows/release.yml` to accept a SemVer prerelease and emit
  `needed=false` for every prerelease. Stable versions retain the existing
  missing-tag release behavior.
- Add a focused check covering at least a prerelease, an existing stable tag,
  and a missing stable tag. Keep release-decision logic testable outside a live
  publication.
- Delete `.github/workflows/prepare-release.yml`. It is inherited fx machinery
  that sends repository diffs to the Vercel AI Gateway and does not describe
  Fiber's release process.
- Remove the inert `fiber background --json` budget entry from
  `benchmarks/check_budgets.py`. The benchmark driver does not run that deleted
  command.

### Retained invariants

- Stable release versions can still trigger the existing release pipeline.
- `release.yml` still calls the macOS arm64 PGSO workflow and consumes evidence
  from the same run.
- No tag, release, or publication command runs during this slice.

### Exact checks

- Search workflows for `vercel-labs/fx`, `ai-gateway.vercel.sh`, and the deleted
  `background --json` benchmark entry.
- Prove the release decision returns `needed=false` for `0.0.1-dev`.
- Run the standard gate.

Stop if prerelease suppression requires weakening stable release detection, or
if any workflow run attempts to create a tag or release.

### Success criteria

- The transition tree identifies itself as `0.0.1-dev`.
- `release.yml` deterministically skips prereleases.
- The inherited release-preparation workflow and stale budget row are absent.

## Slice 3: make runtime and output claims truthful

### Changes

- Default `auto_upgrade` off in every initialization and settings fallback path.
- Keep the `upgrade` command, but make it return one deterministic unavailable
  error until a release source exists. Remove CDN and selected-channel wording.
- Render upgrade failure through the existing command-failure contract so JSON
  has `ok:false`, `kind`, `error`, and `code`; do not retain an error inside an
  `ok:true` data object.
- Replace every product instruction to run `fiber login codex` with the working
  `fiber auth login codex` command, including status snapshots and E2E
  expectations.
- Remove `update_channel` and `build_channel` from status text and JSON. Fiber
  has no release channels or configured release source. Retain build revision
  provenance.
- Remove the stale `-Dupdate-channel` plumbing from PGSO. Slice 19 deleted the
  build option from `build.zig` but left `build_options.addOption(...,
  "update_channel", "stable")` and every caller, so
  `zig build -Dupdate-channel=stable` now fails with `invalid option`. The
  callers are `scripts/pgso/pipeline.py`, `scripts/pgso/__main__.py`,
  `scripts/pgso/README.md`, `.github/workflows/pgso-macos-arm64.yml`, and the
  assertion in `scripts/pgso/tests/test_pipeline.py`. PGSO has been broken since
  Slice 19; it went unnoticed because that workflow runs only on pull requests
  against its own paths and Phase 5 opened none. Slice 1 surfaced it.
- Keep Ctrl+G consistent with the disabled default: with no producer and
  automatic upgrade disabled, it reports `auto-upgrade is disabled` and leaves
  the session writable. Rewrite the retained E2E comments that claim Phase 6
  will add a producer. Preserve the loopback seam for later focused tests.
- Remove the already-classified dead ACP, fx, Vercel, Gateway-key doctor, and
  SIGINT-restoration comments or fixtures. Preserve generic redaction tokens,
  sample URLs, test isolation variables, the Codex gateway implementation, and
  the `runFx` test helper.
- Rewrite `scripts/smoke.sh`'s transition-only header as the permanent offline
  repository smoke gate without changing its coverage.

### Retained invariants

- The loopback-only upgrade test seam remains available to deterministic tests.
- Saved `auto_upgrade` settings still override the default.
- Successful future upgrade snapshots keep their current text and JSON shape.
- Missing-credential guidance continues to name the Codex subscription and now
  points to a real command.
- Status retains useful build revision data without inventing release channels.
- Ctrl+G remains non-destructive and the composer remains usable.

### Exact checks

Search source, deterministic tests, and current docs for:

```text
fiber login codex
selected release channel
failed to fetch latest version from CDN
failed to fetch checksum from CDN
Sign in with Vercel
use:ai-gateway
fx restores and re-delivers SIGINT
Offline smoke gate for the Fiber transition
update_channel
build_channel
```

In `tests/e2e/tui-resume.test.ts`, search separately for `Phase 6`,
`wires a new producer`, `lands an upgrade producer`, and
`reports no installed upgrade` so line wrapping cannot hide stale claims.

The status and output-contract searches must have no channel-field hits. Any
remaining `update_channel` hits must belong only to build or PGSO provenance,
not user-selectable release behavior.

Run focused upgrade, status, Ctrl+G, CLI, web-fetch permission, and web-search
permission checks, then the standard gate. Exercise `fiber upgrade` in text and
JSON modes with `./zig-out/bin/fiber` and verify its nonzero exit and stable
unavailable error.

Stop if the change starts implementing GitHub Releases, adds an installer,
removes the loopback test seam, or changes unrelated auth behavior.

### Success criteria

- Automatic checks are off unless configured on.
- Explicit upgrade fails honestly and consistently in text and JSON.
- Every missing-Codex instruction names `fiber auth login codex`.
- Status no longer reports update or build channels.
- Ctrl+G reports the disabled state and leaves the session writable.
- The smoke script describes a permanent repository gate.
- No classified dead transition comment or snapshot remains.

## Slice 4: write the post-transition operating documents

### `AGENTS.md`

Remove the temporary transition override and all conflicting fx-era policy.
Keep only current, actionable agent rules:

- Zig 0.16 build, style, memory, I/O, architecture, and security boundaries
- the freshly built binary requirement
- focused local development and draft-versus-ready remote CI
- draft, ready, automated review, and narrow autonomous merge policy
- the owner-approval boundary for product and high-risk changes
- GitHub Issues as the future-work system
- the fetch-only, reimplementation-only upstream harvest policy
- current documentation and release responsibilities

Inventory the small set of rationale that must survive for current rules to
make sense. Place each item next to its owning rule in `AGENTS.md` or
`CONTRIBUTING.md`, such as why upstream changes are reimplemented instead of
cherry-picked and why autonomous merge authority excludes high-risk surfaces.
Do not create a separate rationale archive or preserve historical deliberation.

Do not preserve a transition narrative, nonexistent ship gate, four-platform
claim, local exhaustive-gate project, PR label ceremony, or stale release
instructions. Keep the changelog block only as a writing example; never copy it
into release history.

### `CONTRIBUTING.md`

Make the human workflow match the repository:

- build and focused verification commands
- `fiber auth login codex`
- issue and draft PR flow
- scoped draft CI, ready-PR merge evidence, and manual diagnostics
- independent standards and spec review
- squash-only protected `main` and stale-PR update behavior
- the same risk boundary for autonomous and owner-approved work
- the current prerelease state without claiming a finished distribution path

### `README.md`

Keep it short: a factual description, source build and invocation, current auth
command, pointers to CLI help and contributor guidance, license, and upstream
attribution. Remove inherited positioning and claims about installation,
upgrade, removed flags or slash commands, embedding seams, binary size, or
product docs. Add the product-doc index only when those docs land after the
transition.

### Verification

Compare every runnable instruction with `./zig-out/bin/fiber`. Search for
`full-ci`, `Full CI`, `bench.yml`, `binary-size.yml`, and `Full suite`, all of
which name workflows Slice 1 deleted. Search for the
removed transition links, `fiber login codex`, nonexistent ship gates,
macOS x86_64 Full CI claims, removed commands and flags, inherited marketing,
and false install, upgrade, embedding, or size claims. Check every retained
link.

Stop if a current operating rule has no owner, the documents disagree about
merge authority, or the README must speculate to sound complete.

### Success criteria

- A new agent can work safely without reading deleted transition material.
- Each load-bearing current rationale from the deleted corpus is present beside
  its owning rule; historical or non-operative rationale is absent.
- A contributor can build, authenticate, test, and open a PR using current
  commands.
- The README describes only the product that exists.

## Slice 5: triage and migrate future work

Create `docs/transition/backlog-triage.md` as a temporary ledger. Inventory
candidate work from:

- `docs/enhancements/pending.md`
- every file under `docs/ideas/`
- unresolved entries and follow-ups in `docs/transition/`
- verified review findings that are intentionally outside this closeout

Group duplicate or inseparable items. For each candidate, record its source,
current evidence, proposed user outcome, constraints worth preserving,
dependencies, and a recommendation to create, combine, or drop it. A
still-wanted item must receive an issue before the ledger is deleted. Do not
assign it to `v0.0.1` unless the owner does so during triage.

Pause and grill the owner on one candidate at a time. Do not create any GitHub
issue without explicit approval of that issue's title and body. After posting
an approved issue, record its URL in the ledger. Record dropped items with a
short reason so deletion is deliberate rather than accidental.

The triage must include the known post-closeout release needs and the known
release defect that pushes a tag before validating changelog markers. It must
also cover every local idea file, every heading in `pending.md`, the resume
`image_unavailable` follow-up, upgrade prerelease comparison, live/eval defects,
upstream-harvest candidates, and the `fiber models` defect observed during Slice
1: with real `~/.fiber` credentials the command exits 1 with
`could not list models: MalformedResponse` from
`src/core/gateway/model_catalog.zig`. The JSON envelope is correct, so this is a
catalog or provider-response defect rather than an output-contract one.
`scripts/smoke.sh` only reaches this path on a credentialed profile, so CI
cannot catch it. This list is a floor, not a substitute for the
inventory.

Commit the completed ledger only after every candidate has an owner ruling and
every approved issue has a verified URL. This slice changes no product code.

Stop if an item cannot be understood from surviving evidence. Ask rather than
inventing an issue.

### Success criteria

- Every still-wanted future-work claim scheduled for deletion has an
  owner-approved GitHub issue URL, either alone or in a deliberately combined
  issue.
- Every candidate without an issue has an explicit owner-approved drop reason.
- GitHub contains only owner-approved issues.
- The ledger contains no deferred or unresolved candidate.

## Slice 6: remove the transition planning corpus

### Removal surface

Delete:

- all of `docs/transition/`, including this plan, the triage ledger, Phase 4 and
  Phase 5 artifacts, census scripts, snapshots, inventories, and handoffs
- all of `docs/ideas/`
- all of `docs/enhancements/`
- `docs/` itself if empty

Do not promote `phase5-census.sh`, `phase5-diff.py`, baselines, audit output, or
other transition tooling. Git history and the PR preserve the evidence.

### Retained invariants

- Current operating constraints already exist in `AGENTS.md` or
  `CONTRIBUTING.md`.
- Future work already exists in approved GitHub issues.
- Root documentation has no links into the removed tree.
- Source, tests, build, CI, and runtime behavior do not depend on deleted files.

### Exact checks

- Search the full tracked tree for `docs/transition`, `docs/ideas`,
  `docs/enhancements`, the deleted filenames, and transition-only terminology.
- Search issue bodies and the final ledger before deletion to account for every
  approved URL.
- Inspect `git diff --stat` and `git diff --name-status` for accidental product
  changes or additions.
- Run the standard transition gate even though the intended diff is deletion.

Stop if any surviving link breaks, an approved issue is missing, an unresolved
candidate remains, or the deletion changes product behavior.

### Success criteria

- No transition or local backlog document remains.
- No permanent replacement archive or census tool was added.
- The repository builds and tests without the deleted corpus.

## Final PR review and merge

1. Push Slice 6 while the PR is still draft. Confirm the draft run completes
   and `aggregate` reports on the final head commit.
2. Run independent standards and spec reviews over the complete PR. Resolve
   every blocker and concern. Record the final review evidence in the PR.
3. Confirm `main` has not diverged unexpectedly. If it moved, update
   `transition-main`, rerun the applicable checks, and re-review the resulting
   diff.
4. Mark the PR ready. This must trigger the full ready-PR run: the native
   and E2E matrix on all three platforms, plus benchmarks, binary size,
   conformance, and PGSO.
5. If any required job fails, return the PR to draft. Repair it in a new,
   reviewable commit, run focused diagnostics, then mark it ready for a fresh
   full gate.
6. Rewrite the PR description so it stands alone as the squash commit message
   on `main`. It must describe what the transition changed for someone reading
   `main`'s history, not the slice sequence, the plan, or this phase's process.
   Remove any session or tooling URL that does not resolve for a reader of the
   public repository.
7. When the final tree is reviewed, current, and green, present the owner with
   the PR URL, head commit, tree ID, CI run, review findings, issue URLs, and
   release-safety proof. Obtain explicit approval for the transition merge.
8. Only after approval, enable squash auto-merge. Confirm the squash commit
   message GitHub will use is the rewritten description, not the accumulated
   slice subjects. Do not push, rebase, amend, or otherwise change the branch
   after the approved full run.
9. Fetch `main` after merge and verify its tree ID equals the approved
   `transition-main` tree ID. The squash commit ID is expected to differ.
10. Inspect the `release.yml` run for the squash commit. Confirm the version
    check reports `needed=false` and every tag, build, sign, and publish job is
    skipped.
11. Confirm no `v0.0.1` tag or GitHub Release was created and the merged branch
    was deleted.

Stop before auto-merge if the tested tree cannot be identified, a review concern
is unresolved, `main` is stale, the ruleset is inactive, or the release skip has
not been proved.

## Phase completion record

Report:

- every slice commit and gate result
- the draft PR and final CI URLs
- the active `main` ruleset summary
- independent review results
- approved issue URLs and explicit drops
- the approved source tree ID and merged `main` tree ID
- the release workflow run proving no publication
- confirmation that no transition/local backlog documents, tag, or release
  remain

After this record, future work starts from protected `main` and GitHub Issues.
A separate planning session decides the `v0.0.1` bar.
