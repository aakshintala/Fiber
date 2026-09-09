# AGENTS.md

Instructions for AI coding agents working with this codebase.

## Declaring Work Ready

Do not say the work is "ready", "done", "good to go", "complete", or similar until you have personally run the binary and exercised the change on its happy path. A passing test suite is necessary, not sufficient — tests in this repo do not always construct the full runtime, attach a TTY, or spawn background threads, so they will not catch startup crashes, render regressions, or thread-lifetime bugs.

Before reporting the work as ready:

1. Build succeeds.
2. Focused tests for the changed path pass locally.
3. The `CI` check passes for the exact current commit on the pull request.
4. Run the built binary locally and drive at least one real interaction that exercises the change end to end.
5. Confirm the process did not abort, stderr is clean, and the behavior matches what you are about to tell the user.
6. Update the documents listed under **Documentation** if behavior changed.

If you cannot run the binary in your environment, say so explicitly and ask the user to verify. Do not silently skip this step and declare the work ready. "The tests pass" is not a substitute for running the app.

### Always use the built binary in this repo

Verify with the freshly-built binary at `./zig-out/bin/fiber` from this checkout. It is the only binary that contains your change; `zig build` writes nothing else. A `fiber` on `PATH` is some other build, and once installation exists it will live in `~/.local/bin/`.

In every shell invocation, tmux included, use `./zig-out/bin/fiber` or its absolute path. Bare `fiber` is always wrong for verification.

When a user reports "still not working", assume your fix is incomplete and keep investigating. If you genuinely suspect a PATH mismatch, ask; copying binaries into their install directory hides the problem instead of finding it.

## Language and Toolchain

This project is written in **Zig 0.16+**. There is no Node.js runtime, no `package.json` at the root, and no JavaScript build step for the main binary.

Build and test commands:

```bash
zig build          # build the binary
zig build test     # run all unit tests
zig build run      # build and run
zig fmt src/       # format all source files
```

The test suites under `tests/` use Bun but are separate from the Zig codebase. See **Testing** below.

## Code Style

* Format all Zig source with `zig fmt` before committing. The canonical check is `zig fmt src/`.

* Do not use emojis in code, output, or documentation. Unicode symbols (e.g. checkmark, arrow) are acceptable.

* In documentation, never use double hyphens (`--`) as a dash. Use an emdash (—) sparingly, or rewrite to avoid dashes.

* CLI flags use kebab-case (e.g. `--no-save`, `--json`). Never use camelCase for flags.

* Prefer `snake_case` for all Zig identifiers. Types use `PascalCase` per Zig convention.

* Keep `pub` surface area minimal. Only mark declarations `pub` when they are used outside the file.

## Architecture

Key rules:

* `src/main.zig` is the composition root. Do not add leaf feature logic here.

* `src/core/` owns contracts, runtimes, config, sessions, permissions, MCP, skills.

* `src/tools/` owns built-in tool implementations. Generic tool contracts and dispatch live in `src/core/tooling/`. Default tool specs are centralized in `src/core/tooling/tool_specs.zig` or `src/builtins/tools.zig`, not in individual tool files.

* `src/ui/` owns terminal rendering, event loop, input, transcript. It must not own product state.

* `src/gateway/` owns provider transport. It must not absorb product-state logic.

### Adding a Feature

Before implementing, answer in order:

1. Which module owns the behavior?
2. What is the typed contract?
3. Does it need persistence?
4. Does it need both text and JSON output?
5. What docs and tests land with it?
6. How is its deterministic E2E owner classified in the macOS arm64 PGSO corpus?

If unclear, define the contract first.

Every root `tests/e2e/*.test.ts` file must have exactly one classification in
`scripts/pgso/corpus.json`:

* **Training:** common or performance-sensitive product behavior that should
  influence LLVM's hot and cold decisions

* **Verification-only:** important correctness, recovery, security, or rare
  behavior that the final candidate must pass without making it hot

