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

Amended 2026-09-04 after an owner grilling pass on the envelope and exit-status
decisions. Same convention: recorded, not silently applied.

- **Exit 2 is now structural, not semantic.** Slice 3 was a hand-classification of ~64 `handled_failure` sites into usage-vs-operational, with a failure mode no gate detects. It is now a parse-layer boundary provable by grep. See "Exit status". Slice 3 shrinks accordingly.
- **`ok` had no definition.** The envelope was specified without saying what `ok` asserts, which is undecidable for `ask` — a turn can run to completion and fail. See "What `ok` means". `doctor` on a sick host is the edge that the rule exists to settle.
- **`ask --resume-id` was listed as absent** in Slice 9. It exists at `cli_ask.zig:3297`, is declared in the usage string at `commands.zig:33`, and has ~12 test call sites. This is the fourth error found in this document across two revisions, and the first found in a row that would have *added* scope rather than misdirected it. **A full re-audit of every matrix row precedes Slice 1** — see "Slices", step zero.
- **Removing `--no-color` breaks 39 e2e call sites at argument parsing**, which is a different failure from the stale assertions this phase accepts. Slice 2 cleans them up. See Slice 2's row.

### Step-zero audit, 2026-09-04

Every matrix row was verified against the tree at `098aabc8`. Line drift was
corrected silently throughout. Six findings changed a row's meaning:

**Scope added**

- **`ask --model` and `--effort` do not exist.** `grep -rn '"--model"' src/` and the same for `--effort` return nothing, and neither is in the `ask` spec. The matrix listed both as "present / unchanged", so Slice 4 was sized as two renames and one new flag when it is actually building two flags from scratch. Both remain Phase 3 work — exposing an existing model selection through the CLI is reshaping by `plan.md`'s own example — but the slice is larger than it read. **Owner decision (2026-09-04): build both, sized as new work.**
- **`mcp logout` exists** (`cli_surface.zig:1631`) and had no matrix row, while its pair `mcp auth` did. It must move with `mcp login` or the two spellings diverge.
- **`/clear` and `/new` are different behaviours**, not two spellings. Slice 10 proposed aliasing them. **Owner decision (2026-09-04): already resolved at `demolition-inventory.md:456` — `/new` is canonical, `/clear` becomes its alias.** This document had reopened a settled question; see Slice 10's row.

**Scope removed**

- **`sessions --limit` is already declared and parsed** (`commands.zig:141,146`, `cli_surface.zig:2429`, tested at `:2852`). The row is a no-op.
- **"no MCP servers configured" already exits 0**, via `.handled_success` at `cli_surface.zig:1570`. Both prior revisions of this document claimed it returned 1 and needed a decision.
- **The `--fx-internal-terminal-*` carried row is clean.** Verified rather than assumed; nothing is owed.

**Path corrections**

`settings_catalog.zig` is under `src/core/config/` and `settings_menu_presentation.zig` under `src/ui/footer/` — the matrix placed both in `src/core/slash_commands/`. Every line number cited for them was correct.

**Checked and confirmed correct**, recorded so the next reader does not re-derive
them: 11 `json_option` command specs; 13 JSON payload shapes, with
`McpLocalSnapshot` correctly excluded as a nested component; every Slice 6
permission anchor (`config_runtime.zig:893,912`; `permissions.zig:1412,1565,1581`);
`connected_providers` as an array at `output_contracts.zig:575`; the
`applyFastMode` call sites; the `parseResumeArgs` flag hole; and `/background`
genuinely unregistered.

## Measured surface at `af6ab6de`

Top-level commands before Phase 3: `help`, `ask`, `acp`, `login`, `logout`,
`status`, `permissions`, `mcp`, `models`, `doctor`, `session`, `sessions`,
`resume`, `usage`, `upgrade`, `replay` (hidden), `workspace`. Seventeen kinds;
sixteen once `acp` is deleted in Phase 1's addendum.

Files that carry the work: `src/core/cli/cli_surface.zig` (4,061 lines, all
argument parsing and dispatch), `src/core/output/output_contracts.zig` (2,731,
every `*Snapshot`), `src/builtins/commands.zig` (457, both catalogs),
`src/main.zig` (3,940), `src/core/slash_commands/`.

`--json` is declared on 11 command specs and parsed at 10 sites — 8 in
`cli_surface.zig` (four commands share `parseLocalSurfaceArgs`), plus `ask` in
`cli_ask.zig:3313` and `replay` in `cli_replay.zig:41`. Every declaring command
parses it. There are **13** distinct success payload shapes: 11 `*Snapshot`
types in `output_contracts.zig` with a public `renderJson`, plus `ask`'s
hand-built object (`renderFinalJsonResult`, `cli_ask.zig:3471`) and `replay`'s
inline one (`cli_replay.zig:111`). The shared failure shape is
`CommandFailureSnapshot`.

`output_contracts.zig` declares 13 `*Snapshot` types, not 12. The extra one is
`McpLocalSnapshot` (`:377`), which is **not** a payload: it has a private
`writeJson` rather than a public `renderJson`, and is embedded as a field inside
`StatusSnapshot` (`:449`) and `DoctorSnapshot` (`:1186`). It needs no envelope of
its own; its content rides inside its host's `data`. Counting it is the obvious
mistake and it has already been made once.

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

#### What `ok` means

> `ok` is true when **this command's own operation** succeeded.

