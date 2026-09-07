# Fiber transition plan

Authoritative product design: [`docs/ideas/fiber-product-transition.md`](../ideas/fiber-product-transition.md).

Plan only the active phase in detail. Do not recreate a complete ticket tree upfront. Before delegating implementation, split the active phase into independently reviewable slices of one subsystem or about 15 files.

The transition ends at Phase 6. It is step one, not the release. Fiber is
stamped `0.0.1` only after the enhancement work in
[`../enhancements/pending.md`](../enhancements/pending.md) brings the product to
where it should be. That file owns everything deferred out of the transition for
being net-new capability rather than reshaping of inherited behavior; this file
owns the transition only.

Cleanups found mid-slice that belong to a later phase go in
[`deferred.md`](deferred.md), tagged with the phase that owns them. A slice must
not widen to absorb them.

The transition documents are disposable. They are deleted at the end of Phase 6,
after Phase 6 has harvested their rationale into product documentation.

## Phase 1: Demolition

Remove code, tests, fixtures, build wiring, workflows, configuration, and documentation that exist only for products or behavior Fiber will not retain.

Current step: execute the ordered slices in [`demolition-inventory.md`](demolition-inventory.md). That document classifies every design requirement as already removed, pending deletion, rename work, new implementation, final verification, or deferred, and holds the resolved ambiguities.

Interim completion gate for each slice is defined in `AGENTS.md`. Routine E2E and live-model verification are deferred. Preserve failures involving retained behavior as evidence for Phase 5.

**Reopened 2026-09-04.** Slices 1-20 closed the demolition scoped at the audited
revision. Phase 3 contract planning then produced an owner decision to delete the
ACP surface — demolition by kind and by gate — which lands as slices 21-23. It
must precede the Phase 3 contract slices: `src/acp/prompt.zig` is a second agent
host on the same session store and permissions as the CLI, so every contract
implemented while it exists is implemented twice.

Phase exit: every deletion required by the product design is either absent from the tree or explicitly reclassified into a later phase, with exact path and symbol evidence.

## Phase 2: Fiber identity cutover

Rename the retained executable, product text, state paths, environment variables, internal formats, credentials, artifacts, tests, fixtures, and developer tooling. Add no fx compatibility readers, aliases, imports, migrations, or fallbacks.

Current step: execute the ordered slices in [`identity-inventory.md`](identity-inventory.md). That document measures the rename surface, separates silent renames that change runtime or on-disk behavior from inert ones, and holds the per-slice stop conditions.

Phase exit: the repository builds `fiber`; exact searches find no unexplained product-level fx identity or compatibility reads.

## Phase 3: Contract implementation

Implement the chosen command, flag, session, authentication, permission, MCP, model-routing, usage, and JSON-output contracts from the product design.

Phase 3 is **reshaping only**: existing behavior gets a new spelling or a new
seam. Net-new capability is not transition work and moves to
[`../enhancements/pending.md`](../enhancements/pending.md), whatever its size.
Renaming `--cursor` to `--continuation`, exposing an existing
`deleteCommittedSession` through the CLI, and reconnecting `addPermissionRule`
to a command are reshaping. Building token accounting that nothing computes
today is not.

Current step: execute the ordered slices in [`contract-inventory.md`](contract-inventory.md). That document measures the current command surface against the target, records the resolved output-envelope, exit-status, permission-rule, fast-mode, and provider-shape decisions that every slice conforms to, and carries one matrix row per target item.

Phase exit: every target contract exists behind its owning typed interface and has focused unit coverage.

## Phase 4: Simplification

Remove all verified dead code, false variation, obsolete product residue, and
unsupported platform behavior. Inherited dead code is in scope. Collapse
single-implementation seams when they do not protect a real effect, unavailable
adapter, test adapter over retained behavior, public contract, persisted format,
or security boundary.

Fiber supports macOS arm64, Linux x86_64, and Linux arm64. Phase 4 removes
Windows, WebAssembly, WASI, Emscripten, freestanding, macOS Intel, BSD, and other
unsupported-target behavior. `build.zig` must reject unsupported targets before
their branches are removed.

The September 5, 2026 audit covered all 490 Zig files under `src`, not the whole
tree. Its raw 360-row corpus and arithmetic remain evidence, but its original
triage is superseded by
[`phase4-audit/CORRECTIONS.md`](phase4-audit/CORRECTIONS.md). The corrected
ordered work is in
[`simplification-inventory.md`](simplification-inventory.md).

Before the first source slice, run the complete deterministic E2E suite once and
record a per-test baseline. None has run during the transition. Phase 4 still
preserves behavior on retained targets, but the baseline now proves whether a
later failure is new instead of assuming every Phase 5 failure was pre-existing.
Run E2E checkpoints after unsupported-platform removal, after host-profile
collapse, and at phase exit. Keep routine per-slice E2E deferred.

Open by confirming the Phase 4 section of [`deferred.md`](deferred.md) is empty.
Newly exposed dead code stays in Phase 4 rather than moving to a post-transition
backlog.

