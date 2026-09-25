# Testing

How Fiber is tested: what a test asserts, at which level, and against what.
This is what is true now, not a plan. It is settled by
[Testing posture: what a test asserts, and against what](https://github.com/aakshintala/fiber/issues/63);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. The event stream is `docs/events.md`; the crates
are `docs/architecture.md`. Which CI jobs run on which runners is
[CI](https://github.com/aakshintala/fiber/issues/62). Latency, memory and
storage budgets are
[Performance budgets](https://github.com/aakshintala/fiber/issues/67). No
test asserts on time.

## Levels

Tests sit at three levels. Each proves something the others cannot.

- **Inside a crate.** Tests beside the code may call private functions freely.
  Every behaviour a crate exposes also has at least one test through its public
  API, so the wiring between helpers is tested, not just the helpers.
- **Across crates.** The loop runs with test tools and a test provider plugged
  into its seams, exactly as an extension would plug in. These tests prove turn
  and step behaviour without a binary or a network.
- **The binary.** A test spawns the built `fiber`, drives it through a door,
  and reads what a consumer reads: the JSON lines and the session directory
  left behind.

A binary-level test needs no test-only switch in the shipped binary. It sets
`FIBER_HOME` to its own temporary directory, which holds an ordinary provider
definition whose base URL points at a local fake server.

Tests are Rust, run by cargo. There is no second test language.

## What a test asserts

A test asserts on what a consumer sees, as `docs/events.md` rules: "the lines
and the file left behind". Code no consumer sees is tested through its crate's
public API.

### Event streams

An event-stream test asserts two things:

- the complete, ordered list of event kinds, so a duplicated, missing or
  reordered event fails
- the fields under test, on the lines under test

It ignores fields it is not testing, as a conforming consumer must: adding a
field is a compatible change (`docs/events.md`, "Versioning"), so a test that
failed on one would be stricter than the contract.

The central invariant, durable output equals the log byte for byte, is
asserted as plain equality between the two.

A test asserts at least one positive fact. A check that only says something
did not happen passes when the feature never ran.

### Values that change every run

Binary-level tests replace `ts`, ids and durations with placeholders before
comparing. Behaviour that depends on time, such as a monitor's deadline or a
retry's backoff, is tested at crate level under an injected clock. No test
sleeps on the wall clock (`docs/tools.md`, "Background jobs").

### Screens

The terminal UI is tested by feeding a sequence of events to its drawing code
and comparing the whole in-memory screen (ratatui's `TestBackend`) against a
stored snapshot. CI never writes a snapshot: a changed screen fails and shows
the difference, and an accepted change appears in the pull request.

A few tests run the real binary in a pseudo-terminal, only for what memory
cannot show: raw mode, resize, and the terminal restored on exit.

### Invariants

The `log` and `loop` crates carry property tests: generated sequences, shrunk
to a minimal failing case and replayable by seed, checked against each crate's
stated invariants rather than a fixed expected output. For example:

- `log`: durable output equals the log; a session killed at a random point
  reopens intact
- `loop`: no turn is lost; nothing a cancelled call produces is admitted after
  the cancel, including when cancel races a tool result

## Model calls

Nothing in CI calls a live provider or the public network. Provider bytes in
tests come from two sources:

- **Recorded streams.** Real responses from each protocol, captured with live
  keys by a manual script and checked in. They are replayed byte for byte
  against the provider crate's decoders. A recording keeps response bytes only,
  never request headers or keys. It is re-recorded when a vendor change is
  suspected.
- **Scripted streams.** Hand-written in the real wire format, for scenarios a
  recording cannot produce on demand, such as a tool call, then a 429, then
  text. A local fake server serves them to the binary and to cross-crate tests.

The five first-party provider extensions are tested in Fiber's CI, loaded into
the built binary by local path: against their vendor's recorded streams and
against scripted streams. A protocol change that breaks a shipped provider
fails the pull request that caused it.

Tests that need live credentials are opt-in by environment variable and never
run in CI.

An eval measures the model plus Fiber's prompting as a pass rate over many
runs. It is a development instrument for prompts and tool definitions. No eval
gates a merge or a release.

## Proving a test bites

A test that passes with its feature removed proves nothing. CI checks this on
every pull request with mutation testing: `cargo-mutants --in-diff` makes small
breaking edits to the code the diff changed, such as replacing a function body
with a default or flipping a comparison, and runs the mutated crate's tests
against each one. An edit that no test notices fails CI.

An edit that genuinely changes no behaviour is exempted in the code, with a
written reason. How many runners share the mutants is CI's to set.

Diff-scoped mutation testing cannot see a change in one place leaving other
code under-tested, and a diff that changes only test code runs no mutants.

## Running tests

Tests run under cargo-nextest. Each test runs in its own process, so a leaked
child or a wedged test cannot affect the next one. A filter that matches no
tests fails: nextest exits 4 with "no tests to run", where `cargo test` prints
"0 passed" and exits 0. Doc-tests run under `cargo test --doc`.

Every test runs on all three release targets. A test that applies to one
platform is compiled only for that platform, never skipped at runtime.

Each test uses its own temporary directory and checks only its own processes
and files, never a machine-wide count.

### Waits and timeouts

A test waits for a named signal: an event, or a file that exists. It never
waits for a generic sign that things have settled, because "the screen stopped
changing" is not "the server is listening".

Every wait has a deadline. On expiry the test fails with an assertion naming
what it waited for. nextest's per-test timeout is at least twice the sum of the
test's own deadlines, so a hang reports which wait expired, not a harness kill.

### Flaky tests

A failed binary-level test retries once. A pass on retry does not block the
merge, but CI reports it, and it must map to a flake issue. A flake issue
closes when the test is rewritten to be deterministic, never by rerunning.

Crate-level and cross-crate tests never retry: they are deterministic, so a
failure there is signal.

## What a change ships with

- **Any change:** the mutation check passes, and every behaviour a crate
  exposes has a public-API test.
- **A bug fix:** a test that reproduces the report at the level it was
  observed and fails on the code before the fix. A bug seen on screen gets a
  screen test; a bug in the JSON lines gets a binary-level test.
- **A new event kind:** a binary-level test in which a consumer sees it.
- **A breaking log format change:** its migration and the migration's test
  (`docs/events.md`, "Versioning").
- **A grown tool definition:** a raised size budget in the same pull request
  (`docs/tools.md`, "Size budget in CI").
