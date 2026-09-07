# Brief: session-recovery rebuild + TUI state-transition matrix

New E2E coverage, not repair. The old session-recovery suite was deleted with
`fiber acp`; the TUI matrix never existed. Read this file completely before
editing anything. Read `../plan.md` Phase 5 (the spec) and
`phase5-delegate-brief-example.md` (the working pattern) first.

## Where you are

- Worktree/branch as assigned at delegation time. The binary is built at
  `zig-out/bin/fiber` and `tests/e2e/node_modules` is installed.
- **Do not push.** Commit locally and stop, or leave edits uncommitted as
  instructed — a push to any non-main branch triggers Full CI.
- Scope is the files named below. Everything else is out of scope.

## The one rule that matters

**Never edit `src/` to make a test pass.** New tests that fail against the
current product are findings until classified: either the spec (below) is wrong
about retained behavior, or the transition regressed something real. A case you
cannot classify goes in `FINDINGS.md` with evidence. Do not fix the product.
Do not delete the case.

## Task 1 — rebuild `tests/e2e/session-recovery.test.ts` (16 cases)

Spec is `plan.md` §"Session-recovery harness". Sixteen cases, all driving a
long-lived writer, pausing at a named `session_log.Boundary`, SIGKILLing it:

| # | Group | Boundaries | Proves |
| --- | --- | --- | --- |
| 1–3 | Uncommitted create orphan | `after_event_append`, `after_event_sync`, `after_watermark_rename` (create path) | `sessions --json` count 0; `doctor` reports `authority_less_creation_orphan` |
| 4–6 | Proposed authority on load | `after_authority_marker_rename`, `after_authority_namespace_sync`, `after_authority_intent_remove` | dir exists, list hides it, writable load confirms proposed authority, `session --id` succeeds |
| 7 | Doctor validates watermark | plant `commit.<gen>.json` in a complete session, no crash | `doctor` reports `cleanup_removed=1`, planted file gone |
| 8 | Recover copies, source untouched | corrupt watermark, recover | source bytes unchanged and still `InvalidSessionFormat`; `ask --resume last` reaches the copy |
| 9 | Cross-workspace pointers | 3 sessions / 2 workspaces, recover corrupt in A from B | each workspace's `--resume last` stays on its own newest healthy session |
| 10 | Fenced create orphan | `after_authority_intent_sync` | `doctor` reports `authority_transition_pending report_only=true`; list `skipped_invalid: 1`; writable load fails `Session not found` and drops `authority.pending.json`; then `doctor` reports `authority_less_creation_orphan`, `session --id` "record not found" |
| 11–16 | Model commit, six boundaries | `after_event_append`, `after_event_sync`, `after_commit_intent_sync`, `after_watermark_rename`, `after_target_namespace_sync`, `after_commit_intent_remove` | second load always clears `commit.pending.json`; new model survives only for the last three |

What survives from the deleted suite (do not reinvent it):

- Crash machinery is generic: `FIBER_E2E_SESSION_BOUNDARY` /
  `FIBER_E2E_SESSION_BOUNDARY_READY` are read by `session_test_controls.zig`;
  boundary calls live in `src/core/session/session_log.zig` (create path and
  commit path). Only the ACP wiring died.
- Decided approach, updated for the Codex runtime: drive the resolve with
  `ask --resume-id` against `startFakeCodex` and accept a dummy turn;
  assert on `history_turn_committed` rather than `preferences_changed` — same
  commit protocol, different event. (`plan.md` says "fake gateway"; read that
  as the fake Codex helper in `tests/e2e/tmux-helpers.ts`.)
  Fallback if a case cannot be reached that way:
  `FIBER_E2E_SESSION_EXIT_AFTER_WRITABLE_OPEN`.
- Uniquely end-to-end here: SIGKILL with no unwind, plus the `doctor` and
  `sessions` CLI text. `events.jsonl` mid-turn survival and `checkpoint.json`
  replay are already covered in-process (`session_log.zig`, `session_store.zig`
  unit tests) — do not re-prove them.

New file, so no baseline. New files also need `scripts/pgso/corpus.json`
classification and `tests/e2e/ci-shard-weights.json` — do NOT touch either;
the owner does one registration pass. Do NOT rename anything.

## Task 2 — TUI state-transition matrix (generator, not seven cases)

Decision, from `../enhancements/pending.md` ("Randomized session and transcript
fuzzing"): a generator covers this space better than seven hand-written cases.
The seven scenarios in `plan.md` §"TUI state-transition recovery" are the seed
corpus, not the deliverable:

- resize during model output, tool activity, cancellation
- approval/catalog close after resize
- `Ctrl+L` vs `Ctrl+O` transcript behavior
- transcript clear/reopen/resize round-trip
- cancellation admitting no late output into the next turn
- resume-after-interruption preservation

Seams (all exist): `startFakeCodex` (no network, no cost), the `FXTP`-framed
render tape (`src/ui/event_loop.zig` and friends), `tests/e2e/render-lab/`
(`tape.ts` replay, `analyzer.ts` invariants). `tests/e2e/tui-resize.test.ts` is
the canonical matrix exemplar — extend its shape, do not invent a harness.

A case passes only when the final grid, scrollback, draft, transcript content,
and terminal modes are correct. Process survival alone is not enough.

## Leftovers already decided (do not re-decide)

- `web-search-fake-codex.test.ts:297`, `web-fetch-fake-network.test.ts:538`:
  ACP-transport cases proving retained behavior — convert the driver, keep the
  assertion, delete the `AcpClient` helpers with them (`plan.md` table).
  The web-fetch one rides with that file's local-server port, not alone.
- `tui-command-permissions.test.ts:3635,3671`: same treatment, already steered
  into the running fake-codex delegate.
- `terminal-host.test.ts:3949`: re-pointed at `headless`, done.

## Verifying

```sh
cd tests/e2e
TMUX_TMPDIR=/tmp/fr-$$ bun test --max-concurrency 1 \
  --reporter=junit --reporter-outfile=/tmp/out.xml ./session-recovery.test.ts
```

Traps: short `TMUX_TMPDIR` (104-byte socket cap); bun 1.4 hides passes (read
the JUnit XML); never bare `zig build` (use `-Doptimize=ReleaseSafe` or do not
rebuild); never retry to green; `FINDINGS.md` for anything unclassified.

## Done means

1. New `session-recovery.test.ts` green except written-up FINDINGS.
2. Generator (or documented first slice of one) running the seed corpus green.
3. Matcher discipline: exact matchers on the new contract, no `toContain`
   where `toBe` is knowable.
4. `FINDINGS.md` + a plain unfinished list. Report what you did not finish as
   plainly as what you did.
