# Phase 4 opening baseline

Recorded 2026-09-05. Tree state: `main` at `e9608164` for the measurements
below, except the `zig build test` result, which is recorded at `50adab57`.
See "Gate repair" for why the two differ.

## Gate results

| Gate | Result |
| --- | --- |
| `zig fmt --check src/` | clean |
| `zig build -Doptimize=ReleaseSafe` | green |
| `zig build test -Doptimize=ReleaseSafe` | 7287 passed, 2 skipped, 0 failed, silent |
| `./scripts/smoke.sh` | `smoke: ok (zig-out/bin/fiber)` |
| `zlint` | 0 errors, 111 `unused-decls` warnings across 496 files |
| `bun test` (E2E) | 489 failed, 0 passed, run abandoned — see below |

`zlint` v0.9.1 was not installed on this machine. The pinned
`zlint-macos-aarch64` release binary was installed to `~/.local/bin/zlint`.
The 111 count reproduces the handoff figure exactly.

## Gate repair, committed as `50adab57`

`zig build test` printed `failed command:` on every invocation while still
exiting 0. The per-slice grep for that string, which the inventory makes the
primary attribution signal, was therefore red before Phase 4 began and could
not attribute anything to any slice.

Root cause: `cli_surface.runTopLevelDebug` dispatched `fiber debug replay`
through `cli_replay.run`, which constructs its own `ProcessOutput` writing to
the real process streams. Every other subcommand writes through `RunDeps`. The
test at `cli_surface.zig` "debug replay dispatches through cli replay with exit
passthrough" therefore leaked `fiber replay: missing tape path` to the real
stderr, which the listen-mode test runner treats as a failed step. Run
directly, the same binary passes 7287 tests and exits 0.

Confirmed by skipping that single test, which made `zig build test` silent.

Fixed at the seam: a `ReplayOutput` adapter over `RunDeps` calling the existing
`cli_replay.runWithOutput`. Production destinations are unchanged; the `RunDeps`
defaults are the real streams. The dispatch test now asserts the captured
stderr so the leak cannot return silently.

Every gate figure above is measured with this repair in place. There is no
usable pre-repair `zig build test` baseline, because the pre-repair command
reported failure unconditionally.

## The E2E suite carries no Phase 4 signal

The inventory's attribution scheme assumes a mostly-green E2E baseline with
individually recorded exceptions. That assumption does not hold.

The run produced 489 failures and zero passes before it was abandoned. The
cause is not regression. 47 of the 55 `tests/e2e/*.test.ts` files drive the
product through a fake Vercel AI Gateway, setting `AI_GATEWAY_API_KEY`,
`FX_GATEWAY_BASE_URL`, `FX_GATEWAY_CHAT_URL`, and
`FIBER_E2E_GATEWAY_MODELS_URL`, and selecting gateway model ids such as
`openai/gpt-5`. Phase 3 deleted the Gateway provider, so the product ignores
that environment and every gateway-driven case fails, most on an exit code of
1 and the TTY cases on a 30-second timeout.

Failure counts by suite:

```
 74  modern MCP stdio compatibility
 72  gateway stream lifecycle
 43  effect-aware command permissions
 38  version-scoped legacy MCP remote transports
 38  modern MCP Streamable HTTP
 31  MCP remote authentication lifecycle
 27  lean auto mode reliability
 14  filesystem path handling
 11  cli: status
 10  fiber ask presentation
 10  config persistence
 10  cli: sessions
```

Raw output: `/private/tmp/.../scratchpad/e2e-baseline.txt`, not committed.

An all-red suite cannot distinguish a slice-caused failure from the standing
one, so per-signature attribution degenerates to noise. Rewiring the harness
onto the Codex path is Phase 5 work and is out of Phase 4 scope.

**Decision, taken without the owner:** Phase 4 does not run the E2E suite —
not at the re-audit checkpoint, not at phase exit. The Zig gate carries
attribution alone. Logged in `phase4-audit/OWNER-QUESTIONS.md`. Reverse this
by rewiring the harness first; running it unchanged only reproduces this file.

## Corrections to the handoff

The handoff's claim that 502 tests exist which the normal suite never executes
is not a file-reachability fact. Only 2 of the 490 tracked files under `src/`
are never textually imported: `benchmark_exports.zig` and
`terminal_client_fixture.zig`. The gap is Zig's lazy analysis — files whose
only `@import` sits inside a function body that nothing analyzes. The
lazy-analysis probe is the only way to enumerate it.

The handoff directs triage of a failing test,
`core.agent.runtime.assistant_stream.test.streamed presentation preserves ANSI
OSC 8 code fence and table spans`. It does not fail. The full suite reports 0
failures, both under `zig build test` after the repair and when the test binary
is run directly.

## Attribution rules in force

- a formatting, build, unit-test, or smoke failure first seen after a slice is
  caused by that slice until fixed or reverted
- `zig build test` output must stay free of `failed command:`; grep it, do not
  trust the exit status
- `zlint` must report no more than 111 `unused-decls` warnings
- the lazy-analysis probe must compile clean
- E2E is not a Phase 4 signal