Phase exit: the build accepts exactly the 3 retained targets; every audited dead
or tested-only row is deleted, retracted, or explicitly retained; every remaining
implementation seam has measured justification; unsupported-platform and removed
product searches have no unexplained hits; no E2E failure or failure signature is
new against the opening baseline; and the Phase 4 section of `deferred.md` is
empty.

## Phase 5: Repair and exhaustive verification

Build the final Fiber product, run deterministic E2E once, and group failures by retained product contract. Repair one subsystem at a time, add focused unit regressions where practical, and rerun affected E2E files. Finish with the full deterministic suite and real TUI, Codex, JSON automation, session, and subagent interactions.

E2E is not gating before this phase, by decision. Two known consequences arrive
here rather than earlier:

- **The `--json` assertions are stale.** Phase 3's envelope changes 13 payload shapes and only the Zig unit tests are updated as slices land. The old expected shapes are a useful diff against the new ones.
- **Session-recovery coverage is dark.** `tests/e2e/session-recovery.test.ts` was built entirely on `fiber acp` and was deleted with it. This phase decides the testing story before rebuilding, rather than porting the old harness.
- **TUI recovery needs transition coverage.** Upstream fixes after the fork exposed
  repeated state-loss risks where resize, cancellation, approval screens, menus,
  transcript transitions, and session recovery meet. Fiber retains these
  interactions and must verify their combined behavior rather than treating each
  event in isolation.

### TUI state-transition recovery

Exercise retained behavior through the real TUI and add focused unit regressions
for failures found. The matrix must prove:

- resize during model output, tool activity, and cancellation restores the main
  transcript, composer, cursor, and terminal modes
- closing approval and catalog screens after resize restores transcript rows and
  preserves the pending approval or selection
- `Ctrl+L` preserves the draft and conversation while `Ctrl+O` still shows the
  complete transcript
- clearing, reopening, and resizing the full transcript preserves scrollback and
  returns to the same inline conversation
- cancellation does not admit late model output or tool results into the next
  turn
- resuming after interruption preserves accepted assistant text, tool activity,
  images, skill context, and retrievable stored output

A test passes only when the final grid, scrollback, draft, transcript content,
and terminal modes are correct. Process survival alone is not enough.

### Session-recovery harness: what the deleted suite proved

Transcribed before deletion so the rebuild has a spec rather than an
archaeology task. Sixteen cases, all driving a long-lived writer, pausing at a
named `session_log.Boundary`, and then SIGKILLing it.

The crash machinery is **generic and survives**: `FIBER_E2E_SESSION_BOUNDARY`
and `FIBER_E2E_SESSION_BOUNDARY_READY` are read by
`session_test_controls.zig`, and the boundary calls live in
`src/core/session/session_log.zig:2218` (create path) and `:3296` (commit path).
Only the wiring was ACP's — `fiber ask` passes empty options at
`cli_ask.zig:832,2562` and so ignores the env vars.

1. **Uncommitted create orphan** (3 cases). Death at `after_event_append`, `after_event_sync`, `after_watermark_rename` during session create. Proves: `sessions --json` count is 0, and `doctor` reports `authority_less_creation_orphan`.
2. **Proposed authority confirmed on load** (3 cases). Death at `after_authority_marker_rename`, `after_authority_namespace_sync`, `after_authority_intent_remove`. Proves: the directory exists, list still hides it, a writable load confirms proposed authority, and `session --id` then succeeds.
3. **Doctor removes only a validated noncurrent watermark** (1 case). A `commit.<gen>.json` is planted into a complete session; `doctor` reports `cleanup_removed=1` and the planted file is gone. No mid-protocol crash.
4. **`session recover` copies without mutating the source** (1 case). Corrupt the watermark, recover, and confirm the source bytes are unchanged and still `InvalidSessionFormat`, while `ask --resume last` reaches the copy.
5. **Cross-workspace recovery preserves both resume-last pointers** (1 case). Three sessions across two workspaces; recovering a corrupt session in workspace A from workspace B leaves each workspace's `--resume last` on its own newest healthy session.
6. **Fenced create orphan** (1 case). Death at `after_authority_intent_sync`. Proves: `doctor` reports `authority_transition_pending report_only=true`, list reports `skipped_invalid: 1`, a writable load fails `Session not found` and drops `authority.pending.json`, after which `doctor` reports `authority_less_creation_orphan` and `session --id` reports "record not found".
7. **Model commit recovery across six boundaries** (6 cases). Persist a model preference, then die at each of `after_event_append`, `after_event_sync`, `after_commit_intent_sync`, `after_watermark_rename`, `after_target_namespace_sync`, `after_commit_intent_remove`. Proves: a second load always clears `commit.pending.json`, and the new model survives only for the last three.