* **Intentional exclusion:** nondeterministic, live-network, credentialed,
  sound-related, or harness-only coverage, with a concrete reason

New tests inside an already classified file inherit that file's classification,
but feature work must reconsider whether the existing classification still
matches the file's product role. When removing a feature or E2E owner, remove
its stale corpus entry. Normal PR CI loads the corpus and rejects missing,
duplicate, stale, or unclassified files without running the expensive PGSO
qualification.

### Adding a Command

1. Add the spec to `src/core/slash_commands/command_specs.zig`
2. Add dispatch wiring in `src/core/cli/cli_surface.zig`
3. Add a snapshot type if it has structured output
4. Render text and JSON from the same snapshot via `src/core/output/output_contracts.zig`

Do not scatter help text or argument parsing across multiple files.

## Configuration and State

Profile configuration and runtime state lives under `~/.fiber/`. Project `.fiber.json` contains committed project defaults only.

Config precedence (highest wins):

1. Environment variables such as `FIBER_MODEL`, `FIBER_PERMISSION_MODE`, and `FIBER_MAX_AGENT_STEPS`
2. `~/.fiber/settings.json` → `workspaces["<workspace_path>"]` (profile workspace overrides)
3. `~/.fiber/settings.json` top-level (profile global settings)
4. `<workspace>/.fiber.json` (committed project defaults)
5. Built-in defaults

Project `.fiber.json` accepts only repo-safe defaults: `sandbox`, `max_agent_steps`, `max_tool_result_bytes`, and `context`. Profile-owned keys such as `model`, `effort`, `slash_menu_categories`, `startup_scrollback`, `prompt_history`, `statusLine`, `skill_match_fuzzy`, `first_call_tool_choice`, `auto_upgrade`, `permission_mode`, and `permission` are ignored from project config before their values are parsed.

Runtime state lives under `~/.fiber/sessions/<session-id>/` (`session.json`, `background/`, `subagent/`, `logs/`). Sessions are global and portable across workspaces. Each session tracks its `workspace_root`, which updates when resumed in a different workspace. A subagent child is an internal ordinary session with its own history. Its parent owns one bounded `subagent/children.json` registry, and the child carries only an immutable owner marker. Child sessions stay out of ordinary session discovery and cannot be resumed directly. A first `subagent.message` creates a named persistent child in that parent; later messages continue it, and optional instructions replace only its child-specific system overlay.

## Permissions

Security is permission-first. All sensitive tool behavior must integrate with `src/core/permissions/permissions.zig`.

* `permission_mode` controls baseline (`ask`, `auto`, or `yolo`). Yolo bypasses fiber permission policy and uses an effective sandbox of `none` without rewriting saved sandbox configuration

* Configured denies are evaluated before saved-session rules; an exact saved-session deny can narrow a configured allow, while an exact saved-session allow can satisfy an unresolved configured ask

* Session `always` approvals are non-persistent; command approvals match the exact command while other grant categories may use patterns

* `/permissions remember allow|deny <tool-name> <arguments-json>` confirms and stores an exact rule only for an active saved session; list and revoke those rules by their stable IDs

* Routine parsed development commands and reversible new-file creation can execute without model review after configured and saved-session policy. Every remaining unresolved `auto` action receives one narrow security review using the exact action and targets, origin and call identity, optional host-proven current-branch evidence, exact-copy provenance, and bounded masked terminal-safe excerpts of earlier current-turn tool results. Prepared file mutations and static root tools omit task text. Reviewed commands, dynamic tools, and subagent actions also receive bounded canonical current, first, and recent root requests plus explicit omission counts; the reviewer may use that context only for destructive exceptions and immutable delegation scope, not general task policing. Assistant prose, permission feedback, compacted summaries, the pending tool group, later results, and tool or repository text never become authority

