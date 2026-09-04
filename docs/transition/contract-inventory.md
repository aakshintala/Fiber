# Fiber contract matrix (Phase 3)

Scope: the command, flag, session, authentication, permission, MCP,
model-routing, usage, and JSON-output contracts named in
[`../ideas/fiber-product-transition.md`](../ideas/fiber-product-transition.md).

This document is the Phase 3 source of truth. It measures the current surface,
records the contract decisions every slice conforms to, and carries one matrix
row per target item so that nothing reaches a slice as an unenumerated bag.

It is a transition artifact and is deleted at the end of Phase 6. Before that
happens, Phase 6 harvests the *rationale* recorded here into product
documentation. User-facing descriptions are not harvested from here: the
command specs in `src/builtins/commands.zig` own that text, and product docs are
generated from the built binary's `--help` and `--json` output. A matrix row and
a help string are two places for one sentence, and the binary wins.

Enhancement work deferred out of Phase 3 lives in
[`../enhancements/pending.md`](../enhancements/pending.md).

## Status

Rewritten 2026-09-04 after a contract-planning pass that corrected several
errors in the previous revision. The corrections are recorded rather than
silently applied, because two of them were in sections marked "decided":

- The permission-rule syntax named a `{tool, pattern, action}` triple. The stored field is `permission` and holds a *category* (`bash`, `edit`, `read`, `web_fetch`, `*`), not a tool name; `removePermissionRule` takes no action; storage is nested, not a triple; and every mutation takes a scope the command did not express.
- Exit status claimed 130 and 143 were "already in place, unchanged." They are computed and then discarded.
- Slice 3 ("fast as a model property") rested on a reading of the design that contradicted how the gateway works. Fast is a service tier, not a model identity. The design sentence was rewritten rather than the code.
- ACP is deleted rather than reshaped, removing three slices from this phase. See `demolition-inventory.md` slices 21-23.

## Measured surface at `af6ab6de`

Top-level commands before Phase 3: `help`, `ask`, `acp`, `login`, `logout`,
`status`, `permissions`, `mcp`, `models`, `doctor`, `session`, `sessions`,
`resume`, `usage`, `upgrade`, `replay` (hidden), `workspace`. Seventeen kinds;
sixteen once `acp` is deleted in Phase 1's addendum.

Files that carry the work: `src/core/cli/cli_surface.zig` (4,190 lines, all
argument parsing and dispatch), `src/core/output/output_contracts.zig` (2,731,
every `*Snapshot`), `src/builtins/commands.zig` (464, both catalogs),
`src/main.zig` (3,957), `src/core/slash_commands/`.

`--json` is declared on 11 command specs and parsed at 10 sites — 8 in
`cli_surface.zig` (four commands share `parseLocalSurfaceArgs`), plus `ask` in
`cli_ask.zig:3313` and `replay` in `cli_replay.zig:41`. Every declaring command
parses it. There are **13** distinct success payload shapes: 11 `*Snapshot`
types in `output_contracts.zig`, plus `ask`'s hand-built object
(`cli_ask.zig:3475`) and `replay`'s inline one (`cli_replay.zig:111`). The
shared failure shape is `CommandFailureSnapshot`.

Of the retained operational commands, only `mcp` lacks `--json` entirely.

## Decided contracts

Every slice conforms to these. They are stated once here rather than repeated
across matrix rows.

### What "operational" means

Support `--json` on every retained operational command. A command is
**operational when a script can drive it to completion without a human.** That
test, not interactivity during execution, decides the flag.

`ask` streams and prompts for permissions, but a script starts it, waits, and
consumes a result — operational. `auth login` waits on a browser or a tty
prompt, so no script drives it to completion — not operational, and
`fiber login codex --json` already rejects the flag today.

Commands that reject `--json` as a usage error: the default TUI, `resume`,
`continue`, `session resume`, `auth login`, `mcp login`, and `help`. `fiber -v`
prints a bare version string and needs no envelope.

