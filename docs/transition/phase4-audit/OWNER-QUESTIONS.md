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

## 3. The one probe-only test failure is not fixed in Phase 4

**Decided:** leave
`core.agent.runtime.assistant_stream.test.streamed presentation preserves ANSI
OSC 8 code fence and table spans` failing, and treat it as the lazy-analysis
probe's known constant rather than as work.

**Evidence:** the probe run at `38496f4c` reports 7791 tests against the normal
suite's 7289 — 502 tests the gate has never executed, one of which fails. The
failure predates Phase 4 and is not slice-caused. Detail in
`../phase4-baseline.md`.

**Why it was not fixed:** Phase 4 removes code; it does not repair product
behaviour. Fixing an assertion in live streaming code mid-phase would put a
behavioural change inside a demolition commit and break slice attribution.

**To reverse:** fix it as its own commit, then change the probe criterion in
`phase4-baseline.md` and `simplification-inventory.md` from "reports the OSC 8
failure and no other" to "reports no failures".

## 4. Slice 4 keeps the fake-gateway request serialiser

**Decided:** retain `buildAgentRequest` and its helpers in
`src/builtins/gateway.zig`, and retain `provider_bundle`, against the
inventory's Slice 4 removal surface. Delete only the measurably dead surface in
`src/gateway/agent_request_body.zig`.

**Evidence:** `buildAgentRequest` is what both fake gateways serialise through
so tests can assert on the request the agent would have sent; about twenty
retained tests read those captures. `provider_bundle` has three live test-config
consumers unrelated to request building. Detail and the per-declaration
reference counts are in `CORRECTIONS.md`.

**Why it was not deleted as written:** the inventory classifies the family as
test-only, which is true, and infers dead, which is false. The phase's own
deletion bar is that unreachable code behind a retained seam stays; this code is
not even unreachable.

**To reverse:** delete the family and every test that asserts on a captured
request body. That is a coverage decision, not a simplification one, and it
should be taken deliberately rather than as a side effect of Slice 4.
