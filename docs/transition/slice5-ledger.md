# Slice 5 triage ledger

Every candidate from `docs/enhancements/pending.md`, `docs/ideas/`,
`docs/transition/deferred.md`, and the phase 6 plan's floor list. Each row
carries an owner ruling. Kept items are filed as GitHub issues and record the
issue URL; dropped items record why, so deletion is deliberate.

Status: every candidate ruled and every kept row filed, 2026-09-10 (issues #4 to #59). `docs/enhancements/`, `docs/ideas/`, and
`docs/transition/` are deleted in slice 6 only after every row is ruled and
every kept row has a URL.

---

## 1. Active-turn steering defaults — KEEP

Source: `docs/enhancements/pending.md:25`
Ruling: keep as one issue. Queue action is not bound to Cmd.
Issue URL: https://github.com/aakshintala/Fiber/issues/15

**Title:** Enter steers the active turn; Alt+Enter queues a follow-up

**Body:**

Today `Enter` queues a follow-up turn and `Ctrl+Enter` steers the running one.
The common action should use the common key.

Target bindings:

- `Enter` steers the active turn at the next safe model boundary
- `Alt+Enter` queues a separate follow-up turn
- `Escape` cancels active work, then applies a pending steering message once the
  turn settles

`Alt+Enter` rather than `Cmd+Enter`. Cmd is Super (modifier bit `0x08`, param
`;9` in `src/ui/input/escape_parser.zig:43`), it does not exist on Linux, and
Super is normally grabbed by the window manager there. fiber already uses Cmd
only for macOS conveniences that have portable equivalents underneath
(Cmd+A/C/X/Z, Cmd+Left, Cmd+R, Cmd+Backspace). `Alt+Enter` sends `ESC CR` even
without the Kitty keyboard protocol, so it works in legacy terminals. A
macOS-only `Cmd+Enter` alias may be added on top.

Requirements:

- one ordering contract across active model output, running tools,
  cancellation, recovery, and resumed session history
- the composer shows whether a pending message will steer or queue before fiber
  accepts it

Depends on reliable modifier detection; see the keyboard protocol issue.

---

## 2. Keyboard protocol acceptance is never determined — KEEP (narrowed)

Source: found during slice 5 grilling, not in any existing document.
Ruling: keep as a defect issue, narrowed after delegated verification
(job c20950b3, composer-2.5, findings spot-checked against the source).
Terminal matrix deferred into the issue as an implementer task.
Issue URL: https://github.com/aakshintala/Fiber/issues/16

**Title:** Terminal keyboard protocol support is assumed, never determined

**Body:**

`src/ui/terminal/terminal.zig:4` sends `\x1b[>4;2m` (xterm modifyOtherKeys
level 2) and `\x1b[>1u` (Kitty keyboard protocol). Nothing reads a reply.
`interactiveModeEnableSequence` (`terminal.zig:29`) omits `\x1b[>1u` when
`TMUX` is set and leaves negotiation to tmux; that is an environment guess, not
a terminal response. `cursor_probe` and `theme_monitor` both query the terminal
and parse replies with timeouts, so the pattern exists in this codebase and is
simply not applied here.

The input parser is more capable than the enable path assumes. It accepts both
encodings of every modifier binding: the Kitty CSI u form and the
modifyOtherKeys three-parameter form. `ESC[13;5u` and `ESC[27;5;13~` both reach
`.steer_submit` (`src/ui/input/escape_parser.zig:642-654` and `:112`). Since
`\x1b[>4;2m` is sent in both enable sequences, a terminal honoring
modifyOtherKeys alone still steers correctly.

The residual exposure is terminals that honor neither request. There, every
modifier binding collapses onto its unmodified key: `Ctrl+Enter` arrives as bare
`\r` and queues instead of steering (`app_input_runtime.zig:1478`). The user
sees the wrong action, not an error. The same collapse applies to roughly 25
other bindings, including Ctrl+O for the full transcript and every Cmd editing
key.

Verification needed, as an implementation task rather than a triage blocker:

- [ ] Terminal.app: which of the two requests, if either, it honors
- [ ] tmux with and without `extended-keys`, since fiber defers to tmux there
- [ ] one terminal honoring the Kitty protocol, as the control

Also worth closing while here: `ESC[27;5;13~` has no test, though `ESC[13;5u`
does (`runtime.zig:4660`) and the Shift+Enter triple does (`runtime.zig:2737`).

Fixing it needs one of: read the reply to a protocol query and adapt, give
modifier bindings a portable fallback, or tell the user which bindings are
unavailable. Related to the Enter/Alt+Enter steering change, which assumes
modifier detection is reliable.

---

## 3a. Context occupants — KEEP

Source: `docs/enhancements/pending.md:44`
Ruling: keep. Split from 3b at the accounting seam.
Issue URL: https://github.com/aakshintala/Fiber/issues/17

**Title:** /context shows usage without occupants

**Body:**

`/context` reports tokens used, the window, and a percentage
(`app_commands.zig:3158`). The design also asked for occupants: which
components fill the window.

Nothing in the tree computes that. The only per-component accounting is for
history — `estimateHistoryTurnTokens` and `selectBudgetedHistoryTurns`
(`session.zig:2453,2469`) and `historyContextBudgetTokensForCapabilities`
(`prompt_context.zig:12`). Nothing counts the system prompt, tool definitions,
MCP tool schemas, or skills.

Target: a full breakdown across system prompt, tools, MCP schemas, skills,
history, and files, which means per-component token accounting through the
prompt assembly path.

A coarse version — history versus everything else, by subtraction — was
considered and rejected. The residual inherits every error in the history
estimate, and the reason to run `/context` is to decide what to evict.

---

## 3b. Two disagreeing context numbers — KEEP

Source: `docs/enhancements/pending.md:64` ("Related"), reframed after
verification. The note called this plumbing; it is a correctness question.
Ruling: keep as a defect issue.
Issue URL: https://github.com/aakshintala/Fiber/issues/18

**Title:** Reconcile the two context-usage numbers and surface the right one

**Body:**

fiber has two context-usage values that disagree, and the one with the careful
contract is dead.

`/context` renders `app.total_input_tokens` (`app_commands.zig:3176`). Despite
the name it is not a total: `app_callbacks.zig:949` assigns rather than
accumulates, so it holds the last request's input tokens. It is persisted and
restored across sessions (`app_session_runtime.zig:1441`).

`Usage.liveContextSnapshot` (`session_usage.zig:1360`) returns input plus
output, and its doc comment states the value is deliberately runtime-only
because a restored billing aggregate cannot prove current occupancy. It has
zero callers anywhere in the tree.

So the two differ on whether output counts and on whether the value survives a
restore. Decide which is correct, delete the loser or rename it to what it
actually holds, then surface the survivor in `fiber ask --json` and
`fiber session show`.

Note the constraint the dead accessor names: a restored session cannot report
live occupancy. `fiber session show` on a saved session may have no honest
answer, and should say so rather than print a stale number.

---

## 4. `/background` — KEEP (rescoped)

Source: `docs/enhancements/pending.md:67`
Ruling: keep, rescoped from the source note. The note's premise did not survive
checking: it describes a half-finished upstream migration needing a decision on
how much of a deleted 9,000-line subsystem to rebuild. The substrate is present
and complete; only the entry points are missing.

Three of the note's four claims are stale:

* "no backing registry — nothing tracks a spawned background command's id, PID,
  or log path" — `store.zig:690 ownerCatalog` returns a durable `CatalogList`
  of `CatalogEntry{facts, cwd, workspace_root, authorization}`
* "There is no `terminal.list` or `terminal.stop`" — `stop` is a live shell
  action (`shell.zig:31`), and `list` is implemented at
  `native_session.zig:1310` with `ListFilters`
* "`ctrl_x_manager_byte` declared but never dispatched — dead code" — the
  constant is gone, and three tests now pin Ctrl-X as deliberately inert

The fourth holds: the `background_process` approval gate exists and nothing
follows it (`shell_command/command_effect.zig:301`; the file moved out of
`core/tooling/`).

Issue URL: https://github.com/aakshintala/Fiber/issues/19

**Title:** No way for a human to see or stop what the agent started

**Body:**

The agent can start, drive, and stop its own shell sessions: `run`, `interact`,
`stop` (`src/tools/shell/shell.zig:31`). A person has none of that. Nothing
lists what is running, and nothing kills it. When a session outlives its turn
the only recourse is to leave fiber and find the process by hand.

This is an exposure gap, not missing capability. Enumeration is implemented end
to end and unreachable:

- `store.zig:690 ownerCatalog` — durable per-owner catalog, returning
  `CatalogEntry{facts, cwd, workspace_root, authorization}`
- `native_session.zig:1310 list` — the registry operation, with `ListFilters`
- `contracts.zig:44` — `list` as a first-class operation, with permission
  scoping (`:1496-1604`) and retryability (`action_executor.zig:86`)
- `tool_group_projection.zig:116` and `app_worker_runtime.zig:954` already
  handle a `.list` result

Nothing in the tree constructs a `ListFilters`, so none of it runs.

Scope:

- a `list` action on the shell tool, over the existing registry operation
- `/background`, currently unregistered and asserted absent from welcome text
  (`command_specs.zig:1402`), rendering that list and offering stop
- text and JSON from one snapshot, per the command contract

Out of scope: rebuilding the upstream `src/core/background/` subsystem. It was
deleted in `3f59a59d` before Fiber's fork, and its replacement is the terminal
runtime this issue exposes.

Note when implementing: Ctrl-X is currently inert on purpose, with tests
pinning that (`app_input_runtime.zig:7828,9615,9641`). If `/background` wants a
key, that decision is deliberate and those tests are the record of it.

---

## 5. `fiber debug trace` — DROP

Source: `docs/enhancements/pending.md:107`
Ruling: drop. Owner-approved 2026-09-09 with a follow-up question, answered below.

`buildTraceReport` (`app_commands.zig:1953`) reads mostly live state that dies
with the process — renderer, transcript timeline, session `always` grants,
diagnostics rings, MCP runtime lease. The durable parts are already reachable
(`fiber session show`, `FIBER_TRACE_LOG`). A headless port would be a weaker
report under an identical name, and its runtime-context section would report
the wrong terminal.

Owner question: what feeds `fiber debug replay`? Tapes, via `FIBER_RECORD` /
`FIBER_RECORD_INPUT` (`record_tape.zig`, wired in `event_loop.zig`,
`transcript/io.zig`, `app_lifecycle.zig:434`). Replay and trace are
independent; dropping trace starves nothing.

---

## 6. `fiber mcp doctor` — KEEP

Source: `docs/enhancements/pending.md:131`
Ruling: keep as one issue. Owner-approved 2026-09-09.
Issue URL: https://github.com/aakshintala/Fiber/issues/20

**Title:** `fiber mcp doctor` checks that configured servers actually answer

**Body:**

`mcp list` shows the stored listing and `fiber doctor` validates the config
file. Neither opens a transport. Since `mcp list --connect` was removed
(unknown flags are usage errors), no command checks whether a configured
server actually answers.

Target: open each configured server transport, report per-server connection
and authentication, in text and JSON from one snapshot per the command
contract.

Constraints: fail closed, bounded timeouts, no credential leakage in output;
respect the existing admission and permission scoping.

---

## 7. `fiber usage --session <id>` — KEEP

Source: `docs/enhancements/pending.md:143`
Ruling: keep as one issue. Owner-approved 2026-09-09.
Issue URL: https://github.com/aakshintala/Fiber/issues/21

**Title:** `fiber usage --session <id>` reports per-session spend

**Body:**

`fiber usage` reports profile windows only (`--period <24h|7d|30d>`,
`usage_report.Scope`). There is no session dimension anywhere in the usage
tree.

Target: a per-session aggregation over the same local records, as a new query
dimension on `usage` alongside `--period`, in text and JSON from one snapshot.

---

## 8. Multi-provider — SUPERSEDED by the multi-provider epic (row E1)

Source: `docs/enhancements/pending.md:149`
Ruling: the single-issue ruling below was superseded on 2026-09-09 by an epic
with linked provider issues. See row E1. The body below is retained only as
evidence for the epic's routing-architecture issue.
Issue URL: none; see E1

**Title:** Attach a second model provider

**Body:**

`ProviderId` has one variant (`model_provider.zig:4`); `provider_set.select()`
carries a single-arm switch. Auth surfaces are shaped for several providers
but implemented against Codex alone.

Target: catalog merge across providers, per-provider credential resolution,
and an active-provider concept not hardcoded to `.codex`. The deleted Grok
provider is the template for how a second one attaches.

Priority: high, per owner.

---

# Rulings 9–56 and later items

Rows below record the ruling, source, and one-line outcome. Issue bodies are
drafted separately and each needs explicit owner approval before posting.
Candidate numbers 17, 26, 27, 29, 30, and 38 were never recorded in the
surviving discussion handoff. The coverage audit on 2026-09-10 checked every
`pending.md` heading, every `docs/ideas/` file, `deferred.md`, and the phase 6
floor list against these rows and found nothing unruled, so those numbers are
treated as unnumbered items below (most likely the readiness-epic children).

## Dropped or completed, no issue

| # | Item | Reason |
|---|---|---|
| 9 | Testing-story umbrella (`pending.md:163`) | Concrete Phase 5 work complete after `24d96e5e`; fuzzing kept separately as 15 |
| 10 | ACP (`pending.md:178`) | Owner wants embedding through a stable C API (24), not an ACP host |
| 16 | Fiber product-transition spec (`docs/ideas/fiber-product-transition.md`) | Completed by the transition itself |
| 31 | Non-interruptible UI wrappers (`deferred.md` Phase 6) | Keep in source; one-line test conveniences over production code |
| 33 | Stale `gateway_reviewer_model` (`deferred.md` Phase 6) | Resolved by `4ce80e1d`; fallback `codex-auto-review` with drift test |
| 34 | Approval pacing hold | Current Codex behavior accepted; permissions still gate execution |
| 35 | Malformed historical tool calls | Current behavior accepted: exact audit events kept, malformed fragments omitted from resumed context, recovered final turn retained |
| 36 | `ticket02-runaway-reference` branch | Delete after transition merge once its two orphan commits are confirmed empty of wanted work |
| 40 | Process non-goals | Website, public roadmap, calendar cadence, local PGSO reconstruction, permanent census tooling, scheduled CI: all dropped |
| 47 | Upstream Ctrl-C-clears-draft-first | Exact behavior dropped; owner key contract added to row 1 instead |
| 48 | Upstream terminal title | Fiber's `<workspace or session> · <provider/model>` title is already better |
| 56-0 | Upstream `cdc0a14a` full-viewer resize restore | Already present: `repaintRestoredPrimaryTranscriptAfterResize` (`runtime.zig:6252`) |
| — | `pi-gui` feedback observations 1, 2, 4, 7, 8 (`docs/ideas/feedback-from-failed-pi-gui-integration.md`) | Satisfied or explicitly "do not act"; 3, 5, 6 fold into 19, 21+22, 23 |
| — | `mcp list` unfillable fields (`deferred.md` Phase 6) | Resolved 2026-09-08 |

## Closeout cleanup, corrective slice before Slice 6 (not issues)

These change source or tests, so they land in their own slice, not in the
documentation-only ledger commit.

- 11. Delete the unwritten `relationship-index.bin` fallback and `session_relationship_index_codec` (`pending.md:206`)
- 12. Delete `reportTurnControl`, its sink plumbing, and the unreachable orchestrator branch (`pending.md` Phase 4 residue)
- 13. Delete unused provider-side OAuth `Metadata.revocation_endpoint`, `LogoutResult.remote_revocation_failed`, and residue; MCP OAuth revocation stays
- 32. Clean classified inert ACP names, comments, fixture IDs, and the vacuous ACP help assertion (`deferred.md` Phase 6)
- `fiber upgrade` help advertises a release channel that does not exist (`src/builtins/commands.zig:190,260`; `deferred.md` Phase 6)

## Kept: standalone issues

| # | Item | Source | Issue URL |
|---|---|---|---|
| 14 | `core -> builtins` composition, behavior-preserving, no preselected mechanism | `pending.md:228` | https://github.com/aakshintala/Fiber/issues/22 |
| 15 | Randomized session/TUI state-machine fuzzing with seeds, replay, minimization, invariants | `pending.md:239` | https://github.com/aakshintala/Fiber/issues/23 |
| 20a | Builtin customization | `docs/ideas/builtin-customization-and-extensions.md` | https://github.com/aakshintala/Fiber/issues/24 |
| 20b | Executable extensions with a real security, resource, and lifecycle contract | same | https://github.com/aakshintala/Fiber/issues/25 |
| 23 | Unknown top-level config keys diagnosed with exact key and layer at startup and in `doctor` | `pi-gui` observation 6 | https://github.com/aakshintala/Fiber/issues/26 |
| 25 | Missing or corrupt resumed image inserts a typed model-visible `image_unavailable` notice | `phase5-triage.md:409` | https://github.com/aakshintala/Fiber/issues/27 |
| 28 | Credentialed `fiber models` returns `MalformedResponse` (current Codex defect; linked to E1, not blocked) | phase 6 floor list | https://github.com/aakshintala/Fiber/issues/28 |
| 37 | Hashed terminal-host fallback directories left under `/private/tmp` | Slice 5 grilling | https://github.com/aakshintala/Fiber/issues/29 |
| 39 | Unknown monetary spend renders `$0.0000`; represent cost availability explicitly | Slice 5 grilling | https://github.com/aakshintala/Fiber/issues/30 |
| 41 | Bounded shell termination settlement: deterministic ceiling after force-kill, report indeterminate not success | upstream harvest | https://github.com/aakshintala/Fiber/issues/7 |
| 42 | Empty `shell.interact` observations wait at least 5 s; input-sending interactions keep short waits | upstream harvest | https://github.com/aakshintala/Fiber/issues/8 |
| 43 | Session-recovery parity and invariant audit (not a port) | upstream harvest | https://github.com/aakshintala/Fiber/issues/9 |
| 45+46 | MCP OAuth pinned loopback callback port and single trailing-slash issuer tolerance | upstream harvest | https://github.com/aakshintala/Fiber/issues/10 |
| 49+50 | Empty skill `resource` means `SKILL.md`; named success/failure rows for explicit `$skill` loads | upstream harvest | https://github.com/aakshintala/Fiber/issues/11 |
| 52 | Saved-session discovery performance: measurement and latency outcome first; any cache validates freshness and stops obsolete scans | upstream harvest | https://github.com/aakshintala/Fiber/issues/12 |
| 53 | History budget counts images as zero tokens while resending them | upstream `eacc1c8c`; `session.zig:3243` | https://github.com/aakshintala/Fiber/issues/4 |
| 56a | Ctrl+L destroys full-transcript (Ctrl+O) history | upstream `d542df75`; `store.zig:991-1006` | https://github.com/aakshintala/Fiber/issues/5 |
| 56b | Resize while Ctrl+O is open may erase primary scrollback | upstream `388eb2a0`; `app_render_runtime.zig:1400` | https://github.com/aakshintala/Fiber/issues/6 |
| O1 | Semantic TUI color honoring `NO_COLOR`, no-color terminals, light/dark themes | owner-raised | https://github.com/aakshintala/Fiber/issues/13 |
| O2 | Session-only model choice alongside the profile-writing picker | owner-raised; `app_session_runtime.zig:2249-2264` | https://github.com/aakshintala/Fiber/issues/14 |

Row 1 (steering) gains the owner key contract from 47: Escape cancels active
work without clearing the composer; submitted steering waiting on cancellation
starts it; Ctrl-C clears composer state; with an empty composer Ctrl-C uses
double-press exit even while work is active.

## Kept: epics and linked issues

| Row | Epic or child | Issue URL |
|---|---|---|
| E1 | Multi-provider epic (Codex is the reference implementation; contract must absorb new transports, auth schemes, catalogs, regional variants; per-provider credentials, logout, and honest remote revocation; remaining Pi 0.85.1 providers listed as a point-in-time deferred inventory) | https://github.com/aakshintala/Fiber/issues/31 |
| E1.0 | Provider/model routing architecture | https://github.com/aakshintala/Fiber/issues/37 |
| E1.1–E1.8 | Anthropic; OpenAI API; Google Gemini; OpenRouter; OpenCode Go; Databricks; Vercel AI Gateway; Ollama and user-configured compatible endpoints | #38 Anthropic, #39 OpenAI API, #40 Gemini, #41 OpenRouter, #42 OpenCode Go, #43 Databricks, #44 Vercel AI Gateway, #45 compatible endpoints |
| E2 | Pre-v0.0.1 readiness epic | https://github.com/aakshintala/Fiber/issues/32 |
| E2.x | GitHub Release distribution, assets, checksums/signing, installer, safe `fiber upgrade`; prerelease SemVer ordering in `update_target.zig`; first stable release prep; validate changelog and release inputs before any tag push; changelog guidance with the harvested `prepare-release.yml` prompt and dry-run proof; repair live evals and gated live E2Es with a bounded credentialed gate; measure and rework CI/E2E isolation and runtime; full repository user documentation | #46 distribution, #47 SemVer, #48 stable release, #49 validate before tag, #50 changelog prompt, #51 live evals, #52 CI runtime, #53 user docs |
| E3 | Semantic compaction epic (44): threshold summary handoffs, durable tool-result handles, resumed sessions, oversized recent tool exchanges; links 3b and 43 | https://github.com/aakshintala/Fiber/issues/33 |
| E3.1 | Provider context-overflow recovery (54, upstream `cececebe`): one bounded compact-and-replay, pending prompt preserved, typed capacity-exceeded failure | https://github.com/aakshintala/Fiber/issues/54 |
| E4 | Stable C API headless-runtime epic (24) | https://github.com/aakshintala/Fiber/issues/34 |
| E4.1 | Stable tool-event contract (21+22): Fiber-owned ID before first emission, provider IDs separate, full terminal payloads, typed outcomes instead of sentinel strings (`pi-gui` observations 1, 4, 5) | https://github.com/aakshintala/Fiber/issues/55 |
| E4.2 | Structured shell failures in `fiber ask --json` (51): action, bounded category, stable code | https://github.com/aakshintala/Fiber/issues/56 |
| E5 | Session traversal design epic (19): branching, rewind/fork, lineage with durable parent links (`pi-gui` observation 3), TUI navigation, JSON automation, compaction, recovery | https://github.com/aakshintala/Fiber/issues/35 |
| E6 | Subagent epic (new 2026-09-10) | https://github.com/aakshintala/Fiber/issues/36 |
| E6.1 | Subagent rows show agent name, typed state, bounded terminal-safe task preview, live and resumed (55, upstream `268f163d`) | https://github.com/aakshintala/Fiber/issues/57 |
| E6.2 | Explicit per-subagent provider/model selection recorded in child state and shown to the user (moved out of E1 shared requirements; E1 cross-links) | https://github.com/aakshintala/Fiber/issues/58 |
| E6.3 | Cross-harness `delegate` tool, initially Claude Code and Cursor Agent (18); reconcile with `docs/ideas/harness-delegation.md`, which proposed external MCP configuration for v1 | https://github.com/aakshintala/Fiber/issues/59 |