Everything else retained carries it, including mutating subcommands
(`permissions rule add`, `session remove`, `workspace add`). Those earn it for
the error `code`, not for a success payload — exit 0 already says "it worked,"
but nothing distinguishes "invalid pattern" from "settings file unwritable."

### Output envelope

One envelope for every `--json` response, success and failure:

```
{"ok":true,"kind":"auth.status","data":{...}}
{"ok":false,"kind":"auth.login","error":"no provider and stdin is not a tty","code":"ProviderRequired"}
```

`data` is nested rather than flattened so a payload key cannot collide with
`ok`, `kind`, or `error`. `kind` is `<command>` or `<command>.<subcommand>`, so
a worker consuming a stream of outputs can demultiplex without tracking which
command produced each line. This replaces today's asymmetry, where failures
carry `{kind, error, code}` and successes emit a bare snapshot object.

`kind` is a namespace, and slices mint values independently. Slice 2 lands the
registry; the matrix's `JSON kind` column is its content. No slice invents a
`kind` that is not in a matrix row.

### Exit status

Three codes, plus the signal codes.

| Code | When |
| --- | --- |
| 0 | success |
| 1 | the operation failed |
| 2 | usage error: unknown flag, unrecognized `--permission-mode`, missing required argument, `--json` on a non-operational command |
| 130, 143 | SIGINT and SIGTERM |

`2` for usage errors is the convention grep, diff, and ripgrep already use. It
is also the only split a caller can act on without reading stdout: `2` means the
invoking script is wrong, `1` means the world is.

Everything finer belongs in the envelope's `code` string, which is more precise
than a number and is what an automation consumer should branch on. A second
numeric taxonomy alongside it would be two vocabularies for one concept.

`sysexits.h` was considered and rejected. Its values are portable, identical on
macOS, glibc, and BSD, so the cross-platform concern does not apply; it is
simply unused outside sendmail-era daemons, and an exit 64 in a failed CI step
tells a reader less than exit 1 does. (`errno` values are a different thing
entirely and are genuinely not portable: `EDEADLK` is 35 on Linux and 11 on
macOS. Never return one as exit status.)

**130 and 143 do not work today.** `cli_ask.zig:104-131` computes them
correctly, then `cli_surface.zig:679` collapses any non-zero `u8` into
`.handled_failure`, which `app_entry_runtime.zig:187` maps to exit 1. Same at
`:1216` for `replay`. The `handled_exit: u8` passthrough variant exists and is
never returned from production code. `error.UnknownCliCommand`
(`cli_surface.zig:1223`) bypasses `RunResult` entirely and is caught into exit 1
at `app_entry_runtime.zig:154`. Slice 1 fixes all of this; Slice 3 then
reclassifies the failure sites.

### Permission rule syntax

```
fiber permissions rule add [--user] <permission> <pattern> <allow|deny|ask>
fiber permissions rule remove [--user] <permission> <pattern>
```

Positional, mapping onto `addPermissionRule(alloc, scope, workspace_root,
category, pattern, action)` and `removePermissionRule(alloc, scope,
workspace_root, category, pattern)` at `config_runtime.zig:893,912`. **Add and
remove differ in arity**: `removePermissionRule` takes no action.

`<permission>` is a category, not a tool name. `permissionNameForTool`
(`permissions.zig:1412`) normalizes `run_command` to `bash`, `read_file` to
`read`, `edit_file` to `edit`; a rule glob-matches either the normalized
category or the raw tool name (`ruleMatchesPermission`, `:1565`). Real values
are `bash`, `edit`, `read`, `glob`, `grep`, `url`, `web_fetch`, `open_url`,
`skill`, `*`. There is no enum: any non-empty key parses.

