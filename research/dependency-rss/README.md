# Dependency memory probe (issue #65)

Measures what each candidate crate adds to peak memory, alone, over a program
that does nothing. Each Cargo feature runs a small fixed workload shaped like
Fiber's use of that crate; `run.sh` builds one binary per feature and prints a
Markdown table of medians over 5 runs.

Linux reports peak RSS (`/usr/bin/time -v`). macOS reports peak memory
footprint (`/usr/bin/time -l`), because macOS RSS also counts shared system
framework pages. The ureq feature makes one live HTTPS request, so the probe
needs network.

Run `./run.sh`. The recorded figures and what they mean are in
`docs/dependencies.md`. Admitting a crate adds a feature and a workload here.

This is a standalone workspace. When Fiber's root `Cargo.toml` exists, list
`research/dependency-rss` in its `exclude`.