Not "the process started," which is true of everything and therefore says
nothing. The operation of `permissions rule add` is adding the rule; of
`session remove`, removing it; of **`ask`, completing the turn** — so a turn
that runs to completion and fails is `ok:false`.

The edge that makes the rule worth writing down: **`doctor` on an unhealthy
machine stays `ok:true`.** Doctor's operation is *producing the report*, and it
produced one. Same for `status`, `models`, and the `permissions` read. Without
this sentence someone makes `doctor --json` report `ok:false` on a sick host,
and every consumer ends up branching on health when it meant to branch on
"did the command work."

`ok` is the single field a consumer branches on. If a payload key has to be
ANDed with `ok` to get the answer, the envelope is not carrying its weight.

Three consequences for `ask`, whose payload predates the envelope:

- **`exit_code` leaves the payload.** It is only ever 0 or 1 (`cli_ask.zig:1358,1737,1747,1779`), making it exactly `!ok`.
- **`error_code` becomes the envelope's `code`, not its `error`.** It holds machine strings — `"MissingCredentials"`, `"NonInteractivePermissionRequired"`, `@errorName(err)`.
- **`ask` has no prose message.** Until someone writes one, `error` carries the same string as `code`. Ugly and honest; inventing a message table is scope Phase 3 did not ask for.

An interrupted `ask --json` emits **no JSON at all** — `cli_ask.zig:1263` returns
before the render — so 130 and the envelope never coexist.

`CommandFailureSnapshot` (`output_contracts.zig:30`) is already
`{kind, message, code}` with `message` serialized as `"error"`. The shared
failure shape needs only `"ok":false` prepended.

### Exit status

Three codes, plus the signal codes.

| Code | When |
| --- | --- |
| 0 | success |
| 1 | the operation failed |
| 2 | usage error, defined structurally — see below |
| 130, 143 | SIGINT and SIGTERM |

`2` for usage errors is the convention grep, diff, and ripgrep already use. It
is also the only split a caller can act on without reading stdout: `2` means the
invoking script is wrong, `1` means the world is.

Everything finer belongs in the envelope's `code` string, which is more precise
than a number and is what an automation consumer should branch on. A second
numeric taxonomy alongside it would be two vocabularies for one concept.

**Exit 2 is a code layer, not a per-call-site judgement.** It is returned by
errors raised at the argument-parsing layer — unknown flag, unparseable enum
value, missing required argument — plus unknown top-level command, plus `--json`
on a non-operational command. Everything that fails *after* parsing succeeds is
`1`, with no exceptions and no classification pass.

Two readings were rejected on 2026-09-04:

- **Classify all ~64 `handled_failure` sites into usage-vs-operational.** This was the previous revision's Slice 3. It buys precision that the envelope's `code` already carries, at the price of the phase's largest silent-error surface: a site returning `2` where it meant `1` is caught by no gate, no test, and no exact search. A structural boundary is instead provable by grep.
- **Return `2` only where no envelope exists to carry the meaning.** This makes the code depend on an unrelated flag — `fiber ask --badflag` exits 2 while `fiber ask --badflag --json` exits 1, the same typo answered two ways.

When `--json` was parsed successfully and a *later* argument fails to parse, the
process emits the failure envelope **and** exits 2. The envelope and the exit
code are separate channels and neither suppresses the other.

`sysexits.h` was considered and rejected. Its values are portable, identical on
macOS, glibc, and BSD, so the cross-platform concern does not apply; it is
simply unused outside sendmail-era daemons, and an exit 64 in a failed CI step
tells a reader less than exit 1 does. (`errno` values are a different thing
entirely and are genuinely not portable: `EDEADLK` is 35 on Linux and 11 on
macOS. Never return one as exit status.)

**130 and 143 do not work today.** `cli_ask.zig:104-105` computes them
correctly, then `cli_surface.zig:675` collapses any non-zero `u8` into
`.handled_failure`, which `app_entry_runtime.zig:196` maps to exit 1. Same at
`cli_surface.zig:1182` for `replay`. The `handled_exit: u8` passthrough variant
exists at `cli_surface.zig:127`, is already mapped correctly at
`app_entry_runtime.zig:197`, and is never returned from production code — the
producers are the only liars.

`error.UnknownCliCommand` bypasses `RunResult` entirely and is caught into exit 1
at **two** sites, `app_entry_runtime.zig:150` and `:174`. The matrix named one.
`:174` is `runBeforeInteractiveWithDeps`, the path the tests drive, so fixing
only `:150` yields green tests on a wrong binary.

Slice 1 fixes all of this; Slice 3 then moves the parse-layer sites to exit 2.

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

**Step zero is complete** — see "Step-zero audit" under Status. Every row was
verified at `098aabc8`. Both rows that needed an owner decision — `/clear` vs
`/new` in Slice 10, and the enlarged Slice 4 — are resolved; see those rows.

**Prerequisite: `demolition-inventory.md` slices 21-23 (ACP removal) land
first.** Implementing the session, permission, and model contracts while a
second agent host exists means implementing each of them twice.

`scripts/smoke.sh` grows at Slice 2. Its current premise — *"Exit codes only:
output shifts constantly during demolition and the rename"* — was right for
Phase 1 and expires here, because stable output shape is what this phase
produces. From Slice 2 the gate also asserts that every `--json` command's
stdout carries `"ok":` and `"kind":`, and that one usage error per command
family exits 2. Dependency-free `grep`, no `jq`.