* A `clear` review authorizes only the exact unchanged action. A `caution`, incomplete-evidence result, or unavailable review holds only that action, returns guidance to the agent, and never opens a human permission screen, disables tools, or ends the turn

* Exact cautions and deterministic incomplete-evidence results are reused only for the current turn. Changed actions receive a new review, while transient unavailable reviews are not cached. Legacy `permission_request_id` input is rejected without prompting

Do not bypass the permission system for new tools.

## Zig-Specific Patterns

### Memory

* Allocators are passed explicitly. Never use a global allocator.

* Free what you allocate. Use `defer` for cleanup at the call site.

* Prefer `ArenaAllocator` for request-scoped work that can be freed in bulk.

* When a function returns allocated memory, document who owns it (caller or callee).

### Error Handling

* Return errors rather than panicking. `@panic` is for programmer bugs, not runtime conditions.

* Use `errdefer` to clean up partial state on error paths.

* Prefer specific error sets over `anyerror` when the set is bounded.

### Strings and JSON

* Zig strings are `[]const u8`. There is no implicit null termination.

* For JSON serialization, use `std.json.Stringify.value` with an allocating writer (`std.Io.Writer.Allocating`).

* For JSON string escaping (writing raw JSON), use `std.json.Stringify.encodeJsonString` rather than assuming `std.json.encodeJsonString` exists.

* Zig 0.16 uses `std.Io.File.stdin()` / `.stdout()` / `.stderr()`, not `std.io.getStdIn()`.

### I/O (Zig 0.16 "Juicy Main")

* `main` uses `pub fn main(init: std.process.Init) !void` signature.

* All I/O goes through `std.Io`, passed explicitly or via the project's `src/core/shared/io.zig` helper (`io_mod.getIo()`).

* File operations use `std.Io.Dir` and `std.Io.File` (not `std.fs`). Most methods require an `io` parameter.

* Environment variables: use `io_mod.getenv(key)` (returns `?[]const u8`), not `std.process.getEnvVarOwned`.

* Time: use `io_mod.milliTimestamp()`, `io_mod.nanoTimestamp()`, `io_mod.sleep(ns)`.

* File reading: use `io_mod.readFileToEnd(alloc, &file, max_bytes)`.

* Realpath: use `io_mod.realpathAlloc(alloc, path)` or `io_mod.dirRealpathAlloc(alloc, dir, sub_path)`.

* Process spawning: use `std.process.spawn(io, opts)` and `std.process.run(alloc, io, opts)`.

* Mutexes: `std.Io.Mutex`, initialized with `.init`, locked with `.lockUncancelable(io)`.

* HTTP: `std.http.Client` requires `.io = io_mod.getIo()` in its initializer.

* `std.mem` renames: `trimLeft` is `trimStart`, `trimRight` is `trimEnd`, `indexOf` is `find`, `indexOfScalar` is `findScalar`.

* `ArrayList(T)` initializes with `.empty` (not `.{}`).

### Testing

* Zig unit tests go inside the source file they test, using `test "description" { ... }` blocks.

* Run the narrowest relevant tests while developing. The complete `zig build test` suite runs in ReleaseSafe on every pull request, and must pass before the pull request is marked ready.

* Use `std.testing.expect`, `std.testing.expectEqual`, `std.testing.expectEqualStrings` for assertions.

* In test blocks, use `std.testing.io` for the `Io` parameter. `io_mod.getIo()` automatically returns `std.testing.io` in test builds.

* Use `io_mod.dirRealpathAlloc(alloc, dir, sub_path)` to resolve paths within `std.testing.tmpDir()`.

## Testing (TypeScript)

Two test suites live under `tests/`, both using Bun:

### `tests/evals/` — LLM Evals

Eval scenarios that exercise the agent through `fiber ask --json`. Require `AI_GATEWAY_API_KEY`.

```bash
cd tests/evals && bun install && bun test           # run all evals
cd tests/evals && bun run eval:matrix               # cross-model matrix run
```

