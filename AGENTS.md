# Fiber agent instructions

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

## Continuous integration

Do not run the complete deterministic suite locally as the default loop. Run the
focused test for the changed path, build, and exercise that path with
`./zig-out/bin/fiber`.

Then commit, push the branch, and open a draft pull request. `ci.yml` is the only
entrypoint, and scope follows the pull request's state:

* **Draft** runs the static gates (formatting, public-surface audit, PGSO
  corpus validation, release-decision tests), the Linux x86_64 build, unit
  tests, smoke, and the four duration-balanced Linux x86_64 E2E shards. Fast
  feedback while the work is still moving; agents should use this instead of
  running the suite locally.
* **Ready** adds only what draft did not run: the remaining native platforms
  (`ubuntu-24.04-arm`, `macos-15`), the same four E2E shards on those
  platforms, benchmarks, the three-platform binary size comparison, and the
  isolated MCP conformance package.
* Docs-only changes skip the heavy legs in both scopes; the static gates
  still run on every push.

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
never rerun a failed test to green. The one exception is the workflow's own
single per-file E2E retry, which is automatic and annotated: a pass-after-retry
(red Flake watch next to green CI) means filing or updating a flake issue for
the test and moving on. Deflake by rewriting the test.

Merging does not require the branch to be current with main. Rebase only to
pick up something the branch needs, never just to re-run green CI. The
`main-backstop` workflow builds and unit-tests every merge to main; a red
backstop run means main is broken, so stop the line and fix forward. Live
model evals stay separate because they need credentials and are not
deterministic.

A ready pull request stays ready while you repair it. Draft scope skips the
ready-only jobs, so a fix pushed to a draft pull request is never checked by the
job that failed. Push the fix to the ready pull request and read the new run.

The macOS arm64 PGSO candidate workflow does not run on pull requests. When a
change touches `build.zig` or `scripts/pgso/`, dispatch it with
`workflow_dispatch` on the pull request's head commit only after the ready run
passes — it uses `cancel-in-progress` on the branch ref, so dispatching earlier
just gets cancelled by the next push — and do not merge until that run passes.

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

## Design proposals

A workstream too large for an issue body gets a proposal directory,
`docs/proposals/<workstream>/`: an overview plus one file per slice. Land it on
`main` as its own small pull request before implementation starts, so agents on
other branches can read it.

A proposal is scaffolding. When a slice merges, delete its proposal file in the
same pull request and move whatever must stay true into `docs/<area>.md` as
product and architecture documentation. The decision record, with rationale and
rejected alternatives, stays on the issue.

`docs/*.md` is what is true now. `docs/proposals/**` is what is being decided.
`README.md` stays short and links into `docs/`; reference material and schemas
never live there.

## Upstream harvest

`vercel-labs/fx` is the upstream Fiber forked from. Its remote is fetch-only, and
its push URL is set to `no-push`.

Read upstream freely for ideas. Reimplement anything worth taking under Fiber's
current contracts, and attribute it.

Never merge or cherry-pick upstream history. The fork diverged deliberately:
fx's identity, release machinery, CDN distribution, and provider surface are all
things Fiber removed on purpose, so upstream commits carry that machinery back in
with whatever else they bring.

## Reference

Read the matching file when the work calls for it. Each is the single source of
truth for its area.

* Rendering defects, tmux repros, tape recording and replay: [`docs/render-bugs.md`](docs/render-bugs.md)
* Bun suites under `tests/e2e/` and `tests/evals/`: [`tests/README.md`](tests/README.md)
* Startup latency budgets and binary size deltas: [`benchmarks/README.md`](benchmarks/README.md)
* Cutting a release, writing the changelog: [`docs/releasing.md`](docs/releasing.md)
* Model routing, connections, providers (accepted, in flight): [`docs/proposals/model-routing/README.md`](docs/proposals/model-routing/README.md)
* PGSO corpus classification, pinned toolchain, local reproduction: [`scripts/pgso/README.md`](scripts/pgso/README.md)

## Documentation

When adding or changing user-facing features, update **all** relevant files:

1. `--help` output via command specs in `src/core/slash_commands/command_specs.zig`
2. `README.md` — feature descriptions, usage examples
3. `CONTRIBUTING.md` — if build steps, config, or collaboration rules change

Do not document intended behavior as if it already exists.

## Repository and License

The canonical repository is `aakshintala/Fiber` on GitHub. All URLs, links, and references to this repo must use `aakshintala/Fiber`. `vercel-labs/fx` is the upstream project Fiber was forked from; reference it only for attribution and history, never as this repository. Licensed under Apache-2.0.

## What Not To Do

* Do not grow `main.zig` with leaf feature logic

* Do not add hidden product state that only exists in the live shell

* Do not add a second execution path for the same feature without a clear reason

* Do not commit generated state from `.fiber/`, `.zig-cache/`, or `zig-out/`

* Do not add dependencies outside the Zig standard library without discussion

* Do not create git tags manually (the release workflow owns tag creation)