| # | Slice | Class | Status |
| --- | --- | --- | --- |
| 1 | Signal and unknown-command exit passthrough | contract-shaping | done, `47bbe883` |
| 2 | Output envelope, `kind` registry, `NO_COLOR`, smoke-gate growth | contract-shaping | **done** — 2a `67538d14`, 2b `afc6cec2` |
| 3 | Exit-status: parse-layer errors return 2 | contract-shaping | |
| 4 | `ask` flags and the fast decision | additive | **done** — 4a `83ca601b`, 4b `fb69be33`, 4c `8b9e4277` |
| 5 | `auth list\|status\|login\|logout` | additive | **done**, `dd7527a1` |
| 6 | `permissions mode` and `permissions rule list\|add\|remove` | additive | **done**, `2f0690ca` |
| 7 | `mcp login` and `mcp --json` | additive | **done**, `86188784` |
| 8 | `session list\|show\|rename\|remove` | additive | |
| 9 | `continue`, resume-alias removal, `--resume-id`, pagination | additive | |
| 10 | Interactive surface: `/retry`, `/new` alias, `/background` | additive | |
| 11 | `debug trace\|replay` parent | additive | |
| 12 | `/context` usage | additive | |

## The matrix

One row per target item, grouped by owning slice. `Current` is the measured
state at `af6ab6de`. A row with no `JSON kind` does not emit an envelope, either
because it is not operational or because it is not a `--json` surface.

Tests name the file that must gain focused coverage, not an existing passing
test. End-to-end assertions are **not** updated as slices land — see Testing
below.

### Slice 1 — signal and unknown-command exit passthrough — **done, `47bbe883`**

Paths and line numbers below were stale in every prior revision of this
document; corrected to match the tree at `47bbe883`. The real files are
`src/core/cli/cli_surface.zig` and `src/core/app/app_entry_runtime.zig`, not
`src/cli_surface.zig` / `src/app_entry_runtime.zig`. Assume the same drift is
possible in any row below that has not yet had its slice land, and re-verify
before acting on it.

| Item | Current (pre-slice) | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `ask` exit code passthrough | `src/core/cli/cli_surface.zig:675` collapsed non-zero to `.handled_failure` → 1 | returns `.handled_exit = <code>` | `cli_surface.zig` | `cli_surface.zig` |
| `replay` exit code passthrough | `src/core/cli/cli_surface.zig:1182`, same collapse | returns `.handled_exit = <code>` | `cli_surface.zig` | `cli_surface.zig` |
| SIGINT exit 130 | computed at `cli_ask.zig:104`, discarded by the collapse above | reaches the process | `cli_ask.zig` | `cli_surface.zig` |
| SIGTERM exit 143 | computed at `cli_ask.zig:105`, discarded by the collapse above | reaches the process | `cli_ask.zig` | `cli_surface.zig` |
| unknown command exit | `error.UnknownCliCommand` caught into 1 at `src/core/app/app_entry_runtime.zig:154` (`runBeforeInteractiveWithDeps`) and `:175` (`runBeforeInteractive`, no-deps variant) | exit 2, both sites | `app_entry_runtime.zig` | `app_entry_runtime.zig` |

Landed as four production-line edits plus one new test
(`"runBeforeInteractiveWithDeps maps unknown cli command to exit 2"` in
`app_entry_runtime.zig`); mutation-checked. `:154` has no test — no injection
seam exists without new plumbing, out of scope for this slice; it is a
one-liner identical to the covered `:175`. Full gate (`zig fmt`, `zig build
-Doptimize=ReleaseSafe`, `zig build test`, `scripts/smoke.sh`) passes at
`47bbe883`.

### Slice 2 — output envelope

Split into two delegated passes for blast-radius reasons: 2a is pure
additive reshaping (registry + 13 renderer sites + Zig unit tests +
smoke.sh), 2b deletes a flag and touches 39 e2e call sites. Same slice
number, same matrix rows — the split is an execution detail, not a scope
change.

**2a — done, `67538d14`.** `Kind` enum landed in `output_contracts.zig`
(`jsonName()` per member); every site below and every `CommandFailureSnapshot`
construction site across `cli_surface.zig` (22), `cli_ask.zig`, and
`cli_replay.zig` reference it instead of a bare literal. Full gate
(`zig fmt`, `zig build -Doptimize=ReleaseSafe`, `zig build test
-Doptimize=ReleaseSafe`, `scripts/smoke.sh`) independently re-verified
clean, not just taken on the delegate's word.

