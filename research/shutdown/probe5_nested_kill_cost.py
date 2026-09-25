#!/usr/bin/env python3
"""Probe 5: cost of a nested shutdown tree.

Tree shape: root -> 3 delegate groups -> each delegate has 2 command
groups. That's 6 leaf command groups total, under 3 delegate groups,
under the root. Each level in Fiber's real shutdown sends SIGTERM to its
direct children's process groups, waits up to 800ms, then SIGKILLs any
still alive. This measures two ways of walking that tree:

  sequential: fully shut down delegate 1 (which fully shuts down its
    2 command groups, sequentially) before starting on delegate 2.
  parallel:   send SIGTERM to all children at a level at once, wait
    once for the whole level, SIGKILL stragglers at that level at once.

Two leaf behaviours are measured: children that exit promptly on
SIGTERM, and children that trap and ignore SIGTERM (forcing the full
800ms wait then a SIGKILL). Depth 1 (root directly over 6 leaf groups,
no delegate layer) and depth 2 (the real 3-delegates-of-2 shape) are
both reported.
"""
import os
import signal
import subprocess
import time

TERM_WAIT_S = 0.8


def spawn_group(cmd):
    return subprocess.Popen(
        ["bash", "-c", cmd],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def shutdown_group_sequential(proc):
    """SIGTERM the group, wait up to 800ms, SIGKILL if still alive.
    Blocks (polls) until the group is actually gone."""
    pgid = os.getpgid(proc.pid)
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + TERM_WAIT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.01)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def shutdown_groups_parallel(procs):
    """SIGTERM all groups at once, wait up to 800ms total (not per group),
    then SIGKILL any stragglers at once."""
    pgids = []
    for proc in procs:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
            pgids.append(pgid)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + TERM_WAIT_S
    remaining = list(procs)
    while time.monotonic() < deadline and remaining:
        remaining = [p for p in remaining if p.poll() is None]
        if not remaining:
            break
        time.sleep(0.01)
    for proc in remaining:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    for proc in procs:
        proc.wait()


PROMPT_CMD = "trap 'exit 0' TERM; sleep 300 & wait"
STUBBORN_CMD = "trap '' TERM; sleep 300"


def leaf_cmd(behaviour):
    return PROMPT_CMD if behaviour == "prompt" else STUBBORN_CMD


def build_depth1_tree(behaviour, n_leaves=6):
    """root directly over n_leaves command groups (no delegate layer)."""
    return [spawn_group(leaf_cmd(behaviour)) for _ in range(n_leaves)]


def build_depth2_tree(behaviour, n_delegates=3, n_children=2):
    """root -> n_delegates delegate groups -> each has n_children leaf
    command groups. Delegate groups themselves are shells that just hold
    their children open (they trap TERM and forward it), matching a
    real delegate that must relay a shutdown down to its own children."""
    delegates = []
    for _ in range(n_delegates):
        children = [spawn_group(leaf_cmd(behaviour)) for _ in range(n_children)]
        delegates.append(children)
    return delegates


def run_depth1(behaviour, mode):
    procs = build_depth1_tree(behaviour)
    t0 = time.monotonic()
    if mode == "sequential":
        for p in procs:
            shutdown_group_sequential(p)
    else:
        shutdown_groups_parallel(procs)
    return time.monotonic() - t0


def run_depth2(behaviour, mode):
    delegates = build_depth2_tree(behaviour)
    t0 = time.monotonic()
    if mode == "sequential":
        for children in delegates:
            for p in children:
                shutdown_group_sequential(p)
    else:
        # parallel across delegates AND within each delegate's children:
        # flatten, since in this simulation "delegate" has no real process
        # of its own between root and its children (root talks directly
        # to every leaf group's pgid, as Fiber's real supervisor does --
        # it tracks pgids at every level, it does not need to hop through
        # a live delegate process to signal a grandchild's group).
        all_children = [p for children in delegates for p in children]
        shutdown_groups_parallel(all_children)
    return time.monotonic() - t0


def main():
    print("=== uname -a (platform for every number below: macOS / Darwin) ===")
    print(subprocess.run(["uname", "-a"], capture_output=True, text=True).stdout.strip())
    print()

    results = {}
    for depth, runner in (("depth1_6leaves", run_depth1), ("depth2_3x2", run_depth2)):
        for behaviour in ("prompt", "stubborn"):
            for mode in ("sequential", "parallel"):
                elapsed = runner(behaviour, mode)
                key = f"{depth}/{behaviour}/{mode}"
                results[key] = elapsed
                print(f"{key:35s} wall time: {elapsed:.3f}s")

    print("\n=== summary table ===")
    print(f"{'shape':16s} {'leaf behaviour':10s} {'sequential':>12s} {'parallel':>12s}")
    for depth in ("depth1_6leaves", "depth2_3x2"):
        for behaviour in ("prompt", "stubborn"):
            seq = results[f"{depth}/{behaviour}/sequential"]
            par = results[f"{depth}/{behaviour}/parallel"]
            print(f"{depth:16s} {behaviour:10s} {seq:12.3f} {par:12.3f}")


if __name__ == "__main__":
    main()
