# What a crashed Fiber leaves behind (issue #34)

This answers issue #34: when Fiber crashes or is SIGKILLed, its normal
shutdown (SIGTERM to every process group, SIGKILL 800ms later, then up
to 2 seconds reading output) never runs. What is left running, and can
anything reach it afterwards?

All measurements were taken on one machine: macOS (Darwin 25.6.0,
`sw_vers` reports macOS 26.6.2, build 25G83), arm64. Every number names
the script that produced it, under this directory. Linux was not
measured (no Linux box available); Linux claims are cited from man
pages and marked "documented, not measured".

The scripts model Fiber's own process shape: each command runs in its
own session and process group (`setsid`), stdin is `/dev/null`, stdout
and stderr are one pipe read back by Fiber.

## 1. What survives a crash depends on what the child touches

Script: `probe1_orphan_sigpipe.py`, driven by `run_probe1.sh`.

Four children were started in their own process groups, then the
"Fiber" parent was sent SIGKILL, simulating a crash rather than a clean
exit:

- Child A writes lines to its stdout pipe every 0.05s.
- Child B writes nothing (`sleep 300`).
- Child C has a quiet stdout (`tail -f` on a file nobody appends to).
- Child D writes to a file, not a pipe, appending a line every 0.05s.
  This is the shape of Fiber's background jobs, which redirect output
  to a file rather than holding a pipe.

Result, three seconds after the simulated crash:

```
PID  PPID  PGID STAT COMMAND
4896     1  4896 Ss   fiber_probe_B 300
4897     1  4897 Ss   fiber_probe_C -f probe1_quiet_file.txt
4898     1  4898 Ss   fiber_probe_D -c for i in ...; do echo line-$i >> probe1_output_file.txt; ...
```

Child A, the pipe writer, is not in the list: it died. The pipe's read
end was held only by the crashed parent; once that parent's file
descriptors were dropped by the kernel, the pipe had no reader, and
child A's next `echo` hit SIGPIPE and killed it (default disposition of
SIGPIPE is terminate). This matches ordinary pipe behaviour on both
Darwin and Linux: writing to a pipe with no reader raises SIGPIPE, or
returns EPIPE if the process has SIGPIPE blocked or ignored.

Children B, C and D all survived, re-parented to PID 1 (`launchd` on
macOS; `init` or a subreaper on Linux), keeping their original process
group. So:

- A child that never writes to the pipe (`sleep 300`) is unaffected by
  the crash: nothing tells it to stop.
- A child with quiet stdout (`tail -f` on an unchanging file) is the
  same: no write, no SIGPIPE, keeps running.
- A child that writes to a file is completely unaffected by the crash,
  because it never depended on the pipe. This is the concerning case
  for Fiber's background jobs: they are immune to the SIGPIPE mechanism
  that incidentally cleans up some pipe-writing children, and will run
  forever unless something else kills them.

SIGPIPE is not a safety net. It only clips children that are both
chatty and writing to the pipe Fiber held. A quiet command, or a
background job writing to a file, keeps running indefinitely after a
crash with nothing watching it.

## 2. Recording pgid and start time is a heuristic, not a proof

Script: `probe2_pgid_starttime.py`.

The question: if Fiber records the pgid and the start time of the group
leader when it launches a command, can a later process (a resumed
Fiber, or a cleanup pass) use that pair to safely decide "this group is
still the one I started" and kill it?

Measured behaviour:

```
recorded tuple: pgid=5919, leader pid=5919, lstart='Thu Sep 24 17:01:01 2026'

-- while group is alive --
pgid_alive: True
lstart now: 'Thu Sep 24 17:01:01 2026'   (matches recorded)

-- after the leader process exits, a child in the same group still runs --
pgid_alive: True                          <- kill(-pgid, 0) still succeeds
lstart on dead leader pid: ''             <- ps -p on the dead pid returns nothing

-- after the whole group has exited --
pgid_alive: False
```

Three findings:

- `kill(-pgid, 0)` (used here to test group liveness without sending a
  real signal) reports the group alive as long as any member holds that
  pgid, not just the original leader. Fiber's shell wrapper is usually
  the group leader; if that shell forks a background job and exits
  before the job finishes (as in the probe: `sleep 5 & disown; exit
  0`), the leader is gone but the pgid is still "alive" through the
  child. Checking `kill(-pgid, 0)` alone cannot tell you the leader is
  dead, only that the group number is still in use by someone.
- Once the leader pid has exited, `ps -o lstart= -p <leader pid>`
  returns nothing, since the pid may already be recycled, so the
  recorded start time can no longer be re-checked against it. The only
  thing left to check is whether the pgid is in use, not whether it is
  the same group recorded.
- macOS's `ps -o lstart=` resolution is one second: the field above has
  no fractional seconds. pgids, like pids, come from a wrapping
  counter, so a number can be reused once it wraps and the old value is
  free. A recorded (pgid, lstart) pair only disambiguates reuse if the
  gap between the old group dying and an unrelated process reusing the
  same pgid is more than one second, and nothing else starts in that
  same second. For a long-running Fiber session doing many launches and
  kills, that is a coin flip, not a guarantee. The pair is a useful
  heuristic, not proof that a kill is safe.

## 3. PR_SET_PDEATHSIG is Linux only, and does not cover this case either

Script: `probe3_pdeathsig.sh`. The macOS parts of its output were
measured; the Linux parts are cited from `man 2 prctl` and marked
documented, not measured, since this machine is macOS.

