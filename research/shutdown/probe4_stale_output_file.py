#!/usr/bin/env python3
"""Probe 4: after a crash, an orphaned background job keeps appending to
its output file (see probe 1, child D). If a new Fiber process starts up
and a NEW command opens or writes the same output file, does the old
orphan interfere?

This checks the ordinary POSIX append semantics: two independent
processes appending to the same file with O_APPEND interleave their
writes at whatever granularity the kernel guarantees (each write() is
atomic up to PIPE_BUF-ish sizes for regular files it's actually
per-write, guaranteed atomic for any single write() under a few KB on
both Darwin and Linux), they do not corrupt each other's bytes, and nothing
about the old process holizng the file open blocks a new writer or reader.
"""
import os
import subprocess
import time

WORKDIR = "/tmp/fiber-wt-shutdown-crash/research/shutdown"


def main():
    os.chdir(WORKDIR)
    shared_file = os.path.join(WORKDIR, "probe4_shared_output.txt")
    open(shared_file, "w").close()

    # "Old orphan" -- simulates child D from probe 1, still appending
    # after its Fiber died, and still holding the fd open.
    orphan = subprocess.Popen(
        ["bash", "-c",
         f"exec -a fiber_probe_orphan bash -c "
         f"'for i in 1 2 3 4 5 6 7 8; do echo orphan-$i >> {shared_file}; sleep 0.2; done'"],
        start_new_session=True,
    )

    time.sleep(0.5)
    print("orphan has been appending for 0.5s; file so far:")
    print(open(shared_file).read())

    # "New Fiber" starts a fresh command against the SAME file path,
    # exactly as a resumed Fiber might reuse a job-output path or a user
    # might just look at the file.
    newcomer = subprocess.run(
        ["bash", "-c", f"echo newcomer-hello >> {shared_file}"],
    )
    print("new process appended while the orphan still holds the file open.")
    print("new process exit code:", newcomer.returncode)

    # A plain read, as a "new Fiber" checking the file's current contents
    # would do -- does the orphan's open fd block or corrupt this read?
    contents_during = open(shared_file).read()
    print("\nfile contents while orphan is still alive and appending:")
    print(contents_during)

    orphan.wait()
    time.sleep(0.3)
    contents_after = open(shared_file).read()
    print("file contents after the orphan finally exits on its own:")
    print(contents_after)

    lines = [l for l in contents_after.splitlines() if l]
    interleaved_cleanly = "newcomer-hello" in lines and all(
        l.startswith("orphan-") or l == "newcomer-hello" for l in lines
    )
    print("\nlines interleaved without corruption:", interleaved_cleanly)
    os.remove(shared_file)


if __name__ == "__main__":
    main()