Two affordances the replacement needs that `fiber ask` lacks today: a **writable
resolve with no prompt** (ACP's `session/load`; `fiber session --id` is
read-only at `cli_surface.zig:1016`) and a **model-only commit with no turn**
(ACP's `session/set_config_option`). Neither requires a protocol. Decided
approach: use `ask --resume-id` with a fake gateway and accept a dummy turn for
the resolve, and assert on `history_turn_committed` rather than
`preferences_changed` for the commit — the same commit protocol, a different
event. A `FIBER_E2E_SESSION_EXIT_AFTER_WRITABLE_OPEN` hook is the fallback if
that cannot reach a case.

Note that no case in the deleted suite proved `events.jsonl` surviving SIGKILL
mid-turn, or `checkpoint.json` replay. Close cousins are already covered
in-process by `session_log.zig:5868,5896,5923,5969,6659` and
`session_store.zig:8443,8519,9172`. What is uniquely end-to-end is SIGKILL with
no unwind, plus the `doctor` and `sessions` CLI text.

### ACP-driven cases retained for conversion

Slice 23 deleted the ACP-only E2E cases but kept four that prove retained
product behaviour and merely used ACP as their transport. Each still calls
`nodeSpawn(FIBER_BIN, ["acp"], ...)`, so each is red until converted. Convert
the driver, keep the assertion:

| Case | File | What it proves |
| --- | --- | --- |
| ACP explicit deny emits no web_fetch progress or target request | `tests/e2e/web-fetch-fake-network.test.ts:538` | a denied `web_fetch` returns `policy_denied` to the gateway and emits no fetch progress |
| ACP policy denial omits web_search from the advertised tools | `tests/e2e/web-search-fake-codex.test.ts:297` | a denied `web_search` permission removes the tool from the advertised provider tool list |
| ACP completes more than twenty-five serial terminal calls when unlimited | `tests/e2e/tui-command-permissions.test.ts:3635` | more than 25 serial `pwd` calls succeed when the permission is unlimited |
| ACP blocks redirected output before creating a file | `tests/e2e/tui-command-permissions.test.ts:3671` | a shell redirect is permission-blocked before any file is created |

The shared `AcpClient` helper and the `startAcpSession` / `startAcpCodeSession`
wrappers in those three files exist only for these cases and go with them.

Separately, `tests/e2e/terminal-host.test.ts:3949` sets
`transport_role: "acp"` as a deliberately foreign principal value. Slice 22
removed that arm from `TransportRole`, so the case now exercises an unparseable
role rather than a valid-but-different one. Re-point it at a surviving role.

Phase 5 dispositions (all four converted or retired, helpers gone with them):
the web_fetch deny converted to a domain-scoped ask deny (`policy_denied`,
no fetch progress); the web_search deny deleted as a converted-duplicate of
the ask-based deny case in the same file; the two command-permissions cases
converted in the codex-queue migration with intents retained; the
terminal-host role re-pointed at `"headless"`.

Phase exit: the success criteria in the product design are directly exercised, with unavailable external checks recorded as unverified, and the Phase 5 section of [`deferred.md`](deferred.md) is empty.

## Phase 6: Final documentation and release preparation

Rewrite `AGENTS.md`, `CONTRIBUTING.md`, README material, and related process guidance for the verified Fiber workflow. Remove the temporary transition process. Build the local fast and exhaustive gates required before preparing Fiber `0.0.1`.

Open by clearing the Phase 6 section of [`deferred.md`](deferred.md): stale doc
comments, misleading test and symbol names, and inert strings naming deleted
products. Nothing there affects behavior, which is exactly why no gate will ever
catch it — this phase is its only reader.

### Harvest the transition documents, then delete them

Fiber has no product documentation. This phase writes it, and the transition
documents are the raw material — but only for their *rationale*, not their
descriptions.

Generate user-facing description from the built binary's `--help` and `--json`
output. The command specs in `src/builtins/commands.zig` own that text, and a
document that restates it drifts the moment a slice edits a help string.

Harvest instead the decisions and their reasons, which exist nowhere else:
why `--continuation` rather than `--cursor`; why exit 2 for usage errors and
not `sysexits.h`; why fast is a service tier chosen with the model rather than a
standing toggle; why permission rules default to workspace-local scope; why ACP
was deleted; what "operational command" means and why it decides `--json`.

Then delete `contract-inventory.md`, `demolition-inventory.md`,
`identity-inventory.md`, `simplification-inventory.md`, `phase4-audit/`,
`deferred.md`, and this file. A transition document
that survives the transition is a second source of truth competing with the
binary.

`deferred.md` is the one exception to harvesting: it carries no rationale worth
keeping, only work. Every section must be empty before it is deleted. A
non-empty section at this point means a phase closed without doing its work, and
the phase, not the deletion, is what needs revisiting.
[`../enhancements/pending.md`](../enhancements/pending.md) survives: it describes
work that has not happened yet.

Phase exit: documentation describes observed Fiber behavior and the supported platform and release process without inherited fx-era instructions, `deferred.md` is empty in every section, and the transition documents are harvested and removed.
