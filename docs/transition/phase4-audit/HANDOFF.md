# Handoff: Fiber Phase 4 (Simplification)

Written 2026-09-05 at the close of the Phase 4 audit. Read this, then
[`../simplification-inventory.md`](../simplification-inventory.md). Everything
below is verified against `HEAD` at the time of writing; re-verify line numbers
before editing, the tree moves.

## State

Phase 3 closed. Slices 1-12 landed; `/background`, `debug trace`, `mcp doctor`,
and per-component context accounting were deferred to
[`../../enhancements/pending.md`](../../enhancements/pending.md).

Phase 4 is planned but **not started**. No source file has been modified. The
only changes in this working tree are documentation.

## What was done

A read-only audit of the whole tree: 490 Zig files, 580,284 lines, of which
362,634 are production (the rest are 7,289 inline `test` blocks).

16 parallel `composer-2.5` shards produced 360 raw findings. Every claim was then
gated twice — mechanically, by counting real references against a test-stripped
mirror, and for the 210 the counter could not settle, adversarially, by 12
`gemini-3.5-flash` batches told to refute rather than confirm. **31% of
adversarially verified claims were refuted.** Do not trust an unverified finding
from this corpus.

Results and all inputs are in this directory. [`REPORT.md`](REPORT.md) is the
one to read.

## Do this first

1. Run the baseline gate on a clean tree and confirm it is green before editing:
   `zig fmt --check src/`, `zig build -Doptimize=ReleaseSafe`,
   `zig build test -Doptimize=ReleaseSafe`, `./scripts/smoke.sh`.
   **`zig build test` can print `failed command:` and still exit 0** — grep the
   output, do not trust the exit status.
2. Commit the pending documentation changes if they are still uncommitted
   (`git status` — `plan.md`, `pending.md`, `simplification-inventory.md`,
   `deferred.md`, this directory, and `docs/ideas/feedback-from-failed-pi-gui-integration.md`).
3. Then start slices in the recommended order: **2, 3, 4, 6, 7, 9, 10, 11, then
   1, then 12.**

## Things that will bite you

- **Slice 1 is not a codemod.** Guards come in two shapes,
  `if (comptime allows(X)) { body }` (keep the body) and
  `if (comptime !allows(X)) return;` (delete the statement). Every condition is
  comptime-true, so a regex that gets the second kind wrong compiles clean and
  silently changes behavior. Read all ~30 sites.
- **Never hand-roll Zig brace matching.** `} else {` and multi-line signatures
  break depth counters. Use literal replacement.
- **The layering rule.** `src/core` defines contracts, `src/builtins` implements,
  `src/main.zig` wires, and every production `core -> builtins` import is
  `if (builtin.is_test)`-guarded. A one-implementation vtable in `src/core` is
  *correct*, not residue. This rule is what makes ten of the fourteen `Provider`
  structs retentions rather than collapses.
- **Phase 4 changes no user-visible behavior.** That is what lets Phase 5 treat
  every failure as pre-existing. Slice 5 was withdrawn for violating it.

## Decisions already made — do not reopen

- **Slice 5 withdrawn.** The one-item `Connections` sign-in screen stays.
  OpenCode and Databricks are planned, so it is early rather than false.
- **Slice 13 settles the discarded provider-selection parameters.** The line is
  type, not deadness: parameters typed `ProviderId` are the retained seam and
  stay (with `_ = target;` becoming an exhaustive switch); parameters encoding
  credential-source or manual-code variation go. Rationale is in the slice.

## Not Phase 4's work

- 75 dead `always-was` findings, 61 TESTED-ONLY, 60 SINGLE-CALLER. Real, but
  inherited rot rather than demolition residue. They belong to the architectural
  audit planned after Phase 6. See the post-transition backlog section of the
  inventory.
- `gateway_reviewer_model = "moonshotai/kimi-k3"` — a stale Gateway-era default on
  a retained seam. Parked in `deferred.md` under Phase 6.

## Process notes

- Delegate demolition-shaped slices to Cursor (`composer-2.5` for edits) — for
  cost, not parallelism. Claude orchestrates and verifies.
- Every GPT model id goes through the `codex` CLI, never cursor-delegate.
- Check call sites before overriding a delegate's retention decision. It has been
  right and the diff read wrong more than once.
- No quality review during the transition. Correctness verification yes; the
  quality audit is deferred to the end.
