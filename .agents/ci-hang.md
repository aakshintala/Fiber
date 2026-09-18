# Silent unit-test hangs on CI

What to do when `Native checks` produces no output until the watchdog fires. The generic method lives in the `diagnosing-remote-only-bugs` skill under `.agents/skills/`; this file holds the Fiber and GitHub specifics.

## Read the watchdog output first

The `Run unit tests` step in `ci.yml` kills the run at `TEST_TIMEOUT_SECONDS` and, before that, prints the process tree and every thread stack of each test binary (`sample` and `lldb` on macOS, `gdb` on Linux). Three things to read off it:

- **Thread shape.** Which threads exist and what each is blocked in. A `join` chain ending in a futex wait with no timeout is a deadlock; a thread in `read`/`wait4` is waiting on a child; a busy thread is a slow test, not a hang.
- **Child processes.** The process tree shows whether the test binary has children. No children plus a futex wait means the bug is inside the process.
- **Frames.** On `main`, stacks stop at `Thread.join` or the futex wait, because the exe module is built with `omit_frame_pointer = true` and no unwind tables. That is enough to classify the hang, not to name the test.

## Get full stacks: `-Dframe-pointers`

Build with `zig build test -Dframe-pointers` and `lldb -p <pid> --batch -o 'thread backtrace all'` unwinds from the futex wait all the way down to the test function by its qualified name and every Fiber frame in between. Use it on a diagnosis branch that changes the CI build command; never on `main`, where the product binary keeps frame pointers off for size.

## Resample without perturbing the race

The hang in #352 was a scheduling race with about a 1-in-3 rate on the 3-vCPU macOS runner and 0-in-10 locally. Two things that looked like progress made it vanish:

- **Per-test output.** Running the test binary directly (which streams `i/n name...OK`) or a runner copy that prints each name: 0 hangs in 9 runs. Instrument with memory stores or stacks at the deadline, never with writes on the hot path.
- **Changing the mode.** `zig build test` drives the binary over `--listen`; the direct run is a different mode with different stdout plumbing. Keep the exact production command.

To resample: `gh run rerun <run>` on a slimmed run (set `if: false` on every job except the native leg, and drop the Linux legs from the matrix on the diagnosis branch, so each cycle is ~7 minutes and one macOS slot). `~/.pi/agent/bin/gh-ci resample <pr> "<job name>" --until "<regex>"` does the loop.

## GitHub mechanics that cost time

- `gh run view --log` refuses while any job in the run is in progress. `gh api repos/<owner>/<repo>/actions/jobs/<id>/logs --allow-escape-sequences` returns a finished job's log immediately.
- A PR that is unmergeable against `main` gets no `pull_request` run at all: no queued run, no `startup_failure`. Check mergeability before reading a missing run as a workflow bug. `gh workflow run ci.yml --ref <branch>` still works.
- `zig-out/` survives branch switches. A binary from another branch's build is the one you will run if that branch installed something this one does not.

## Two Fiber facts behind #352

- `Io.Threaded.join` waits on a wait group; a `pthread_join` frame in a Fiber test is always a `std.Thread.join` in Fiber code, so a `join` chain is Fiber teardown, not the Io runtime.
- The test index that hangs is stable: Zig runs tests strictly in `builtin.test_functions` order, and `--seed` only feeds `random_seed`.