Measured on macOS: there is no prctl man page at all (`man prctl` gives
"No manual entry for prctl") and no `<sys/prctl.h>` header. The
mechanism does not exist on Darwin or BSD.

Documented for Linux (`man 2 prctl`, not measured here):

- `PR_SET_PDEATHSIG` asks the kernel to send a chosen signal to the
  calling process when its parent later dies.
- The man page is explicit that this fires on death of the parent
  thread, not the parent process. In a multi-threaded parent, if a
  thread other than the main thread made the prctl call, the signal can
  fire when that one thread exits, well before the whole process dies.
  This is the well-known caveat with this API.
- The setting is cleared on fork(2): a child's own children do not
  inherit it. Each process in a tree that wants the behaviour has to
  call prctl again itself, after its own fork, before its own exec. It
  is also cleared across a set-user-ID or set-group-ID exec.

So even on Linux, PR_SET_PDEATHSIG only helps if Fiber's own launch
wrapper calls it in every process it starts, right after fork and
before exec, and even then a further child that command forks would
not inherit the setting, so a shell pipeline's grandchildren stay
uncovered. It is a per-process opt-in, not a blanket fix for "kill
everything Fiber started".

The closest macOS alternative is kqueue(2) with an EVFILT_PROC filter
and the NOTE_EXIT flag, registered by the child against Fiber's pid
(confirmed present on this machine: `man kqueue` lists NOTE_EXIT, "The
process has exited," under EVFILT_PROC). This needs the child to open a
kqueue and run an event loop watching for it; an ordinary shell command
such as grep, curl or a build script does none of that, so it cannot
cover an arbitrary command Fiber launches. It would only help a
purpose-built Fiber-authored helper process.

## 4. A stale, still-open output file does not interfere with a resumed Fiber

Script: `probe4_stale_output_file.py`.

Simulated: an orphaned background job (like child D above) keeps
appending to its output file after its Fiber has crashed. A new process
(standing in for a freshly started Fiber, or a person looking at the
file) opens the same path, appends its own line, and reads the file,
while the orphan is still writing.

Result: the new write landed cleanly between two of the orphan's writes
with no corruption or blocking:

```
orphan-1
orphan-2
orphan-3
newcomer-hello
orphan-4
orphan-5
orphan-6
orphan-7
orphan-8
```

This is ordinary POSIX append behaviour on a regular file: each write()
under a few kilobytes is atomic, O_APPEND always writes at the file's
current end no matter how many processes hold it open, and holding a
file open never blocks another process from opening, reading or
appending to the same path. An old orphan holding the file open is a
nuisance, growing a file nobody is watching, but it cannot corrupt or
lock out a new writer or reader.

## 5. Nested shutdown cost: sequential versus parallel, not depth, sets the price

Script: `probe5_nested_kill_cost.py`. Tree: a root over 3 delegate
groups, each with 2 command groups, 6 leaf groups in total, matching
the ticket's shape; also measured flattened as depth 1 (root directly
over 6 leaf groups) for comparison. Each shutdown step is: SIGTERM the
group or groups, wait up to 800ms, SIGKILL any still alive, then reap.

```
shape            leaf behaviour   sequential     parallel
depth1_6leaves   prompt              0.074s        0.013s
depth1_6leaves   stubborn            4.851s        0.809s
depth2_3x2       prompt              0.071s        0.010s
depth2_3x2       stubborn            4.841s        0.814s
```

When every leaf exits promptly on SIGTERM, both strategies are fast,
well under a second either way; the cost only shows up when a child
ignores SIGTERM. When every leaf traps and ignores SIGTERM (`trap ''
TERM`), a sequential shutdown of 6 groups pays the full 800ms wait once
per group: 6 x 0.8s, about 4.85s measured. A parallel shutdown sends
SIGTERM to all 6 groups at once, waits once (about 0.8s), then SIGKILLs
any stragglers at once: 0.81s measured, about 6 times faster, and the
factor scales with however many groups are shut down at that step, not
with tree depth.

Depth 1 and depth 2 gave the same numbers here. That is a property of
this simulation, not a general result: the simulated root signals every
leaf group's pgid directly, without needing a live delegate process to
relay the signal to its grandchildren, so the 800ms wait is paid once
per level walked sequentially, not once per level of tree depth. If
Fiber's real shutdown can only reach a grandchild's process group by
first asking its still-running parent delegate to forward the signal,
so levels must be walked one after another, then depth would compound
the wait, adding another 800ms per level in the worst case. That
dependency was not measured here; it hinges on whether Fiber's
supervisor already knows every descendant's pgid up front, as
simulated, or discovers them level by level.

The load-bearing finding: shutting down sibling groups in parallel
rather than one after another turns "N times 800ms" into "about 800ms"
whenever any of them ignore SIGTERM, and costs nothing extra when they
all exit promptly.

## What was not measured

- Nothing here was measured on Linux. The PR_SET_PDEATHSIG behaviour,
  its thread-death caveat, and its fork or exec clearing behaviour are
  all cited from `man 2 prctl`, not exercised on a Linux kernel.
- Whether tree depth itself, as opposed to sequential-versus-parallel
  fan-out, adds cost when a real delegate must relay a signal to its
  own children. Probe 5 assumes the root can signal every group
  directly.
- pid or pgid reuse under sustained load, many launches and kills per
  second. Probe 2 only shows the one-second lstart resolution and the
  reuse argument, not an observed collision.
- Signal-masked children, a process that blocks or ignores SIGPIPE
  instead of using the default disposition, were not tested in probe 1;
  the default (terminate) was assumed, which is what a plain shell
  command gets unless it explicitly changes it.