### `tests/e2e/` — End-to-End Tests

Deterministic runtime tests (CLI commands, TUI via tmux). No API key needed for most.

```bash
cd tests/e2e && bun install && bun test              # run all e2e tests
cd tests/e2e && bun test cli.test.ts                 # just CLI tests
cd tests/e2e && bun test tui-*.test.ts               # just TUI tests (requires tmux)
```

TUI tests use tmux to drive the interactive terminal. They require `tmux` to be installed.

## Continuous integration

Do not run the complete deterministic suite locally as the default loop. Run the
focused test for the changed path, build, and exercise that path with
`./zig-out/bin/fiber`.

Then commit, push the branch, and open a draft pull request. `ci.yml` is the only
entrypoint, and scope follows the pull request's state:

* **Draft** runs Linux x86_64 formatting, the public-surface audit, PGSO corpus
  validation, the release-decision tests, build, unit tests, and smoke. Fast
  feedback while the work is still moving.
* **Ready** adds the three-platform native matrix (`ubuntu-24.04`,
  `ubuntu-24.04-arm`, `macos-15`), four duration-balanced ReleaseSafe E2E shards
  per platform, benchmarks, the three-platform binary size comparison, and the
  isolated MCP conformance package.

A push does not trigger CI. A branch with no pull request has nothing to gate,
and `release.yml` owns `main`.

One job, `aggregate`, emits the single required check. It is named `CI` on a
pull request and `Manual CI` on a `workflow_dispatch`, because GitHub matches a
required check by name on the head commit and ignores which event produced it.
It fails if any selected job failed or was cancelled, and passes when unselected
jobs are skipped.

Marking a pull request ready re-runs CI on the same commit, so the ready-scope
result supersedes the draft one. Evidence comes only from the current run: a
result from an ancestor commit does not count.

A failed check is evidence. Repair it in a new commit and let CI run again;
never rerun a failed test to green. Live model evals stay separate because they
need credentials and are not deterministic.

## Merge authority

Open a draft pull request as soon as the branch is pushed, and mark it ready once
the gate passes.

Land a ready pull request without asking when all of these hold:

* It is small, reversible, and test-backed.
* It implements an approved contract or existing behavior rather than inventing
  new behavior.
* It adds no dependency.
* It touches no security, permission, authentication, persistence, release, CI,
  ruleset, or public compatibility boundary.
* Independent standards and spec review left no unresolved blocker or concern.

Everything else waits for the owner: new behavior, ambiguous defects, scope
changes, and destructive work.

The boundary list is the point. Agents act through the owner's GitHub account, so
a review approval carries no independent signal and the ruleset requires zero
approvals. Owner judgement is the only real check on those surfaces, which is why
they are named explicitly rather than left to taste.

## Future work

Anything worth doing later belongs in a GitHub issue, recorded as the user
outcome, the evidence, and the constraints worth preserving.

Keep it there rather than in a local planning document, backlog file, or ideas
directory. A file in the repo drifts from the code as soon as it is written, and
only whoever opens that file ever sees it.

## Upstream harvest

`vercel-labs/fx` is the upstream Fiber forked from. Its remote is fetch-only, and
its push URL is set to `no-push`.

Read upstream freely for ideas. Reimplement anything worth taking under Fiber's
current contracts, and attribute it.

Never merge or cherry-pick upstream history. The fork diverged deliberately:
fx's identity, release machinery, CDN distribution, and provider surface are all
things Fiber removed on purpose, so upstream commits carry that machinery back in
with whatever else they bring.

## Reproducing Render Bugs

fiber's rendering is inline by default and deliberately emits a small ANSI subset. Three owner classes are the narrow exceptions, and each takes the alternate buffer exclusively through `AlternateScreenOwner` in `src/ui/shell_runtime.zig`: interactive permission review, the full-transcript screen, and catalog menus. Only one class may own the buffer at a time, and each must leave it and restore the main grid, composer, cursor, paste, mouse, focus, and keyboard modes when it closes. Transcript rendering, question prompts, command-output expansion, and subagent delegation remain inline. Three tools exist for reproducing and regression-proofing render bugs:

