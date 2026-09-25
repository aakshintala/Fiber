#!/usr/bin/env python3
"""Probe 1: orphan by SIGPIPE.

Fiber runs a shell command with setsid (own session + process group),
stdin /dev/null, stdout+stderr as one pipe read by Fiber. This simulates
that, then SIGKILLs the "Fiber" parent and checks what happens to three
kinds of child: one that writes to the pipe, one that never writes
anything, and one that writes to a file instead of a pipe (this is what
Fiber's background jobs actually do).
"""
import os
import signal
import subprocess
import sys
import time

WORKDIR = "/tmp/fiber-wt-shutdown-crash/research/shutdown"


def ps_snapshot(label):
    out = subprocess.run(
        ["ps", "-o", "pid,ppid,pgid,stat,command", "-e"],
        capture_output=True, text=True,
    ).stdout
    print(f"--- ps snapshot: {label} ---")
    # only print lines mentioning our marker processes, plus header
    lines = out.splitlines()
    print(lines[0])
    for l in lines[1:]:
        if "fiber_probe" in l or "sleep 300" in l or "tail -f" in l:
            print(l)


def spawn_group(cmd, extra_env=None):
    """Spawn cmd in its own session+pgroup, as Fiber's setsid would."""
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    p = subprocess.Popen(
        cmd, shell=True, env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,  # setsid equivalent
    )
    return p


def main():
    os.chdir(WORKDIR)
    quiet_file = os.path.join(WORKDIR, "probe1_quiet_file.txt")
    open(quiet_file, "w").close()
    out_file = os.path.join(WORKDIR, "probe1_output_file.txt")

    # Child A: writes to the pipe repeatedly (like a chatty command).
    child_a = spawn_group(
        "exec -a fiber_probe_A bash -c "
        "'for i in $(seq 1 100000); do echo line-$i; sleep 0.05; done'"
    )
    # Child B: never writes anything to its stdout pipe.
    child_b = spawn_group("exec -a fiber_probe_B sleep 300")
    # Child C: quiet stdout (tail -f on an unchanging file).
    child_c = spawn_group(f"exec -a fiber_probe_C tail -f {quiet_file}")
    # Child D: writes to a FILE, not the pipe (Fiber background-job shape).
    child_d = spawn_group(
        f"exec -a fiber_probe_D bash -c "
        f"'for i in $(seq 1 100000); do echo line-$i >> {out_file}; sleep 0.05; done'"
    )

    time.sleep(1.0)
    print("Children started. PIDs:", child_a.pid, child_b.pid, child_c.pid, child_d.pid)
    ps_snapshot("before parent dies")

    # Do NOT close the pipe fds ourselves and do NOT waitpid — simulate a
    # crash: the parent (this python process) simply gets SIGKILLed by an
    # external actor. We fork a killer using a separate shell so the kill
    # happens from outside this process's own control flow, then this
    # process's own exit (via os.kill self) drops all its fds including the
    # pipe read ends without any cleanup, exactly like a real crash.
    print("Sending SIGKILL to self (pid %d) to simulate a Fiber crash..." % os.getpid())
    sys.stdout.flush()
    os.kill(os.getpid(), signal.SIGKILL)
    # unreachable


if __name__ == "__main__":
    main()
