#!/bin/bash
# Probe 3: PR_SET_PDEATHSIG (Linux) and its macOS equivalent (there is
# none). This machine is macOS, so the Linux claims below are cited from
# the man page, not measured -- labelled "documented, not measured" in
# the findings file. The macOS checks (no prctl, kqueue exists) ARE
# measured here.
set -u
echo "=== uname -a ==="
uname -a
echo

echo "=== macOS: is there a prctl manual page? ==="
man prctl 2>&1 | head -3
echo "(exit status: $?, 'No manual entry' means macOS has no prctl(2) at all)"
echo

echo "=== macOS: does kqueue(2) exist, with NOTE_EXIT on EVFILT_PROC? ==="
man kqueue 2>&1 | col -b | grep -A2 "NOTE_EXIT " | head -6
echo

echo "=== Linux facts, documented not measured on this machine (macOS) ==="
cat <<'EOF'
Source: man 2 prctl (PR_SET_PDEATHSIG section), Linux man-pages project.

- PR_SET_PDEATHSIG arg2: "Set the parent-death signal of the calling
  process to arg2 (either a valid signal value, or 0 to clear)."
- "The parent-death signal is sent upon subsequent termination of the
  parent thread"  -- fires on death of the parent THREAD, not the whole
  parent process. In a single-threaded parent this is the same event,
  but a multi-threaded parent that pthread_exit()s the specific thread
  that called prctl (while the process lives on) still delivers the
  signal, and conversely the classic gotcha is: if a *thread* other than
  the process's main thread called PR_SET_PDEATHSIG, the signal fires
  when THAT thread exits, which can happen well before the process
  dies.
- "This value is cleared for the child of a fork(2) and (since Linux
  2.4.36 / 2.6.23) when executing a set-user-ID or set-group-ID binary."
  So a child's own children do NOT inherit its PR_SET_PDEATHSIG setting
  -- each process in a tree that wants the behaviour must call prctl
  again after every fork, and it is lost across a setuid/setgid exec.
- Also documented: "the process's parent-death signal is set to SIGKILL
  if the parent process dies" is NOT the default; the signal must be
  requested and can be any signal, not just SIGKILL, and if the parent
  is in a different PID namespace or the setting thread's reparenting
  happens (e.g. the immediate parent dies and re-parenting to a
  subreaper/init occurs), man prctl notes the signal is sent when the
  thread that did the prctl call's *parent* exits, which after
  re-parenting is a DIFFERENT process than the one Fiber originally was.

Conclusion for Fiber on Linux: PR_SET_PDEATHSIG could make a command
process ask the kernel to signal it when Fiber dies, but only if Fiber's
own exec of the command (or a tiny wrapper around it) calls prctl after
fork and before exec, in the correct thread, and only for direct
children -- a grandchild the command itself forks will not inherit it.
This is a per-process opt-in, not a blanket safety net for an arbitrary
shell pipeline. Not measured here (macOS box); cite man 2 prctl.
EOF
echo

echo "=== macOS closest alternative ==="
cat <<'EOF'
No prctl on macOS/BSD (confirmed above: no man page, and the syscall is
not in <sys/prctl.h> because that header does not exist on Darwin).
The closest mechanism is kqueue(2) with EVFILT_PROC and NOTE_EXIT,
registered by the CHILD process against Fiber's own pid: the child opens
a kqueue, adds an EVFILT_PROC/NOTE_EXIT filter on Fiber's pid, and gets a
kevent when Fiber exits, at which point the child can act (e.g. exit
itself). This is measured to exist (see kqueue(2) excerpt above) but was
not exercised end-to-end here because it needs the child to actively run
an event loop and cooperate -- an arbitrary shell command
(`grep`, `curl`, a user's build script) does none of this, so it cannot
cover the general case of "any process Fiber launches". It would only
help a purpose-built Fiber-authored helper process, not a shell command
the user typed.
EOF