Scope defaults to **workspace-local**; `--user` writes the global store.
`PermissionScope = enum { user, local }` (`settings_store.zig:62`), and every
mutation takes it. Local is the default because a rule added while sitting in a
repo is almost always about that repo, and the failure that hurts is silently
widening permissions everywhere.

On-disk shape is nested, not a triple:
`{"permission":{"bash":{"git *":"allow"},"edit":"deny"}}`. A bare action string
implies pattern `*`.

Pattern semantics vary by category and the command does not hide it: `bash`
allow-rules with wildcards match only static commands
(`ruleTargetMatches`, `:1581`), and `web_fetch` patterns must be exact
`domain:<host>` strings rather than globs (`:1538-1545`). A pattern that cannot
match is a usage error, not a silently inert rule.

### Fast

Fast is a per-request service tier, not a model identity.
`resolveProviderOptionsForCapabilities` (`model_capabilities.zig:150`) turns
`fast_mode && supports_fast_mode` into `provider_options.fast`, which Codex
sends as `"service_tier":"priority"` (`openai_codex.zig:82`) and other routes
send as `"gateway":{"speed":"fast"}` (`agent_request_body.zig:453`). Same model
id, same endpoint. A `-fast` id suffix is a different concept entirely: it names
a distinct model and only sets `intrinsic_fast`, which lights the footer
indicator (`app_render_runtime.zig:593`) and nothing else.

Fast is chosen with the model. The picker's fast stage and
`/model <id> <effort> normal|fast` stay and persist through
`selectModelFromPicker` (`session_commands.zig:516`). The "Fast mode" row is
removed from the `/settings` menu — the row, not the command: switching tiers moves a request off its cached prompt prefix
provider-side, so it should cost a deliberate trip through the model picker
rather than one keystroke. There is no cache reset in this codebase — the reset
is the provider's, and `applyFastMode` touches no cache.

`ask --fast` is added because the non-interactive path cannot otherwise reach
the tier at all: `cli_ask.zig:1442` copies startup, `app_lifecycle.zig:402`
hardcodes it false, and only `--resume` restores it. `--model <id>:fast` was
considered and rejected: `gpt-5.4-fast` and `zai/glm-5.2-fast` are real ids, so
`--model gpt-5.4-fast:fast` would jam two different concepts into one token with
near-identical spelling.

The session-record preference and `RecoveryCheckpoint.{requested_fast_mode,
fast_mode}` stay. Those two are not preference — they record what a turn
requested against what it actually routed after a provider-outage fallback
(`orchestrator.zig:4222`, `model_response_recovery.zig:178`). No session records
are broken and `~/.fiber/sessions` is not deleted by any gate.

### Shape for N providers

`ProviderId` has one variant (`model_provider.zig:4`), one `CredentialSource`,
and `provider_set.select()` ignores its argument (`provider_set.zig:48`). The
seam is deliberately retained.

Auth surfaces ship **shaped** for several providers and implemented against the
one that exists: arrays rather than scalars, provider arguments required or
picked rather than assumed. `fiber status` already emits `connected_providers`
as an array (`output_contracts.zig:575`) and is the precedent. Costs nothing
now; avoids a contract break later. Actually attaching a second provider is
enhancement work.

## Hazard classification

**Contract-shaping** work changes a format or a mechanism that later work
depends on. It goes first, and later slices are written against its output
rather than retrofitted onto it: the exit passthrough, the output envelope, and
the exit-status reclassification. Slices 1-3.

**Additive** work introduces a command or flag behind an interface the
contract-shaping slices already fixed. Each is independently testable and
carries no ordering constraint beyond coming after Slice 2. Slices 4-12.

## Slices

One at a time on `main`. Everything routes through `cli_surface.zig` and both
catalogs in `builtins/commands.zig`, so the slices cannot run in parallel. The
per-slice gate is in `AGENTS.md`.

**Prerequisite: `demolition-inventory.md` slices 21-23 (ACP removal) land
first.** Implementing the session, permission, and model contracts while a
second agent host exists means implementing each of them twice.

