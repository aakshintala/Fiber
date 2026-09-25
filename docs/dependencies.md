# Dependencies

Which crates Fiber depends on, which parts it writes itself, and what a crate
must pass to be admitted. This is what is true now, not a plan. It is settled
by
[Dependency policy: which crates, and what we write ourselves](https://github.com/aakshintala/fiber/issues/65);
that ticket's resolution holds the rationale and the rejected alternatives.

The crates are `docs/architecture.md`. Threads rather than an async runtime is
[ADR 0004](adr/0004-blocking-threads-no-async-runtime.md). Which CI jobs run
where is [CI](https://github.com/aakshintala/fiber/issues/62). What Fiber
promises about memory is
[Performance budgets](https://github.com/aakshintala/fiber/issues/67).

## Admitting a crate

Every direct dependency of every Fiber crate is listed in the tables on this
page, with what Fiber uses it for. CI fails when a `Cargo.toml` names a crate
that is not listed. Adding a crate therefore means editing this page in the
same pull request.

A crate is admitted when:

- its memory cost is measured and recorded here (see "Measuring memory")
- it does not need an async runtime, which ADR 0004 rules out; rmcp, reqwest
  and sqlx fail on this alone
- its licence is on the allowed list and it has no open advisory (see "Supply
  chain")
- writing the same thing ourselves would cost more than the crate

Fiber writes a thing itself when it is a small, fully specified format that
Fiber owns end to end, such as server-sent events or JSON-RPC. It also writes
one when the only crates for it fail the rules above.

Transitive crates are not listed. Each one's memory is counted in the direct
crate that pulls it in, and cargo-deny checks its licence and advisories.

Binary size is recorded, not gated per crate. The whole binary stays under 20
MiB. Compile time is not a criterion: CI caches built dependencies, and every
crate on this page together builds from clean in 16 seconds on macOS arm64.

## Measuring memory

`research/dependency-rss` measures each crate alone. A small program runs a
fixed workload shaped like Fiber's use of the crate, such as one HTTPS request
for ureq or 100 inserts in WAL mode for rusqlite. `run.sh` builds one binary
per crate and reports the median of 5 runs, minus a program that does nothing.

- Linux reports peak RSS.
- macOS reports peak memory footprint, the figure Activity Monitor shows.
  macOS RSS also counts system framework pages shared with every other
  process. A crate that links `Security.framework` shows about 4.5 MiB of RSS
  before it runs a line of code, and about 0.6 MiB of footprint.

A new crate gets a workload in the probe and a row here, measured on Linux
x86_64 and macOS arm64. A crate is measured again when its major version
changes. The numbers are the cost of admitting a crate. What a running session
holds, broken down by Fiber's own crates, belongs to the memory budget.

## Runtime dependencies

Memory is over a program that does nothing, in KiB, measured on
September 25, 2026 with rustc 1.98.1. Linux figures are GitHub's
`ubuntu-24.04` and `ubuntu-24.04-arm` runners; macOS is an Apple M3 Pro.
Differences under 100 KiB are run-to-run noise and show as ~0. Binary is the
stripped macOS release binary with only that crate, in KiB; the empty program
is 330 KiB.

Linux RSS counts the pages of the binary's own code that ran, and macOS
footprint does not. That is why rusqlite, whose SQLite code is 1.7 MiB, costs
about 2 MiB on Linux and 144 KiB on macOS.

| Crate | Used for | Linux x86_64 | Linux arm64 | macOS arm64 | Binary |
|---|---|---:|---:|---:|---:|
| serde, serde_json | the log, the event stream, every wire format | 200 | 204 | 128 | 414 |
| ureq | HTTP, behind a connector that keeps the socket | 2,872 | 2,576 | 1616 | 2147 |
| rustls-platform-verifier | trusting the operating system's root certificates | in ureq | in ureq | in ureq | in ureq |
| ratatui, crossterm | the terminal UI and terminal input | 1,384 | 1,488 | 1616 | 479 |
| rusqlite | the session index, with SQLite bundled | 2,184 | 1,932 | 144 | 2022 |
| mlua | the extension runtime, Lua 5.4 vendored | 964 | 716 | 96 | 703 |
| clap | the command line | 568 | 460 | 96 | 725 |
| thiserror | error types in library crates | ~0 | ~0 | 0 | 331 |
| signal-hook | SIGTERM, SIGINT and SIGHUP | ~0 | ~0 | 0 | 348 |
| getrandom | random ids | ~0 | ~0 | 16 | 331 |
| ring | SHA-256, for PKCE and extension binary checksums | 124 | ~0 | 16 | 331 |
| base64 | PKCE, and attachments sent to providers | ~0 | ~0 | 16 | 331 |
| rustix | the pseudo-terminal behind the shell tool's `tty` | ~0 | ~0 | 0 | 331 |

Notes:

- ureq's figure is one live HTTPS request to example.com, loading the
  operating system's trust store included.
- ratatui's figure is its two 200 by 50 screen buffers. Any full-screen
  terminal UI holds a screen model of that size.
- thiserror, signal-hook, getrandom, ring and rustix are already in the tree
  through other crates (rustls, crossterm, mlua), so listing them directly
  adds no crate.
- serde_json's `preserve_order` feature is never enabled
  (`docs/prompt-cache.md`).
- TLS uses ring as rustls's crypto provider. aws-lc-rs adds 6 crates and 663
  KiB for nothing Fiber needs.

### Root certificates

Fiber trusts the operating system's certificate store, through
rustls-platform-verifier, so a certificate installed by a company that
inspects TLS works as it does in curl or a browser. On Linux the verifier reads
only the system store. When that store is empty, as in a minimal container
without `ca-certificates`, Fiber falls back to Mozilla's root list, which is
compiled in through ureq.

## Waiting on other decisions

These crates are the choice if the named decision needs one. Each is measured
already.

| Crate | Needed if | Linux x86_64 | Linux arm64 | macOS arm64 | Binary |
|---|---|---:|---:|---:|---:|
| regex, ignore | [Search: built-in tools or the shell?](https://github.com/aakshintala/fiber/issues/54) keeps search built in | 1,804 / 1,424 | 1,612 / 1,232 | 1088 / 528 | 1660 / 1523 |
| similar | [File tools: read, write and edit](https://github.com/aakshintala/fiber/issues/52) shows a diff | 128 | 264 | 80 | 414 |
| pulldown-cmark | the terminal UI renders markdown ([Epic: TUI](https://github.com/aakshintala/fiber/issues/82)) | 468 | 272 | 144 | 593 |

regex and ignore share one regex engine, so both together add 1,692 KiB of
binary, not 3,183. About 440 KiB of regex is Unicode tables.

Syntax highlighting is the terminal UI's decision. The obvious crate, syntect,
costs 8,748 KiB on Linux x86_64 and 8,400 KiB of footprint on macOS just
to load its syntax definitions. It adds 26 crates, and cargo-deny fails it out
of the box on two unmaintained crates, yaml-rust and bincode.

## Written ourselves

| What | Why not a crate |
|---|---|
| Server-sent events parsing | a line protocol of a few dozen lines |
| MCP's JSON-RPC and both transports | rmcp needs tokio |
| BM25 for `tool_search` | one scoring formula over a few hundred short documents |
| The OAuth callback listener | one request on a `std::net::TcpListener` |
| File locking | `std::fs::File::lock`, stable since Rust 1.89 |
| Timestamps | the log's `ts` is milliseconds since the epoch, from `std::time` |

Fiber uses the system allocator. Whether another allocator lowers resident
memory is for the memory budget to measure.

## Tests and development tools

Dev-dependencies are compiled only into tests, so they have no memory row.
They are listed here and CI checks them like any other.

| Crate or tool | Kind | Used for |
|---|---|---|
| insta | dev-dependency | whole-screen and value snapshots (`docs/testing.md`) |
| proptest | dev-dependency | property tests that shrink and replay a failing case by seed |
| cargo-nextest | tool | running tests, one process each |
| cargo-mutants | tool | the mutation check on every pull request |
| cargo-deny | tool | licences, advisories and crate sources |

## Supply chain

- `Cargo.lock` is committed. Fiber is a binary, and a release must build from
  exactly the versions that were tested.
- cargo-deny runs in CI and checks licences, advisories and that every crate
  comes from crates.io.
- Allowed licences: MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception,
  BSD-2-Clause, BSD-3-Clause, ISC, Zlib, BSL-1.0, Unicode-3.0,
  CDLA-Permissive-2.0, Unlicense, CC0-1.0 and MIT-0. Every crate above uses
  only these.
- An advisory fails the build, including one that marks a crate unmaintained.
  An exception names the advisory, the path that pulls the crate in and the
  condition for removing the exception, as codex's `deny.toml` does.

## Toolchain

Fiber has no separate minimum supported Rust version. It is a binary, not a
library, so the toolchain CI pins is the only version Fiber supports.
