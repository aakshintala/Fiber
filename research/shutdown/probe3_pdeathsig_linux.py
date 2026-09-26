#!/usr/bin/env python3
"""Probe 3 on Linux: exercise PR_SET_PDEATHSIG instead of citing prctl(2).

A stand-in "Fiber" process launches `sh -c 'sleep 301 & exec sleep 300'`
with PR_SET_PDEATHSIG=SIGTERM set between fork and exec. The direct child
(sleep 300) carries the setting; the grandchild (sleep 301) does not.

  crash:  "Fiber" is SIGKILLed. Does the child die? Does the grandchild?
  thread: "Fiber" launches from a worker thread that then exits while the
          process stays alive. Does the child die early?
"""
import ctypes
import os
import signal
import subprocess
import sys
import threading
import time

PR_SET_PDEATHSIG = 1


def set_pdeathsig():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
        os._exit(99)


def launch():
    child = subprocess.Popen(
        ["sh", "-c", "sleep 301 & echo $!; exec sleep 300"],
        stdout=subprocess.PIPE,
        preexec_fn=set_pdeathsig,
    )
    grandchild = int(child.stdout.readline())
    print(child.pid, grandchild, flush=True)


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def fiber(mode):
    if mode == "crash":
        launch()
    else:
        t = threading.Thread(target=launch)
        t.start()
        t.join()
    time.sleep(600)


def run(mode):
    fib = subprocess.Popen([sys.executable, __file__, "--fiber", mode], stdout=subprocess.PIPE)
    child, grandchild = map(int, fib.stdout.readline().split())
    if mode == "crash":
        fib.send_signal(signal.SIGKILL)
        fib.wait()
    time.sleep(0.5)
    print(f"{mode}: fiber alive={fib.poll() is None} child alive={alive(child)} "
          f"grandchild alive={alive(grandchild)}")
    for pid in (child, grandchild, fib.pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    fib.wait()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fiber":
        fiber(sys.argv[2])
    else:
        print(" ".join(os.uname()))
        run("crash")
        run("thread")