`scripts/smoke.sh` grows at Slice 2. Its current premise — *"Exit codes only:
output shifts constantly during demolition and the rename"* — was right for
Phase 1 and expires here, because stable output shape is what this phase
produces. From Slice 2 the gate also asserts that every `--json` command's
stdout carries `"ok":` and `"kind":`, and that one usage error per command
family exits 2. Dependency-free `grep`, no `jq`.

| # | Slice | Class |
| --- | --- | --- |
| 1 | Signal and unknown-command exit passthrough | contract-shaping |
| 2 | Output envelope, `kind` registry, `NO_COLOR`, smoke-gate growth | contract-shaping |
| 3 | Exit-status reclassification across 38 sites | contract-shaping |
| 4 | `ask` flags and the fast decision | additive |
| 5 | `auth list\|status\|login\|logout` | additive |
| 6 | `permissions mode` and `permissions rule list\|add\|remove` | additive |
| 7 | `mcp login` and `mcp --json` | additive |
| 8 | `session list\|show\|rename\|remove` | additive |
| 9 | `continue`, resume-alias removal, `--resume-id`, pagination | additive |
| 10 | Interactive surface: `/retry`, `/new` alias, `/background` | additive |
| 11 | `debug trace\|replay` parent | additive |
| 12 | `/context` usage | additive |

## The matrix

One row per target item, grouped by owning slice. `Current` is the measured
state at `af6ab6de`. A row with no `JSON kind` does not emit an envelope, either
because it is not operational or because it is not a `--json` surface.

Tests name the file that must gain focused coverage, not an existing passing
test. End-to-end assertions are **not** updated as slices land — see Testing
below.

### Slice 1 — signal and unknown-command exit passthrough

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `ask` exit code passthrough | `cli_surface.zig:679` collapses non-zero to `.handled_failure` → 1 | returns `.handled_exit = <code>` | `cli_surface.zig` | `cli_surface.zig` |
| `replay` exit code passthrough | `cli_surface.zig:1216`, same collapse | returns `.handled_exit = <code>` | `cli_surface.zig` | `cli_surface.zig` |
| SIGINT exit 130 | computed at `cli_ask.zig:104`, discarded | reaches the process | `cli_ask.zig` | `cli_surface.zig` |
| SIGTERM exit 143 | computed at `cli_ask.zig:105`, discarded | reaches the process | `cli_ask.zig` | `cli_surface.zig` |
| unknown command exit | `error.UnknownCliCommand` caught into 1 at `app_entry_runtime.zig:154` | exit 2 | `app_entry_runtime.zig` | `app_entry_runtime.zig` |

