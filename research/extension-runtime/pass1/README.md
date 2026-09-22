# Extension runtime, pass 1: disqualification probe

Answers one question for [#11](https://github.com/aakshintala/fiber/issues/11):
does either candidate runtime fail a constraint that is already settled, making
the full measurement sweep pointless?

Candidates: `mlua` 0.12 (Lua 5.4, vendored, `send`) and `rquickjs` 0.14
(`parallel`). Both at the versions [#3](https://github.com/aakshintala/fiber/issues/3)
measured.

Constraints under test:

- **Interruptibility.** `docs/architecture.md`: a hook answers synchronously
  "under a timeout Fiber enforces". A wedged script must be stoppable.
- **Threading fit.** ADR 0004: blocking threads, no async runtime. One
  interpreter per thread, movable across threads.
- **Failure containment.** The registry model means strangers' extensions,
  broken by accident far more often than maliciously. Error, unbounded
  recursion and unbounded allocation must not take the host down.
- **Stripped-stdlib sandbox.** #3 measured Lua's *default* embedding and found
  `io`/`os` reachable. It recommended stripping the stdlib but never verified
  that the stripped set is actually clean. This does.

Re-run everything with `./measure.sh`. All figures macOS arm64
(Darwin 25.6.0, rustc 1.98.1); the structural results are platform-independent,
the timings are not.

Timing note: the first iteration in each process pays warmup. Run `hook_cost`
several times and take the steady state - a single run overstates the baseline
by 4-5x.