| Item | Current (pre-slice) | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| envelope, success | bare snapshot object | `{"ok":true,"kind":..,"data":{..}}` | — | `output_contracts.zig` | `output_contracts.zig` |
| envelope, failure | `{kind,error,code}` | `{"ok":false,"kind":..,"error":..,"code":..}` | — | `output_contracts.zig` | `output_contracts.zig` |
| `kind` registry | none; values inline in each renderer | one enumerated list, matrix-derived | — | `output_contracts.zig` | `output_contracts.zig` |
| `status --json` | `{"kind":"status",..}` flat (`:546`) | enveloped | `status` | `output_contracts.zig` | `output_contracts.zig` |
| `permissions --json` | flat (`:667`) | enveloped | `permissions` | `output_contracts.zig` | `output_contracts.zig` |
| `models --json` | flat (`:762`) | enveloped | `models` | `output_contracts.zig` | `output_contracts.zig` |
| `doctor --json` | flat (`:1228`) | enveloped | `doctor` | `output_contracts.zig` | `output_contracts.zig` |
| `sessions --json` | flat (`:848`) | enveloped | `session.list` (**renamed** from `sessions`) | `output_contracts.zig` | `output_contracts.zig` |
| `session --json` (summary) | flat (`:987`) | enveloped | `session.show` (**renamed** from `session_summary`) | `output_contracts.zig` | `output_contracts.zig` |
| `session --json` (detail) | flat (`:1074`) | enveloped | `session.show` (**renamed** from `session_detail`; same target as summary, two shapes, by design) | `output_contracts.zig` | `output_contracts.zig` |
| `session recover --json` | flat (`:1150`) | enveloped | `session.recover` (**renamed** from `session_recovery`) | `output_contracts.zig` | `output_contracts.zig` |
| `usage --json` | flat (`:133`) | enveloped | `usage` | `output_contracts.zig` | `output_contracts.zig` |
| `upgrade --json` | flat (`:1343`) | enveloped | `upgrade` | `output_contracts.zig` | `output_contracts.zig` |
| `workspace --json` | flat (`:325`) | enveloped | `workspace` | `output_contracts.zig` | `output_contracts.zig` |
| `ask --json` | hand-built object (`cli_ask.zig:3475`), no `kind` field; error path was a bespoke shape, not `CommandFailureSnapshot` | enveloped; error path now routes through `CommandFailureSnapshot` | `ask` (**new**) | `cli_ask.zig` | `cli_ask.zig` |
| `replay --json` | inline object (`cli_replay.zig:111`), no `kind` field on success; failure already used `CommandFailureSnapshot` with `kind = "replay"` | enveloped | `debug.replay` (**new** on success, **renamed** from `replay` on failure) | `cli_replay.zig` | `cli_replay.zig` |
| smoke gate | exit codes only | also asserts `"ok":`/`"kind":` and one exit-2 case | — | `scripts/smoke.sh` | the gate is the test |