### Slice 2 — output envelope

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| envelope, success | bare snapshot object | `{"ok":true,"kind":..,"data":{..}}` | — | `output_contracts.zig` | `output_contracts.zig` |
| envelope, failure | `{kind,error,code}` | `{"ok":false,"kind":..,"error":..,"code":..}` | — | `output_contracts.zig` | `output_contracts.zig` |
| `kind` registry | none; values inline in each renderer | one enumerated list, matrix-derived | — | `output_contracts.zig` | `output_contracts.zig` |
| `status --json` | `{"kind":"status",..}` flat (`:546`) | enveloped | `status` | `output_contracts.zig` | `output_contracts.zig` |
| `permissions --json` | flat (`:667`) | enveloped | `permissions` | `output_contracts.zig` | `output_contracts.zig` |
| `models --json` | flat (`:762`) | enveloped | `models` | `output_contracts.zig` | `output_contracts.zig` |
| `doctor --json` | flat (`:1228`) | enveloped | `doctor` | `output_contracts.zig` | `output_contracts.zig` |
| `sessions --json` | flat (`:848`) | enveloped | `session.list` | `output_contracts.zig` | `output_contracts.zig` |
| `session --json` (summary) | flat (`:987`) | enveloped | `session.show` | `output_contracts.zig` | `output_contracts.zig` |
| `session --json` (detail) | flat (`:1074`) | enveloped | `session.show` | `output_contracts.zig` | `output_contracts.zig` |
| `session recover --json` | flat (`:1150`) | enveloped | `session.recover` | `output_contracts.zig` | `output_contracts.zig` |
| `usage --json` | flat (`:133`) | enveloped | `usage` | `output_contracts.zig` | `output_contracts.zig` |
| `upgrade --json` | flat (`:1343`) | enveloped | `upgrade` | `output_contracts.zig` | `output_contracts.zig` |
| `workspace --json` | flat (`:325`) | enveloped | `workspace` | `output_contracts.zig` | `output_contracts.zig` |
| `ask --json` | hand-built object (`cli_ask.zig:3475`) | enveloped | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `replay --json` | inline object (`cli_replay.zig:111`) | enveloped | `debug.replay` | `cli_replay.zig` | `cli_replay.zig` |
| `--no-color` | flag parsed in `src/` | removed; `NO_COLOR` env only | — | `cli_surface.zig` | `cli_surface.zig` |
| smoke gate | exit codes only | also asserts `"ok":`/`"kind":` and one exit-2 case | — | `scripts/smoke.sh` | the gate is the test |

### Slice 3 — exit-status reclassification

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| usage-error sites in `cli_surface.zig` | 27 sites return `.handled_failure` → 1 | `.handled_usage_error` → 2 | `cli_surface.zig` | `cli_surface.zig` |
| operational sites in `cli_surface.zig` | 37 sites return `.handled_failure` | unchanged → 1 | `cli_surface.zig` | `cli_surface.zig` |
| `ask` parse errors | ~8 paths return 1 | return 2 | `cli_ask.zig` | `cli_ask.zig` |
| `replay` parse errors | `replyError` returns 1 | usage branch returns 2 | `cli_replay.zig` | `cli_replay.zig` |
| ambiguous: `McpAddUsage` | `:1492`, both usage and save failure | split per branch | `cli_surface.zig` | `cli_surface.zig` |
| ambiguous: no MCP servers configured | `:1622` → 1 | decide: operational | `cli_surface.zig` | `cli_surface.zig` |

### Slice 4 — `ask` flags and the fast decision

