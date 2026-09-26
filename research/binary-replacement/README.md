# Replacing a running binary (issue #91)

What happens to a running Fiber process when `fiber upgrade` replaces its
binary, and what the process gets when it starts itself again afterwards.

`main.rs` runs for 10 seconds. Every 250 ms it resolves its own path with
`std::env::current_exe()`, starts that path as a child, and logs the child's
version or the error. `run.sh` builds two versions, starts one copy of the
first version per method, and after about a second replaces each copy with
the second version: one by writing over the file in place (`cp`), one by
renaming a new file over it (`mv`).

Run `./run.sh` on the platform under test. It needs `rustc` and no network.

## Results

Measured September 25, 2026: macOS arm64 on Darwin 25.6.0 with the linker's
ad-hoc signature, and Linux x86_64 and arm64 on GitHub's `ubuntu-24.04` and
`ubuntu-24.04-arm` runners, Rust 1.98.1.

| | macOS arm64 | Linux x86_64 and arm64 |
|---|---|---|
| Write over the file in place | Allowed. The running process keeps running. Every child started from the file afterwards is killed with SIGKILL. | Refused: `Text file busy`. The file is unchanged. |
| Rename a new file over it | The running process keeps running. A child started from `current_exe()` runs the new version. | The running process keeps running. `current_exe()` returns `<path> (deleted)`, and starting it fails with `No such file or directory`. |

On both platforms, a running process survives either method. A process that
starts itself by `current_exe()` after a rename gets the new binary on macOS
and an error on Linux. A process that recorded its path at startup and starts
that path gets the new binary on both.

A Developer ID signed binary was not measured. The in-place result already
rules out writing in place, and a rename leaves the running process's file
untouched whatever signed it.

What Fiber does with this is `docs/releasing.md`, "How `fiber upgrade` replaces
the binary".
