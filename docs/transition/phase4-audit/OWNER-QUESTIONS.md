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

## 3. WITHDRAWN — there was no probe-only test failure

**Withdrawn 2026-09-05, during Slice 6.** This entry decided to leave the OSC 8
assistant-stream test failing and treat it as the probe's known constant. There
is nothing to leave failing. The test passes.

It is a meta-test that re-invokes `zig test -Mroot=src/main.zig` as a child
process and asserts the child exits 0. The probe appends an import to
`src/main.zig`, so the child compiled the probe through raw `zig test`, which
does not supply `build_options`. The child failed to build and the meta-test
reported its exit code. Mechanism and evidence in `../phase4-baseline.md`.

No decision was needed and none stands. The probe criterion is now "no failure
except this meta-test, which the probe breaks by construction".

## Decision 5 — the device-code OAuth polling chain looks dead, and the plan says retain it

Raised at Slice 16, 2026-09-05. **Open. Not acted on.**

`simplification-inventory.md` tells Slice 16 to "Retain live Codex token parsing,
device authorization, polling, credential resolution, catalog parsing, and public
model capabilities." Measurement contradicts the polling half.

There is no `pollForToken`. The only implementation is
`login_flow.pollForTokenWithDeps`, and its callers are eight tests in the same
file. `LoginPollDeps`, `LoginPollState`, `realPollDeviceToken`, and
`oauth.pollDeviceTokenBounded` are reachable only through it.

The live sign-in path does not use it. `chatgpt_oauth.zig:80` calls
`login_flow.SignInRuntime.startPrepared` and supplies its own `CompleteSignInFn`;
nothing in that path polls a device-code endpoint. The deleted
`requestDeviceAuthorization` had exactly one caller, a test whose fixture URLs
were `https://vercel.test`, which suggests the whole device-code flow is
Vercel-era residue that the Codex cutover left behind.

Roughly 300-400 lines across `login_flow.zig` and `oauth.zig`.

**Question:** delete the chain, or is it retained for a flow not visible in the
tree? Deleting a whole auth flow against an explicit written retain instruction
is not a call to make on a grep alone.

Slice 16 shipped without touching any of it.

## Decision 6 — is zlint zero a phase-exit blocker or a target?

Raised at the re-audit checkpoint, 2026-09-05. **Open.**

Phase exit requires "`zlint` reports zero `unused-decls` warnings". The count is
106, from 111 at the opening baseline. Most are unused import aliases rather than
dead logic.

No slice names this as its deliverable, so Slice 27 inherits all of them by
default. If it is a real blocker it deserves its own slice; if it is a target,
say so and Slice 27 records the remainder as accepted.