The `/settings` row removal lands here rather than with the slash work: it is
what makes `--fast` the single way to set the tier outside the model picker.
Splitting them would leave a window in which a cheap toggle and a new flag both
exist.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `--permission-mode <ask\|auto\|yolo>` | `--auto`, `--yolo`, `--prompt-permissions` | single flag; bad value exits 2 | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--model <namespaced-id>` | present | unchanged, rejects `:fast` suffix | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--effort <level>` | present | unchanged | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--retry` | `--continue-recovery` | renamed | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--fast` | unreachable; startup hardcodes false | sets the tier for one invocation | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--timeout` | hidden, undeclared (`cli_ask.zig:3317`), 3 test callers | declared in the spec | `ask` | `commands.zig` | `cli_ask.zig` |
| `--verbose` | hidden, undeclared (`:3323`), no callers | deleted | — | `cli_ask.zig` | `cli_ask.zig` |
| `--system` | declared (`commands.zig:39`), tested | unchanged | `ask` | — | — |
| `--quiet`, `--no-save`, `--image` | present | unchanged | `ask` | — | — |
| "Fast mode" row **inside** the `/settings` menu | one of 12 catalog rows: `settings_catalog.zig:33,67,262,321,369` and `app_commands.zig:3532` | that row removed, menu drops to 11; `toggleFast`/`toggleFastForModel` become dead and go with it. **`/settings` itself is retained.** | — | `settings_catalog.zig` | `settings_catalog.zig` |
| settings menu row counts | `settings_catalog.zig:433,435`, `settings_menu_presentation.zig:364,385,490` | updated for one fewer row (12 to 11) | — | `settings_catalog.zig` | — |
| `applyFastMode` | called by `toggleFastForModel`, `selectModelFromPicker:529`, `setResolvedModel:660` | **retained** — the picker path survives | — | — | — |

### Slice 5 — `auth`

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `auth list` | absent | every supported provider, signed-in state; array-shaped | `auth.list` | `cli_surface.zig` | `output_contracts.zig` |
| `auth status` | absent; `fiber status` carries a subset | active credential: provider, expiry, refreshable | `auth.status` | `cli_surface.zig` | `output_contracts.zig` |
| `auth login [<provider>]` | top-level `login`; provider arg parsed then discarded (`:716`) | provider honored; picks when >1 exists, proceeds when 1; no tty + no provider exits 2 and lists providers | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `auth logout [<provider>]` | top-level `logout`; arg discarded (`:741`) | provider honored | `auth.logout` | `cli_surface.zig` | `cli_surface.zig` |
| top-level `login`/`logout` | present (`commands.zig:63,69`) | absent | — | `commands.zig` | `command_specs.zig` |
| `/login`, `/logout` | present (`commands.zig:334-335`) | **unchanged** — no `/auth` parent | — | — | — |

### Slice 6 — `permissions`

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `permissions` (read) | present, read-only | unchanged, enveloped | `permissions` | — | — |
| `permissions mode <mode>` | absent | sets persisted mode | `permissions.mode` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule list` | absent | lists rules with scope | `permissions.rule.list` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule add [--user] <permission> <pattern> <action>` | absent; `addPermissionRule` has had no production caller since `/allowlist` was deleted | wired | `permissions.rule.add` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule remove [--user] <permission> <pattern>` | absent; two positionals, no action | wired | `permissions.rule.remove` | `cli_surface.zig` | `config_runtime.zig` |
| unmatched-pattern validation | none; a `web_fetch` glob is silently inert | usage error, exit 2 | `permissions.zig` | `permissions.zig` |

### Slice 7 — `mcp`

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `mcp login` | `mcp auth` (`cli_surface.zig:1612`) | renamed | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `mcp list --json` | no `--json` anywhere in `mcp` | enveloped | `mcp.list` | `output_contracts.zig` | `output_contracts.zig` |
| `mcp add\|remove\|path\|trust --json` | absent | enveloped, for the error `code` | `mcp.<sub>` | `output_contracts.zig` | `output_contracts.zig` |
| `mcp list --connect` | already removed from `src/` (`:1590` rejects the extra token); stale callers in `tests/e2e/mcp-http.test.ts:217` | callers removed | — | tests | — |
| `mcp doctor` | absent | **deferred** — see `../enhancements/pending.md` | — | — | — |

### Slice 8 — `session` subcommands

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `session list` | `sessions` is list | subcommand; `sessions` kept as shorthand | `session.list` | `cli_surface.zig` | `cli_surface.zig` |
| `session show` | `session <last\|id>` | subcommand | `session.show` | `cli_surface.zig` | `cli_surface.zig` |
| `session rename` | absent (`/rename` exists) | new | `session.rename` | `cli_surface.zig` | `cli_surface.zig` |
| `session remove` | absent; `session_store.zig:859 deleteCommittedSession` exists with no CLI path | wired to that function | `session.remove` | `cli_surface.zig` | `session_store.zig` |
| `session recover` | present (`:916`) | unchanged, enveloped | `session.recover` | — | — |
| `session resume` | present (`commands.zig:134`) | unchanged; **rejects `--json`** | — | `cli_surface.zig` | `cli_surface.zig` |
| `parseResumeArgs` flag guard | any `--`-prefixed token becomes a session id (`:2652`) | rejects it, exit 2 | `cli_surface.zig` | `cli_surface.zig` |