**2b — done, `afc6cec2`.** Sized larger than the row implied: `NO_COLOR` the
env var already existed but only controlled top-level `--help` styling
(`main.zig`), never `ask`'s actual color output — deleting the flag with
nothing to replace it would have been a capability regression, not
reshaping. Fixed by adding an env-read seam to `cli_ask.zig`'s `RunDeps`
(mirroring `cli_surface.zig`'s existing `HOME`-reading pattern) and wiring
`options.no_color` from it post-parse. Real count: 36 e2e call sites across 2 files (33 in
`vision-route-fake-gateway.test.ts`, 3 in `ask-presentation.test.ts`), not
39 — `cli.test.ts`'s 2 occurrences are a `--help`-text content assertion,
not a spawn argument, and were correctly left stale rather than counted as
a call site. (38 if `cli.test.ts`'s 2 are counted in, which is presumably
where the matrix's original "39" came from, off by one for a reason not
worth chasing further.)

| Item | Current (pre-slice) | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `--no-color` | flag parsed at `cli_ask.zig:3328`, declared at `commands.zig:33,44`; `NO_COLOR` env had no effect on `ask` | removed; `NO_COLOR` env now drives `AskOptions.no_color` via a new `RunDeps.getenv` seam | — | `cli_ask.zig` | `cli_ask.zig` |
| `--no-color` e2e call sites | 36 across 2 files pass it (not 3 files — `cli.test.ts`'s 2 occurrences are a stale `--help` text assertion, left alone) | the 34 incidental ones drop the argument; `ask-presentation.test.ts`'s dedicated `"--no-color keeps the TTY layout..."` test, whose subject *is* the flag, is deleted whole. **Not an assertion rewrite** — see Testing. | — | tests | — |

### Slice 3 — parse-layer errors return 2 — **done, `78885737` + worktree**

Scoped by the structural boundary in "Exit status". Post-parse failures are not
touched, so there is no site-by-site classification and no silent-error surface.
The completeness check is a grep: every argument-parsing error path reaches
`.handled_usage_error`, and nothing else does.

Re-verified against the tree before delegating (same pattern as Slices 1-2):
`RunResult` had no usage-error variant yet, `cli_ask.zig`/`cli_replay.zig` had
zero `.handled_failure` sites (they return a raw `u8` through `.handled_exit`,
Slice 1's passthrough), and `writeUsageOrJsonError` turned out to be a real
single choke point covering 9 of the moved sites. The `--json`-on-non-operational
row needed no new "operational command" list: every non-operational command
already rejects `--json` as an ordinary unrecognized argument once its own
parser runs (`login`/`logout`/`mcp` all confirmed), except `.help`, which
matched on `args[0]` alone and silently ignored everything after it — the one
new check this slice added, not a flip of an existing return.

Delegated to `composer-2.5`; 25 `.handled_failure` sites in `cli_surface.zig`
moved to the new `.handled_usage_error` variant, plus the four shape-error arms
in `cli_ask.zig` and `replyParseError`'s path in `cli_replay.zig`. One site the
delegate correctly declined to guess on (`session recover`'s
`writeUsageOrJsonError` caller, omitted from the delegation prompt by my own
oversight, not a real ambiguity) fixed directly afterward. `usage`'s
`HomeNotSet` branch, also flagged by the delegate, correctly stays operational
(same tier as `mcp path`'s `HomeNotSet`).

Independent re-verification: `zig fmt`, `zig build`, `zig build test` clean,
completeness grep confirms no missed parse-layer site. **Also ran
`bun test cli.test.ts`**, which the doc's "Focused test" column never named for
this slice — 60 of 88 tests failed. Isolated with a baseline worktree at
pre-slice `HEAD` (`78885737`): 58 of those 60 were already failing before this
slice touched anything — `tests/e2e/cli.test.ts` was never updated for Slice
2a's envelope wrap (confirmed: `67538d14` and `afc6cec2` never touch this
file), so most of its `--json`-shape and several exit-code assertions
(including `unknown-command exits 1`, stale since Slice 1) have been silently
broken since Slice 2a landed. Only the remaining 2 were this slice's doing
(`ask` with no prompt, and the two global-launch-arg parse errors under
"workspace launch modifiers ... friendly option errors") — both fixed in
`cli.test.ts` to expect 2. **The other 58 are a pre-existing gap, not fixed
here** — fixing them means updating dozens of assertions across most of this
file's describe blocks, out of scope for a slice about exit codes. Flagged for
the owner to schedule; `bun test cli.test.ts` should be added to every future
slice's own verification, not just the Zig gate.

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| argument-parsing error paths in `cli_surface.zig` | return `.handled_failure` → 1 | `.handled_usage_error` → 2 | `cli_surface.zig` | `cli_surface.zig` |
| post-parse failure sites | `.handled_failure` → 1 | **unchanged**, not classified | — | — |
| `ask` parse errors | return 1 | return 2, envelope still emitted under `--json` | `cli_ask.zig` | `cli_ask.zig` |
| `replay` parse errors | `replyError` returns 1 | usage branch returns 2 | `cli_replay.zig` | `cli_replay.zig` |
| `--json` on a non-operational command | varies | exit 2 | `cli_surface.zig` | `cli_surface.zig` |
| `McpAddUsage` | `:1492`, both usage and save failure | usage branch 2, save-failure branch stays 1 | `cli_surface.zig` | `cli_surface.zig` |
| no MCP servers configured | **already `.handled_success` → 0** at `cli_surface.zig:1570`; it prints "No MCP servers configured." and succeeds. The previous claim of `:1622` → 1 was wrong on both the line and the code. | **no change**; row retained only to record that it was checked | — | — |

### Slice 4 — `ask` flags and the fast decision

The `/settings` row removal lands here rather than with the slash work: it is
what makes `--fast` the single way to set the tier outside the model picker.
Splitting them would leave a window in which a cheap toggle and a new flag both
exist.

**Owner decisions (2026-09-04):**

- **Permission prompting.** `--permission-mode <ask|auto|yolo>` replaces
  `--auto`, `--yolo`, and `--prompt-permissions` outright — no aliases, old
  flags become usage errors immediately (exit 2). `ask` enables the TTY
  prompt for JSON and quiet output; `auto` keeps current automatic-review
  behavior with no captured-output prompt; `yolo` is unchanged; no flag keeps
  the configured mode and current captured-output default.
- **Override precedence and persistence.** Effective order: explicit CLI
  control > relevant `FIBER_*` env override > resumed-session preference >
  profile/workspace config > built-in default. A new session's explicit
  `--model`/`--effort`/`--fast` become its seed preferences. A resumed
  session applies explicit choices for that invocation only, without
  rewriting stored preferences. No CLI choice writes profile config. Focused
  tests cover both new-session and resumed-session paths.
- **Model identifier validation.** `--model` accepts the existing bounded
  model-ID grammar (unnamespaced, matching the current Codex catalog and
  compiled default, e.g. `gpt-5.4-mini`) and rejects a terminal `:fast`
  suffix. Documented operand renamed from `<namespaced-id>` to `<model-id>`.
  Slash-namespace enforcement is out of scope for this slice — it needs
  explicit provider parsing, an owner decision not yet made.
- **Sub-slice boundary.** Slice 4 splits into 4a, 4b, 4c below, implemented
  and reviewed sequentially — no parallel work, since all three touch
  `cli_ask.zig` and its command specs/tests.

#### Slice 4a — `--model`, `--effort`, `--fast`, and the `/settings` Fast row

**Done, `83ca601b`.** Precedence implemented as three `?`-typed explicit-override
fields on `AskContext` (`explicit_model`/`explicit_effort`/`explicit_fast`),
applied once in `runPromptInternal` right after the startup/env/profile
resolution (so a new session's seed preferences already reflect the CLI
choice) and reapplied a second time in `initializeSessionStores` immediately
after the resumed-session preference restore (so a resumed session honors the
CLI choice for that invocation only, without writing it back to the store).
`--model` validation reuses `settings_store.validateModel` (`settings_store.zig:870`)
plus a `:fast`-suffix check. `toggleFast`/`toggleFastForModel` had exactly one
caller each (the deleted `/settings` row handler, then `toggleFast` itself) and
came out clean; `applyFastMode` kept its other two callers untouched.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `--model <model-id>` | **absent.** `grep -rn '"--model"' src/` returns nothing and it is not in the `ask` spec (`commands.zig:31-57`). The matrix said "present". Built as new work, not a rename. | build it; rejects a `:fast` suffix | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--effort <level>` | **absent**, same evidence. | build it, reusing `types.ReasoningEffort.parse` | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--fast` | unreachable; startup hardcodes false | sets the tier for one invocation | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| "Fast mode" row **inside** the `/settings` menu | one of 12 catalog rows: `src/core/config/settings_catalog.zig:33,67,262,321,369` and `app_commands.zig:3534`. Note the path: the catalog is under `core/config/`, **not** `core/slash_commands/`. | that row removed, menu drops to 11; `toggleFast`/`toggleFastForModel` become dead and go with it. **`/settings` itself is retained.** | — | `settings_catalog.zig` | `settings_catalog.zig` |
| settings menu row counts | `src/core/config/settings_catalog.zig:433,435`, `src/ui/footer/settings_menu_presentation.zig:364,385,490` | updated for one fewer row (12 to 11) | — | `settings_catalog.zig` | — |
| `applyFastMode` | called by `toggleFastForModel`, `selectModelFromPicker:529`, `setResolvedModel:660` | **retained** — the picker path survives | — | — | — |
| `--system` | declared (`commands.zig:39`), tested | unchanged | `ask` | — | — |
| `--quiet`, `--no-save`, `--image` | present | unchanged | `ask` | — | — |

#### Slice 4b — `--retry`, `--timeout`, `--verbose`

**Done, `fb69be33`.** `--timeout`'s declared placeholder is `<seconds>`, not
`<ms>` — `parseTimeoutMs` (`cli_ask.zig:3446`) parses the CLI value as
seconds and stores milliseconds internally; the first-drafted `<ms>`
placeholder would have told users to pass milliseconds and gotten a value
1000x too long. Caught and fixed in review before commit. The `/continue`
slash command and its `.continue_recovery` kind (`commands.zig:327`) were left
untouched, as scoped — that rename is Slice 10's, a different surface that
happens to land on the same target name.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `--retry` | `--continue-recovery` | renamed | `ask` | `cli_ask.zig` | `cli_ask.zig` |
| `--timeout <seconds>` | hidden, undeclared (`cli_ask.zig:3317`), 3 test callers | declared in the spec | `ask` | `commands.zig` | `cli_ask.zig` |
| `--verbose` | hidden, undeclared (`:3323`), no callers | deleted | — | `cli_ask.zig` | `cli_ask.zig` |

#### Slice 4c — `--permission-mode`

**Done, `8b9e4277`.** Migrated 29 e2e/eval files (~280 spawn-argument
substitutions, not the ~297 the earlier handoff estimated — that number
covered every obsolete ask-flag spelling across the whole Slice 4, not just
the permission ones). One spawn had no direct two-axis equivalent:
`permission-errors.test.ts`'s advisory-caution test combined `--auto` with
`--prompt-permissions` in one invocation; `--permission-mode auto` alone
covers it, since `auto` is defined to never open the captured-output prompt
— exactly what that test already asserted. `tests/e2e/cli.test.ts`'s stale
`--help`-text assertions (already a documented pre-existing gap since Slice
2a) were confirmed untouched; `tests/evals/agent-quality-matrix.ts`'s
`--auto`/`--json` mentions are prose describing past transcripts, not spawn
arguments, and were correctly left alone.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `--permission-mode <ask\|auto\|yolo>` | `--auto`, `--yolo`, `--prompt-permissions` | single flag; bad value exits 2; old flags immediate usage error, no aliases | `ask` | `cli_ask.zig` | `cli_ask.zig` |

Atomic replacement: all invocation and documentation call sites migrate in the
same commit as the parser change. No compatibility aliases, and migrated
callers do not land before the parser accepts the new spelling. This was the
sub-slice expected to exceed the usual file-count guideline (31 files) — that
breadth was inherent in the atomic flag replacement, not scope creep.

### Slice 5 — `auth`

**Done, `dd7527a1`.** `resolveAuthLoginProvider`'s first draft checked
`stdin_is_tty` before the single-provider case, so `auth login` with no
explicit provider would exit 2 in any non-tty context even at today's N=1 —
a regression from current `fiber login`, which has no tty check at all
(`chatgpt_oauth.runLogin` needs none). The tty gate only makes sense for the
genuinely ambiguous >1-provider case; reordered so a single provider
proceeds unconditionally, tty or not. Caught and fixed in review before
commit — the delegate's own test had been written around the buggy
ordering and would, once fixed, have driven a real OAuth attempt instead of
hitting the error path; replaced with a direct unit test of the resolution
function. `zig build test --summary all`: 9/9 steps, 7260/7262 passing, 2
pre-existing skips.

**Owner decisions (2026-09-04):**

- **`auth status` expiry field.** Adds `expires_at_ms: i64 | null` to the
  `auth.status` JSON, the raw value of `Credential.refresh_after_ms`
  (`credentials.zig:129`). `loadStatusSnapshotForProvider`
  (`auth_runtime.zig:298`) must capture it onto a new
  `auth_runtime.StatusSnapshot.expires_at_ms` field before its existing
  `defer credential.deinit(alloc)` fires — new plumbing, not a rename.
- **`auth login` non-interactivity.** `auth login` is browser/OAuth-only —
  there is no API-key credential path in this codebase. The ">1 provider,
  no arg" case is therefore *not* a distinct UX branch from plain "no tty":
  any non-interactive invocation (`!stdin_is_tty`) exits 2 and lists
  providers, regardless of how many providers exist. A tty with >1 provider
  gets a plain interactive prompt (unreachable at today's N=1, but the
  branch must be written generically over `model_provider.ProviderId`, not
  hardcoded to one arm). This needs a `stdin_is_tty` dependency added to
  `cli_surface.zig`'s `RunDeps` (`:254`) — it has no tty-detection field
  today, unlike `cli_ask.zig`'s `RunDeps` (`:403..413`), which is the
  pattern to mirror (`IsTtyFn`, real default backed by
  `std.Io.File.stdin().isTty(...)`, injectable for tests).
- **Stream for the no-tty error.** The exit-2 message and provider list go
  to stderr, consistent with existing usage-error conventions in this file
  (e.g. `writeUsageOrJsonError`).
- **JSON shapes**, following the `output_contracts.zig` snapshot pattern
  (`render`/`renderText`/`renderJson`, see `SessionListSnapshot` at `:836`):
  - `auth.list` → `{"providers":[{"id":"codex","name":"Codex","connected":bool}, ...]}`,
    built by iterating `provider_catalog.entries` (`provider_catalog.zig:14`),
    not hardcoded to codex.
  - `auth.status` → `{"provider":"codex","active_source":string|null,"required_source":string|null,"chatgpt_connected":bool,"expired":bool,"refreshable":bool,"expires_at_ms":i64|null}`,
    a new `AuthStatusSnapshot` wrapping `model_provider.ProviderId` plus the
    extended `auth_runtime.StatusSnapshot` above. Distinct type from the
    existing wide `StatusSnapshot` (`output_contracts.zig:479`, backs `fiber
    status`) — that one is untouched.
  - `auth.logout` → `{"provider":"codex","result":"deleted"|"missing"}`;
    `deleted_not_durable` stays a failure (`handled_failure`, non-JSON
    stderr message), it never reaches the success envelope.
- **Dispatch shape.** New `runTopLevelAuth(alloc, rest, cfg, deps)` in
  `cli_surface.zig`, mirroring `runTopLevelMcp` (`:1442`) as the template for
  a subcommand-parent with its own sub-dispatch on `rest[0]`.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `auth list` | absent | every supported provider, signed-in state; array-shaped | `auth.list` | `cli_surface.zig` | `output_contracts.zig` |
| `auth status` | absent; `fiber status` carries a subset | active credential: provider, expiry, refreshable | `auth.status` | `cli_surface.zig` | `output_contracts.zig` |
| `auth login [<provider>]` | top-level `login`; provider arg parsed then discarded (`cli_surface.zig:684`, via `parseLoginProvider` at `:174`) | provider honored; picks when >1 exists (unreachable today, must compile generically), proceeds when 1; no tty exits 2 and lists providers to stderr, regardless of provider count | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `auth logout [<provider>]` | top-level `logout`; arg discarded (`cli_surface.zig:709`) | provider honored | `auth.logout` | `cli_surface.zig` | `cli_surface.zig` |
| top-level `login`/`logout` | present (`commands.zig:58,64`) | absent | — | `commands.zig` | `command_specs.zig` |
| `/login`, `/logout` | present (`commands.zig:327-328`) | **unchanged** — no `/auth` parent | — | — | — |

### Slice 6 — `permissions`

**Done, `2f0690ca`.** No open product decisions surfaced during grounding —
every backend piece (`addPermissionRule`/`removePermissionRule`,
`parsePermissionMode`/`parsePermissionAction`, `loadMergedSettingsDetailed`'s
`PermissionSourceViews`, `canonicalWebFetchDomainPattern`) already existed
with zero non-test callers; this slice was pure CLI wiring. `zig build test
--summary all`: 9/9 steps, 7266/7268 passing, 2 pre-existing skips.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `permissions` (read) | present, read-only, enveloped | unchanged, enveloped | `permissions` | — | — |
| `permissions mode <mode>` | wired; sets persisted global mode via `setUserPreferences` | sets persisted mode | `permissions.mode` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule list` | wired; lists user/local rules from `loadMergedSettingsDetailed` | lists rules with scope | `permissions.rule.list` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule add [--user] <permission> <pattern> <action>` | wired via `addPermissionRule`; `web_fetch` patterns canonicalized before persist | wired | `permissions.rule.add` | `cli_surface.zig` | `config_runtime.zig` |
| `permissions rule remove [--user] <permission> <pattern>` | wired via `removePermissionRule` | wired | `permissions.rule.remove` | `cli_surface.zig` | `config_runtime.zig` |
| unmatched-pattern validation | `web_fetch` invalid patterns exit 2 at CLI parse via `canonicalWebFetchDomainPattern` | usage error, exit 2 | `permissions.zig` | `permissions.zig` |

### Slice 7 — `mcp`

**Done, `86188784`.** No open product decisions. `mcp list`'s JSON payload
wraps the existing preformatted text listing as one `listing` string field
rather than structuring per-server fields — a lazy-but-valid reading of
"enveloped"; noted for the end-of-transition audit, not reworked here.
`zig build test --summary all`: 9/9 steps, 7271/7273 passing, 2 pre-existing
skips.

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `mcp login` | `mcp auth` (`cli_surface.zig:1575`) | renamed; wired | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `mcp logout` | **present** at `cli_surface.zig:1631`, and gated alongside `auth`/`list` at `main.zig:3246`. The matrix had no row for it. | retained; enveloped for the error `code`, and it must stay paired with `mcp login` through the rename | `mcp.logout` | `cli_surface.zig` | `cli_surface.zig` |
| `mcp list --json` | no `--json` anywhere in `mcp` | enveloped; wired | `mcp.list` | `output_contracts.zig` | `output_contracts.zig` |
| `mcp add\|remove\|path\|trust --json` | absent | enveloped, for the error `code`; wired | `mcp.<sub>` | `output_contracts.zig` | `output_contracts.zig` |
| `mcp list --connect` | already removed from `src/` (`:1590` rejects the extra token); stale callers in `tests/e2e/mcp-http.test.ts:217` | callers removed; wired | — | tests | — |
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
| `parseResumeArgs` flag guard | confirmed real, at `cli_surface.zig:2618`: when `args[0]` is not `--id` it is trimmed and returned as the id, so `fiber resume --wat` resolves to session id `"--wat"` | rejects it, exit 2 | `cli_surface.zig` | `cli_surface.zig` |

### Slice 9 — resume paths and pagination

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `continue` | absent | resumes the most recent session, no picker | — (rejects `--json`) | `cli_surface.zig` | `cli_surface.zig` |
| `ask --resume-id <id>` | **present**, not absent: parsed at `cli_ask.zig:3297`, declared at `commands.zig:33`, ~12 test call sites | verify the semantics match "one-shot resumes a specific session"; likely no change. Do not confuse with `--resume-<id>` in the row below, which is a different spelling and is removed. | `ask` | — | `cli_ask.zig` |
| `-r`, `--resume`, `--resume-last`, `--continue`, `-c`, `--resume-<id>` | mixed: some parsed, some only in help | absent from parser and help | — | `cli_surface.zig` | `cli_surface.zig` |
| `sessions --continuation` | `--cursor` (`commands.zig:141,146`, parsed `cli_surface.zig:2442`) | renamed | `session.list` | `commands.zig` | `cli_surface.zig` |
| `sessions --limit` | **already declared and parsed**: a full `OptionDoc` at `commands.zig:146`, in the usage string at `:141`, parsed at `cli_surface.zig:2429`, with tests at `:2852`. The matrix implied work remained. | **no change** | `session.list` | — | — |
| `resume` (picker) | present | unchanged; **rejects `--json`** | — | `cli_surface.zig` | `cli_surface.zig` |

### Slice 10 — interactive surface

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `/retry` | `/continue` (`commands.zig:325`) | renamed; replays an interrupted turn from its checkpoint | `commands.zig` | `command_router.zig` |
| `/new` canonical, `/clear` alias | **two kinds with different behaviour**, not two spellings of one. `commands.zig:322` is `.clear_screen` — "start a fresh conversation while keeping managed processes"; `:323` is `.new_session` — "start a fresh session". Aliasing them collapses that difference. | **Decided (2026-09-04), per `demolition-inventory.md:456`: `/new` is canonical, `/clear` is its alias.** The `.clear_screen` behaviour (fresh conversation, managed processes kept) is removed; `/clear` routes to `.new_session`. This is a behaviour change, not reshaping — confirmed by the owner. `/background` (row below) is the separate, unaffected concern for inspecting/terminating managed processes. | `commands.zig` | `command_router.zig` |
| `/background` | rejected as unknown; confirmed at `command_router.zig:178` and absent from the welcome text (`command_specs.zig:1483`). The `"/background"` in `mods/registry.zig:119` is a test fixture, not a registration. | reachable; inspects and terminates background processes | `commands.zig` | `command_router.zig` |
| `/undo`, `/trace` | live (`commands.zig:333,336`) | **retained** — recorded owner decisions at `demolition-inventory.md:80,282` | — | — |
| `/exit` | already aliases `/quit` (`:340`) | unchanged | — | — |

### Slice 11 — `debug`

| Item | Current | Target | JSON `kind` | Owner | Focused test |
| --- | --- | --- | --- | --- | --- |
| `debug replay` | `replay` is a hidden top-level kind | reachable only under `debug` | `debug.replay` | `cli_surface.zig` | `command_specs.zig` |
| `debug trace` | absent; `/trace` is the slash form | hidden parent gains it | `debug.trace` | `cli_surface.zig` | `command_specs.zig` |

### Slice 12 — `/context`

| Item | Current | Target | Owner | Focused test |
| --- | --- | --- | --- | --- |
| `/context` | absent; TUI footer shows `Context: {d}k/{d}k {d}%` (`src/ui/render.zig:438`) | slash command showing used, window, percent | `commands.zig` | `command_router.zig` |
| context *occupants* | no per-component accounting exists | **deferred** — see `../enhancements/pending.md` | — | — |
| context usage in `ask --json` / `session show` | absent | **deferred** — same file | — | — |

### Carried from Phase 2 — verify at phase exit

| Item | Note |
| --- | --- |
| `--fx-internal-terminal-*` rename | **Verified clean 2026-09-04.** All re-exec flags are `--fiber-internal-terminal-*` (`terminal/tmux_session.zig:14,15`, `terminal/host.zig:20`, `terminal/shell_resolver.zig:299`), and the generated bootstrap string at `shell_resolver.zig:528` embeds the `fiber` spelling. Nothing further owed. |
| `upgrade --channel` | Already removed in demolition Slice 19. |

## Testing

The Zig unit tests in `output_contracts.zig`, `cli_surface.zig`,
`config_runtime.zig`, and `permissions.zig` run in the per-slice gate and are
updated as each slice lands. They are the coverage that matters during Phase 3.

**The exception: an argument a slice deletes is removed from its e2e call
sites.** A test that dies during argument parsing emits no output at all, which
destroys the one thing leaving e2e stale was meant to preserve — the old shapes
as a diff against the new ones. Deleting a dead argument from a spawn array is
the same mechanical class as the renames the slices already perform. Rewriting
an *assertion* is not, and stays forbidden. A test whose subject is the deleted
argument is deleted with it.

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
