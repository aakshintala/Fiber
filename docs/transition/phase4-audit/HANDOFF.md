# Handoff: Fiber Phase 4 simplification

Updated after the owner expanded Phase 4 to maximal simplification.

## Read first

1. [`CORRECTIONS.md`](CORRECTIONS.md) — corrected audit conclusions and retention
   decisions
2. [`../simplification-inventory.md`](../simplification-inventory.md) — ordered
   implementation slices
3. [`REPORT.md`](REPORT.md) — raw historical findings and evidence

Do not implement from `REPORT.md` alone. Its counts are correct, but its original
scope and triage are superseded.

## Product decisions

Fiber supports:

- macOS arm64
- Linux x86_64
- Linux arm64

Delete Windows, WebAssembly, WASI, Emscripten, freestanding, macOS Intel, BSD,
and other unsupported-target support. Restrict `build.zig` first so source
branches are provably unreachable before deletion.

Delete inherited dead code now. Origin no longer determines phase ownership.
Retain code only when it serves live behavior, protects data or security, or
provides a useful test adapter over a retained contract.

The one-source Connections screen stays. Provider-shaped public contracts stay.

Phase 4 collapses provider plumbing but keeps the `ProviderId` enum at the
persisted and public boundary, and keeps the model catalog whole. See Slice 26.

`gateway_reviewer_model` is dead residue and gets deleted. The earlier claim that
it is live behavior was wrong; automatic permission review already runs on
catalog-selected `gpt-5.4-mini`. See the retraction in `CORRECTIONS.md`.

## What was wrong with the original audit

- it covered all 490 Zig files under `src`, not the whole tree
- it omitted `build.zig`, although target reachability depends on it
- its claim that every production `core -> builtins` import was test-guarded is
  false
- it deferred deleted-product TESTED-ONLY and SINGLE-CALLER findings by category
- it under-counted unsupported-platform and `workspace_clean` surfaces
- it split connected deletion clusters across slices
- it treated inherited dead code as post-transition work

The raw 360 findings and bucket arithmetic still reconcile. Keep the corpus for
path and symbol evidence, then apply the corrected policy in `CORRECTIONS.md`.

## Do this first

Run and record the clean-tree baseline before editing source:

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
./scripts/smoke.sh
zlint
cd tests/e2e && bun install && bun test
```

Write the E2E results to `docs/transition/phase4-baseline.md`, including each
failing test and stable failure signature. Record the `zlint` `unused-decls`
count and the lazy-analysis probe output there too; both carry the same
attribution rule. See the verification section of the simplification inventory
for the probe procedure and for why a green build under-reports dead code.

Expected stale JSON and ACP-driven failures become Phase 5 evidence. Any later
new or changed failure is attributed to the intervening Phase 4 slice until fixed
or reverted.

`zig build test` can print `failed command:` and still exit 0. Grep its output.

## Execution rules

- run one slice at a time on `main`
- treat each suffixed slice as an independent slice and commit
- recheck declarations, callers, exact searches, and stop conditions before edit
- keep Linux and macOS arm64 differences
- do not preserve code for unsupported targets
- do not delete persisted validation, authority hashing, corruption isolation, or
  retained effect adapters merely because they have one current value
- run the normal gate, `zlint`, and exact absence searches after every slice
- run full E2E checkpoints after platform removal, host-profile collapse, and at
  phase exit

## Audit artifacts

The original audit ran 16 shards, split the capped shard 08, and produced 360
raw findings. The arithmetic remains correct:

- 90 DEAD
- 82 CONFIRMED
- 61 TESTED-ONLY
- 60 SINGLE-CALLER
- 67 REFUTED

The corrected policy deletes every verified DEAD and CONFIRMED row and 56
TESTED-ONLY rows. Five tested-only rows are retracted or retained with reasons in
`CORRECTIONS.md`. Explicit single-caller and false-refutation corrections are
also Phase 4 work.