### Slice 9 — resume paths and pagination

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `continue` | absent | resumes the most recent session, no picker | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `ask --resume-id <id>` | absent | one-shot resumes a specific session | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `-r`, `--resume`, `--resume-last`, `--continue`, `-c`, `--resume-<id>` | mixed: some parsed, some only in help | absent from parser and help | — | `cli_surface.zig` | `cli_surface.zig` |
| `sessions --continuation` | `--cursor` (`commands.zig:147`, parsed `:2476`) | renamed | `session.list` | `commands.zig` | `cli_surface.zig` |
| `sessions --limit` | absent from the target spec, present in usage | declared and parsed | `session.list` | `commands.zig` | `cli_surface.zig` |
| `resume` (picker) | present | unchanged; **rejects `--json`** | — | `cli_surface.zig` | `cli_surface.zig` |

### Slice 10 — interactive surface

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `/retry` | `/continue` (`commands.zig:332`) | renamed; replays an interrupted turn from its checkpoint | `commands.zig` | `command_router.zig` |
| `/new` canonical, `/clear` alias | two separate kinds (`:329,330`) | one kind with `.aliases = &.{"/clear"}`, as `/quit` does for `/exit` | `commands.zig` | `command_router.zig` |
| `/background` | rejected as unknown (`command_router.zig:177`) | reachable; inspects and terminates background processes | `commands.zig` | `command_router.zig` |
| `/undo`, `/trace` | live (`commands.zig:340,343`) | **retained** — recorded owner decisions at `demolition-inventory.md:80,282` | — | — |
| `/exit` | already aliases `/quit` (`:347`) | unchanged | — | — |

### Slice 11 — `debug`

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `debug replay` | `replay` is a hidden top-level kind | reachable only under `debug` | `debug.replay` | `cli_surface.zig` | `command_specs.zig` |
| `debug trace` | absent; `/trace` is the slash form | hidden parent gains it | `debug.trace` | `cli_surface.zig` | `command_specs.zig` |

### Slice 12 — `/context`

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `/context` | absent; TUI footer shows `Context: 12k/200k 6%` (`render.zig:432`) | slash command showing used, window, percent | `commands.zig` | `command_router.zig` |
| context *occupants* | no per-component accounting exists | **deferred** — see `../enhancements/pending.md` | — | — |
| context usage in `ask --json` / `session show` | absent | **deferred** — same file | — | — |

### Carried from Phase 2 — verify at phase exit

| Item | Note |
| --- | --- |
| `--fx-internal-terminal-*` rename | Design `:211`. Phase 2 owns it; confirm no `fx`-named re-exec flag survives, including the generated shell bootstrap string that embeds it. |
| `upgrade --channel` | Already removed in demolition Slice 19. |

## Testing

The Zig unit tests in `output_contracts.zig`, `cli_surface.zig`,
`config_runtime.zig`, and `permissions.zig` run in the per-slice gate and are
updated as each slice lands. They are the coverage that matters during Phase 3.

**End-to-end `--json` assertions are deliberately left stale.** E2E is not
gating until Phase 5, the envelope changes 13 payload shapes, and rewriting
assertions nobody can run produces tests that read as current while proving
nothing. The old expected shapes are also a useful diff against the new ones
when Phase 5 rewrites that suite. The consequence, accepted knowingly: the e2e
suite will be substantially stale by the end of this phase, and Phase 5 is not
a small task.

## Notes

- `/undo` and `/trace` stay. Both are recorded owner decisions at `demolition-inventory.md:80,282`: `/undo` is the only non-git revert of an agent edit, and `/trace` is the diagnostic instrument needed during the transition, deferred to Phase 6.
- No slice deletes `~/.fiber/sessions`. The previous revision's Slice 3 gate did; the record break that required it is gone.
- `handled_exit: u8` already exists on `RunResult` (`cli_surface.zig:125`) and has never been returned from production code. Slice 1 gives it its first caller.
