#!/usr/bin/env python3
"""Probe 2: can (pgid, group-leader start time) recorded once be used
later to tell reliably whether a process group is still the same one,
and to kill it safely?

Also checks: after the leader itself has exited, does kill(-pgid, 0)
still report success while other group members are alive?
"""
import os
import signal
import subprocess
import time


def lstart(pid):
    """macOS: ps -o lstart= -p <pid> -- process start time, second resolution."""
    r = subprocess.run(
        ["ps", "-o", "lstart=", "-p", str(pid)],
        capture_output=True, text=True,
    )
    return r.stdout.strip()


def pgid_alive(pgid):
    """kill(-pgid, 0) returns True if the OS thinks the group still has
    at least one member (any member, not necessarily the original leader)."""
    try:
        os.kill(-pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just not ours (won't happen here)


def main():
    print("=== uname -a ===")
    print(subprocess.run(["uname", "-a"], capture_output=True, text=True).stdout.strip())
    print()

    # Group leader plus one longer-lived group member, like Fiber recording
    # a delegate's (pgid, leader start time) then a command inside it
    # outliving the leader's own shell wrapper is NOT typical -- but we
    # simulate leader-exits-first because Fiber launches via `setsid sh -c
    # '<cmd>'`, and some shells exec() into the real command (leader
    # identity preseryed) while others fork a child and exit (leader pid
    # gone, pgid lives on via the child). This probe covers the second case.
    leader = subprocess.Popen(
        # leader forks a background child then exits immediately WITHOUT
        # waiting for it -- the group (pgid) outlives the leader pid.
        ["bash", "-c", "sleep 5 & disown; exit 0"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    pgid = os.getpgid(leader.pid)
    time.sleep(0.3)  # let the group settle
    recorded_start = lstart(leader.pid)
    print(f"recorded tuple: pgid={pgid}, leader pid={leader.pid}, lstart={recorded_start!r}")

    print("\n-- check while group is alive --")
    print("pgid_alive:", pgid_alive(pgid))
    print("lstart now:", lstart(leader.pid))
    print("matches recorded:", lstart(leader.pid) == recorded_start)

    leader.wait()
    print("\nleader process has now exited (waitpid reaped it)")
    print("-- check immediately after leader exit, child (sleep 5) still running --")
    print("pgid_alive:", pgid_alive(pgid))
    # ps -p on the dead leader pid will fail/empty now
    print("lstart on dead leader pid:", repr(lstart(leader.pid)))
    # but the group's other member(s) are still alive -- find them
    r = subprocess.run(["ps", "-o", "pid,pgid,command", "-g", str(pgid)],
                        capture_output=True, text=True)
    print("ps -g <pgid> while a non-leader member still runs:")
    print(r.stdout.strip())

    time.sleep(5.2)  # let the sleep 5 background child finish too
    print("\n-- check after the whole group has exited --")
    print("pgid_alive:", pgid_alive(pgid))

    print("\n=== pid/pgid reuse argument ===")
    print(
        "macOS ps lstart resolution is 1 second (see raw output above: no "
        "sub-second field). The kernel assigns pids/pgids from a rolling "
        "counter (PID_MAX ~ 99998 on this system by default), so a pgid "
        "number can be reused within a session once the value wraps and the "
        "old number is free again. A recorded (pgid, lstart) tuple "
        "disambiguates reuse ONLY if the reuse gap exceeds 1 second of wall "
        "clock AND no unrelated process happens to start in the exact same "
        "second after wraparound -- for a long-running Fiber session doing "
        "many kills per minute, that is not a safety margin, it is a "
        "birthday-paradox coin flip. The tuple is a heuristic, not a proof."
    )


if __name__ == "__main__":
    main()