### tmux (live TTY repros)

Best for resize and SIGWINCH interactions. The helper in `tests/e2e/tmux-helpers.ts` exposes `resizeWindow(cols, rows)`, `capturePaneGrid()`, and `capturePaneEscapes()`. See `tests/e2e/tui-resize.test.ts` for the canonical resize matrix.

```bash
cd tests/e2e && bun test tui-resize.test.ts
```

### Debug terminal recording and replay

Set `FIBER_DEBUG_RECORD=1` to create an automatic private tape under
`~/.fiber/recordings/`. Set `FIBER_DEBUG_RECORD_SILENT_BANNER=1` as well when the
developer-only recording notice must stay out of the inline transcript during
a screen share. The notice remains available in the Ctrl+O full transcript.
Use `FIBER_RECORD=<path>` when a test or investigation needs an exact destination.
Recording dumps every byte fiber writes and every resize into a framed binary tape.
Replay the tape through the built-in virtual terminal:

```bash
FIBER_DEBUG_RECORD=1 ./zig-out/bin/fiber
FIBER_RECORD=/tmp/bug.fxtape ./zig-out/bin/fiber
./zig-out/bin/fiber replay /tmp/bug.fxtape
./zig-out/bin/fiber replay /tmp/bug.fxtape --frames
./zig-out/bin/fiber replay /tmp/bug.fxtape --json
./zig-out/bin/fiber replay /tmp/bug.fxtape --golden out.txt
```

The tape is deterministic — any reviewer can replay it without a TTY, and a golden file can be checked in as a regression test.

### Shared terminal engine (sub-second unit tests)

`src/core/terminal/engine.zig` is the shared bounded text-terminal engine for hosted terminal sessions, recovery, replay, and deterministic rendering tests. `src/ui/resize_tests.zig` drives `TranscriptRuntime` against it in process so resize behavior can be exercised with no fd or timing dependence.

```bash
zig build test                      # runs every VT and resize test
```

When a tmux or tape-based scenario exposes a bug, reproduce it as a Zig unit test in `resize_tests.zig` (or a new sibling) before fixing. The test lands the fix as a regression.

## Benchmarks

Startup latency benchmarks live in `benchmarks/` and run as the `bench` job of `ci.yml` on ready pull requests.

```bash
./benchmarks/startup.sh            # full run (100 iterations, builds ReleaseSafe, needs hyperfine)
./benchmarks/startup.sh --quick    # quick run (20 iterations)
```

The job builds a ReleaseSafe binary, measures the startup path plus `help`, `status --json`, `doctor --json`, and `sessions --json` with hyperfine, and enforces per-command latency budgets. A pull request that exceeds a budget fails the check. Budgets are absolute, so no baseline from `main` is needed and none is stored.

The startup benchmark uses `FIBER_BENCH=1`, an environment variable that runs through arg parsing and CLI dispatch, then exits before TTY initialization. This lives in `src/core/app/app_entry_runtime.zig`.

Current raw wall-clock contract:

* Linux CI: 2ms for every command
* Non-Linux local runs: informational raw means

The Linux CI runner is the authoritative product budget. Local macOS process
and dynamic-loader floors vary enough to exceed 2ms independently of fiber, so
local runs report raw means without assigning a substitute product budget. The
process baseline is diagnostic only and is never subtracted.

When adding features, consider their impact on startup latency. The `fiber help` path is the baseline cold-start benchmark.

## Binary Size Observability

Every ready pull request runs the `binary-size` job of `ci.yml` across Linux
x86_64, Linux arm64, and macOS arm64. Each matrix job builds the pull
request merge commit and its base commit as stripped ReleaseSafe binaries on
the same native runner, then reports the exact byte and MiB delta plus ELF or
Mach-O section changes.

