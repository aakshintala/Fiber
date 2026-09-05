# Phase 4 decisions taken without the owner

The owner authorised autonomous execution of Phase 4 on 2026-09-05, with
instructions to route around anything needing a decision and record it here.
Each entry states what was decided, on what evidence, and how to reverse it.

## 1. Phase 4 does not run the E2E suite

**Decided:** drop `bun test` from the phase-opening baseline, the re-audit
checkpoint, and phase exit. The Zig gate carries attribution alone.

**Evidence:** the opening run produced 489 failures and zero passes. 47 of 55
`tests/e2e/*.test.ts` files drive the product through a fake Vercel AI Gateway
whose provider Phase 3 deleted. The failures are environmental, not
regressions. Full detail in `../phase4-baseline.md`.

**Why it was not left as recorded exceptions:** the inventory's rule is that a
file green at baseline and red later is slice-caused. With nothing green, the
rule has no domain. Keeping the suite in the gate would cost roughly twenty
minutes per checkpoint to reproduce a known constant.

**To reverse:** rewire the harness onto the Codex path, which is Phase 5 work,
then restore the checkpoints. Running the suite unchanged only reproduces
`phase4-baseline.md`.

## 2. The test gate was repaired before Slice 0 closed

**Decided:** commit a source change during Slice 0, which the inventory says
must make none.

**Evidence:** `zig build test` printed `failed command:` unconditionally while
exiting 0, so the per-slice grep the inventory mandates was red before the
phase began. A baseline that records a permanently-red gate cannot attribute
anything. Root cause and fix are in `../phase4-baseline.md` and commit
`50adab57`.

**To reverse:** revert `50adab57`. The gate returns to reporting failure on
every slice.
