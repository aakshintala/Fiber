---
name: diagnosing-remote-only-bugs
description: Diagnosis for a bug that reproduces only on CI or a machine you cannot attach to. Use for a silent hang or timeout with no output, a flaky one-in-N failure, or any failure that never reproduces locally. Extends the diagnosing-bugs loop with capture-at-deadline instrumentation.
---

# Diagnosing remote-only bugs

The `diagnosing-bugs` loop still applies: a signal that goes red on this bug, then reproduce, minimise, fix, verify. What changes is where the loop lives and what the signal is. Fiber-specific mechanics (build flags, CI commands) are in `.agents/ci-hang.md`.

## The loop lives where the bug lives

When ten local runs are green and the runner fails one in three, the runner is the loop. One iteration is one rerun of the failing job; the assertion is a **watchdog** in that job. Slim the job so an iteration costs one runner slot and the shortest wall time: disable every other job, drop every matrix leg that never fails.

Measure the rate from the runs you already have before you change anything. It sets the budget: expect one catch per `1/rate` runs, and treat `3/rate` runs with no catch as a sign the net changed the bug, not as bad luck.

## Capture at the deadline, don't print on the path

A hang has no output by definition; adding output is the first instinct and the wrong one. A write on the hot path is a syscall and a scheduling point, and it moves the race. Instrument so nothing runs until the deadline:

- **Thread stacks** of the stuck process: `sample`, `lldb -p`, `gdb -p`. They name the blocked frames of every thread at once, which is usually the whole answer.
- **Process tree and open files**, to tell "waiting on a child" from "waiting on itself".
- **Memory stores** if you need per-step state: write an index or a name into a global and read it with the debugger at the deadline.

Prefer the stack over any other instrument. It needs no theory about which test or step is at fault.

## Check the instrument on a green run first

Attach the debugger to a healthy run of the same binary before spending a caught failure on it. If the unwinder stops at a library frame and never reaches your code, the build stripped frame pointers or unwind tables; fix the build on the diagnosis branch and re-check. A stack that reaches your code on a green run will reach it on the red one.

## Keep the production mode

The exact command CI runs is the one that fails. Running the binary directly, swapping the test runner, changing the optimisation mode, or adding a flag that alters the process layout each creates a different program with different timing. If you must change one of them to get a signal, count the runs under the new mode separately and go back to the production command if the failure rate drops.

## Read the whole chain

The frame at the top of the stuck thread is where the process is waiting, not where the bug is. Walk every thread: who is each one waiting for? A join chain that ends in a wait with no timeout is a deadlock, and the bug is the ordering that created the chain. A test that failed a deadline and then hung in its teardown is two events; the deadlock came first and the hang is the symptom.

## Prove the fix twice

- **Negative control**: the fixed test against the old code fails the way the runner did (for a deadlock, it hangs deterministically under a timeout). If it passes, the test does not cover the bug.
- **Positive**: the full production command passes with the fix.

Rewrite the regression test so the losing interleaving is forced, not sampled: wait for the state the race needed before taking the next step, so the old order fails every time.

## Look for the same fix elsewhere

A fork or upstream may already carry the fix; search it for the function and the symptom before writing your own. Then search your own tree for the same ordering in sibling functions: the shape that deadlocked once is rarely unique.