Each platform check is informational. An increase of at least 52,429 bytes
(0.050000 MiB) emits a warning and retains that platform's binaries for
investigation, but does not reject the pull request. Investigate notable
unexplained growth before changing the threshold. The full macOS arm64 PGSO
release qualification remains authoritative for the 7.800 MiB production
ceiling and performance gates.

## Documentation

When adding or changing user-facing features, update **all** relevant files:

1. `--help` output via command specs in `src/core/slash_commands/command_specs.zig`
2. `README.md` — feature descriptions, usage examples
3. `CONTRIBUTING.md` — if build steps, config, or collaboration rules change

Do not document intended behavior as if it already exists.

## Releasing

Fiber publishes no releases yet. The version is `0.0.1-dev`, and
`release.yml` refuses to publish any SemVer prerelease, so merging to `main`
cannot cut a release. There is no installation or upgrade path: `fiber upgrade`
fails with `UpgradeUnavailable` until a release source exists. Building
distribution is tracked as a GitHub issue, not attempted here.

When a stable release does happen, `release.yml` owns it. On a push to `main` it
reads the version from `src/main.zig` through `scripts/release_decision.py`. A
prerelease is refused before the tag is ever consulted. A stable version whose
tag is missing cross-compiles the platform binaries, creates the tag, and
publishes a GitHub Release whose body is the content between the
`<!-- release:start -->` and `<!-- release:end -->` markers in `CHANGELOG.md`.

Never create a version tag by hand; the workflow owns tag creation. Leave the
`build.zig.zon` version alone, it is a placeholder.

### Writing the changelog

Whether automated or manual, the changelog is public product copy. Describe observable user behavior, not the engineering process behind it. Use the diff, commits, and merged pull requests as research evidence only.

Public changelog entries must:

* Spell the product name `fiber`. Preserve different casing only when it is part of an exact code identifier such as `FIBER_MODEL`.
* Use only relevant sections from `### Breaking Changes`, `### New Features`, `### Improvements`, `### Bug Fixes`, and `### Security`. Omit empty sections.
* Bold a short feature or fix name, then describe the user-visible change after a colon.
* Omit pull request numbers, issue numbers, commit hashes, contributor names, and author attribution.
* Omit internal details such as repository moves, website or marketing work, CDN layout, CI workflows, test fixtures, branch history, and implementation-only refactors. Translate relevant work into its public user outcome or leave it out.
* Avoid forcing every merged change into the notes. A change without a public user outcome does not need a bullet.

Only the current release should have markers; remove `<!-- release:start -->` and `<!-- release:end -->` from any previous entry:

```markdown
## 0.3.0

<!-- release:start -->
### New Features

- **Interactive terminal startup:** Start an interactive shell when the `terminal` tool receives an empty command
<!-- release:end -->

## 0.2.5

### Improvements

- **Inline rendering:** Keep the active conversation visible in terminal scrollback
```

Do not add a `### Contributors` section or tracker references. Use descriptive section names.

Do not create version tags manually. Do not change `build.zig.zon` version (it is a placeholder).

## Repository and License

The canonical repository is `aakshintala/Fiber` on GitHub. All URLs, links, and references to this repo must use `aakshintala/Fiber`. `vercel-labs/fx` is the upstream project Fiber was forked from; reference it only for attribution and history, never as this repository. Licensed under Apache-2.0.

## What Not To Do

* Do not grow `main.zig` with leaf feature logic

* Do not add hidden product state that only exists in the live shell

* Do not add a second execution path for the same feature without a clear reason

* Do not commit generated state from `.fiber/`, `.zig-cache/`, or `zig-out/`

* Do not add dependencies outside the Zig standard library without discussion

* Do not create git tags manually (the release workflow owns tag creation)
