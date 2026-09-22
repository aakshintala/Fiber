# pi rewrite: agent harness

Delegate report (cursor `grok-4.6-high`, read-only) on pi checkout `1a584a7`, 2026-09-21. Unedited apart from this header; the opening lines are the delegate narrating its own progress. Claims it marks verified were checked against pi's source by the delegate. `../README.md` lists the claims re-checked by hand.

I'll research the AgentHarness design against the listed docs and source, starting by locating those files and reading them in full.Found the docs and harness sources. Next I’ll read the listed design docs and work packages in full.Core docs are in. Next I’ll read `harness.md` in sections and the WP00–WP09 work packages.Next I’ll verify the docs against source and git, and pin down how AgentHarness relates to Pico.AgentHarness is a **durable crash-recovery runtime** for agent conversations. It is largely built in `@earendil-works/pi-agent-core` (`packages/agent/src/harness/runtime/**`). The **shipped coding-agent** still runs the older JSONL v3 tree + in-process `agentLoop`. Pico3 is a parallel experimental kernel. Pico5 is the next design and is **not implemented**. Pico5 is not a drop-in rename of AgentHarness; it is a different kernel meant to replace both AgentHarness’s 13-leaf Drive and Pico3’s task/membrane stack.

Verified in source vs claimed only in docs is called out below. Git history here is from **doc-cited SHAs and CHANGELOG**, plus current files; I did not reconstruct a full `git log` timeline.

---

## 1. One-line status per requested doc

- **`harness.md`** — **PARTIAL.** Normative live spec (`§0.1`, `§0.9`). Core graph is shipped (`runtime/drive.ts` 13-leaf switch, `session/types.ts`). `§0.9` still lists J1, C1, R12, T1, S3, R11, WP08 remainder, precise rewrite, Postgres.
- **`runtime-simplification.md`** — **IMPLEMENTED** (the pass), with a **superseded** leaf list. Status block cites pre-M6 cuts (`eb1185d93` 5358 → `0e77e57d9` 4654 loc). `continueOperation`/`settleOperation` exist in `runtime/lane.ts`. WP05 R3 replaced its 22-leaf list with 13 leaves.
- **`post-wp05-roadmap.md`** — **PLANNED** inventory (own status: “not a behavior contract”; baseline `5507d76ee`). Several findings later moved: WP07/WP09 complete; remaining items still open.
- **WP00** — **IMPLEMENTED.** Status “Complete.” Public factory is `createAgentHarness` from `runtime/harness.ts` (`agent-harness.ts:54`). No `harness/runtime1` tree. Runtime1 deletion list is historical.
- **WP01** — **IMPLEMENTED.** Status “Complete.” `session/values.ts` + SQLite `scalar_values`/`list_values` (`sqlite-node` README + `001_initial.sql`). JSONL compaction in this doc is still J1.
- **WP02** — **IMPLEMENTED.** Status “Complete” at `beac75ecc`. Attachment starts no Drive (`harness.md §4.4`; `runtime/harness.ts` create path).
- **WP03** — **IMPLEMENTED.** Status “Complete.” No `deadline` / `LostOwnership` / `DriveAbandoned` in harness source (grep empty).
- **WP04** — **IMPLEMENTED.** Status “Complete.” Lane-creation API in this handoff is **historical** (WP06 replaced it); event `emitBatch` guarantees remain current (`harness.md §4.3`, invariant 35).
- **WP05** — **IMPLEMENTED** through M10 (own status). `drive.ts` dispatches all 13 `state.at` leaves. Remaining: `watchSession` stub; assistant-output mobile handoff is out of scope.
- **WP06** — **IMPLEMENTED.** Status “implemented before WP05 M4.” Session/Branch/Lane types and one keyless mutation line exist (`session/types.ts`, `session/session.ts`). Raw RemoteSession required by this WP **conflicts** with shipped product (`harness.md §0.9 C1`).
- **WP07** — **IMPLEMENTED.** Status “implemented.” SQLite has **no** writer lease; tests ignore a stale `writer_lease` table (`sqlite-node/test/repo.test.ts`). README: host owns writability.
- **WP08** — **PARTIAL.** Doc: “in progress — Slice C”; `harness.md` Part 8 still says “Slice A.” **Verified:** required `ForkOptions.scope` (`session/types.ts:562`), `fork-policy.ts`, JSONL streaming (`jsonl/fork.ts`), Memory uses the policy. **Verified incomplete:** SQLite still materializes via `createForkSnapshot` with `TODO(WP08)` (`sqlite-node/src/sqlite/repo.ts:104`).
- **WP09** — **IMPLEMENTED.** Status records implemented design. `reducer.ts` `tool_end` marks `settled` and only `entry_added` splices; `lane.ts` snapshot includes `outcome_ready`.
- **`tool-durability.md`** — **IMPLEMENTED** for the lifecycle. `ToolCall` includes `outcome_ready` (`session/types.ts:161`); staging in `runtime/drive/tools.ts`; checkpoints/memos in `progress.ts` / `values.ts`. Dead-byte reclamation of checkpoints is still J1 (doc + `§0.9`).
- **`assistant-durability.md`** — **IMPLEMENTED** for frames/recovery. `pendingAssistantFrames` + `readAssistantFrames` (`progress.ts`); synthetic interrupt in `drive/recovery.ts`. Structural streams still process-local (doc non-goal; no contrary source).
- **`values.md`** — **IMPLEMENTED** for addresses/backends. Constructors match `session/values.ts`. Assistant-frame consumer (deferred past WP01 in this doc) later landed. Snapshot compaction section is still **PLANNED** (J1).
- **`rpc.md`** — **PLANNED / experimental spec** (own status line). Facet `provide`/`use` exists in experimental coding-agent; flow control, gap recovery, version negotiation still “open” in the doc. Not AgentHarness core.
- **`telemetry.md`** — **PARTIAL.** Own status: Context landed; most spans not. **Verified:** `startHarnessSpan("pi.harness.hook")` in `hooks.ts`; schema declares many spans in `telemetry.ts`; production AI/request spans not started (roadmap T1). `watchSession` is the only `SliceNotImplemented` (`runtime/harness.ts:305`).

---

## 2. The AgentHarness model

**Problem:** an agent loop that only appends JSONL messages cannot resume after a crash without replaying tools or losing parallel results. AgentHarness makes **committed state** the restart point.

### Three stores (`harness.md §0.3`, `§1.1`; types in `session/types.ts`, `session/values.ts`)

1. **Entries** — write-once conversation tree (messages, compaction, branch summaries, custom). Never updated. Shared prefixes make branches cheap.
2. **Bound values/lists** — the only mutable store. `value<T>(ns, key)` is latest-wins; `list<T>` is append-only until whole-list delete. Built-ins (`pi.op.state`, `pi.pending.entry`, …) and app addresses share one API. Solves “where does in-flight work live without polluting history.”
3. **Usage ledger** — append-only cost rows. Forks start at zero (`§2.7`).

Invariant 4: every payload is in exactly one of those. Rebuildable indexes (branch, search, stats) have no authority.

### Operations, lanes, branches (`§0.2`, `§2.3`, `§3`)

- **Branch** = named path + movable tip (`pi.branch.tip/{name}`). Data only.
- **AgentLane** = Branch + total config + inbox + at most one open operation.
- **AgentHarness** = manager of lanes, not itself a lane (WP06: the old `Harness extends Lane`/`main`-by-default design mixed ownership).
- **Operation** = one accepted unit (run / compaction / navigation). Immutable `pi.op.meta`; total current `pi.op.state` with **13 leaves** (`starting`, `checkpoint`, assistant ready/pending/retry, `tools`, deferred suspended/pending, summary deciding/ready/pending/retry, `navigation.ready_to_commit`). Control (`running` | `cancel_requested`) is orthogonal.

Queued input is **lane-owned** (WP05 R1): tagged inbox ids, payloads in `pi.pending.entry`. Operations do not own the queue; abort drains steer/follow-up only.

### Intent → settlement (`§0.3` rule 4, `§3.7–3.8`, `runtime-simplification.md` “Durable procedure shape”)

Every external effect is four phases, **verified** as concrete functions not a generic runner:

```text
prepare → publish intent → perform effect → publish one outcome
```

Intent **must** commit before the effect so a crash after the provider/tool call still leaves `effect_pending` — an explicit unknown-outcome marker. Settlement commits result + usage + next state together.

Tools add a second order: effects finish in **completion** order; transcript placement is **source** order. `outcome_ready` stages the finalized result in `pi.pending.entry` so a later crash does not replay a finished sibling (`tool-durability.md` problem statement; `tools.ts` `publishToolOutcome`).

Assistant partials are compact `AssistantMessageFrame` list appends, not full-message snapshots (`assistant-durability.md`; `progress.ts`). Frames never prove completion.

### Recovery (`§4.5–4.7`; `drive.ts`, `drive/recovery.ts`, `drive/reconcile.ts`)

- Attachment restores a small projection and starts **no** work.
- `drive({ operationId })` installs one lane-owned Drive; other callers join. Caller `Context.abortSignal` cancels **observation only**.
- Only `requestAbort` writes `cancel_requested`.
- Close is a **controlled crash**: no synthetic settlement; reopen sees the same `pi.op.state`.
- Orphans: unsafe tools → synthetic interrupt (+ optional checkpoint); `replay: "safe"` → rerun with memos; assistant pending → synthetic error from frames, then retry/fail.

Crash positions are only **between** transactions (`§4.5` table). That is the whole durability bet.

---

## 3. vs shipped coding-agent — what they learned

**Shipped product (verified):** `packages/coding-agent/src/core/session-manager.ts` is JSONL **format 3** (`CURRENT_SESSION_VERSION = 3`): one file, `appendFileSync` of heterogeneous node types (`message`, `model_change`, `thinking_level_change`, `compaction` with `firstKeptEntryId`, `label`, `session_info`, custom). Persistence is event-append, not a total operation machine. The loop is in-process `agentLoop` (`packages/agent/src/agent-loop.ts`) plus `AgentSession`. Extensions get a fat `ExtensionAPI` over that session (`extensions/types.ts`). `/fork` still uses `SessionManager` (WP08 `§1.5`).

**AgentHarness** is consumed by **experimental** workers (`coding-agent/src/experimental/session-worker.ts`, `mini/worker/run.ts` call `AgentHarness.create`). Production CLI is not on it.

**Appendix B** (`harness.md`) is the compatibility story: v3 files open idle; labels/session_info become values; model/thinking/tool-change **nodes disappear** into total `laneConfig`; compaction `firstKeptEntryId` becomes `retainedTail`; ids re-mint to UUIDv7.

**Why the rewrite (docs, not measurements of coding-agent itself):**

| Lesson | Why | Where |
|---|---|---|
| Config must not live as tree nodes | Change nodes made restore a history fold; lanes store total config | `§2.3`, Appendix B |
| Mutable orchestration must die at terminal | Deleting `pi.op.*` must leave a valid conversation | invariant 8, `§1.8` |
| Parallel tools need `outcome_ready` | Crash after B/C finish while A runs replayed completed work | `tool-durability.md` Problem; WP09 original bug |
| Do not persist growing partial messages | Mini session: ~118kB of 477 frame appends, 148kB frame-namespace lines, 51kB superseded `pi.op.state` | `post-wp05-roadmap.md` “Mobile assistant-output” (external mini session; **not** a checked-in fixture) |
| Deadlines are not a crash boundary | Admitted effect can outlive the deadline; unknown-outcome recovery remains required | WP03 Problem |
| Storage must not own process identity | SQLite `writer_lease` duplicated host ownership and was incomplete | WP07 `§2.1`; lease **removed in code** |
| `SessionTree`/`Harness extends Lane` silently meant `main` | Global writes on the wrong queue; lost updates | WP06 `§1.1–1.3` |
| Runtime loc | 5358 → 4654 (13%) then grew to 7410 with public/replication surface; 13-leaf model unchanged | `runtime-simplification.md`; WP05 M10 |

Rejected alternative of **semantic restore audits** (WP00 harvest: discard “semantic restore audit”) — restore trusts typed scalars; consumers dereference named payloads (`§4.4`, invariant 20). **Verified:** restore/drive split in runtime files.

---

## 4. AgentHarness vs Pico / Pico3 / Pico5

**Evidence they are three layers, not aliases:**

| Artifact | What it is | Imports |
|---|---|---|
| AgentHarness | Public default of `pi-agent-core` (`src/index.ts` re-exports `harness/agent-harness.ts` → `runtime/harness.ts`) | Session backends, Chord `Context` |
| Pico3 | Experimental kernel `packages/agent/src/harness/pico3/**`, export `@earendil-works/pi-agent-core/experimental/pico3` | Own `MemoryStorage`/`JsonlStorage`/`Scheduler`/`Membrane`; **no import of `runtime/`** (grep) |
| Pico5 | Spec in `packages/durable/docs/pico-v5.md` | `pi-durable` currently exports **only** `MemoryStorage` + record types (`packages/durable/src/index.ts`). **No** Pico5 Harness class |

**Pico3 (verified code):** conversations + numeric ids + `defineTask` kinds (`generation`, `tool`, `postTools`, `collapse`, `job`, `plugin`) + a real `Scheduler` (`pico3/scheduler.ts`) + Chord documents with a **Membrane** (`pico3/membrane.ts`). Coding-agent `experimental/micro` imports pico3, not AgentHarness.

**Pico5 (docs, mostly unverified in runtime):** “Pico5 is a durable, extensible agent harness. This document is normative.” “Pico5 is not implemented yet” (`pico-v5.md §2.2`). Handoff: “Obsolete `pico` and `pico4` prototypes were removed. `pico3` remains. No Pico5 implementation exists.” Pico3 is “reference material only. Preserve useful behavior, not its capability facades, membranes, document routing…” (`pico-v5-handoff.md`).

**Is Pico5 replacing AgentHarness?**  
**Directionally yes, as the next kernel; it has not replaced it.** AgentHarness remains the factory `AgentHarness.create()` and the experimental session worker. Pico5’s model (conversations, full **task records**, Chord documents, `defineTask` kinds, no 13-leaf Drive) is a descendant of **Pico3**, not a refactor of `runtime/drive.ts`. `packages/durable` already uses Pico5 **record shapes** (numeric `Id`, `EntryRecord`, `TaskRecord`) in `MemoryStorage` — early storage, not a harness.

No source file in AgentHarness runtime imports `@earendil-works/pi-durable`. Durable does not import AgentHarness. They are sibling packages.

---

## 5. Top 10 ideas for a durable Rust agent

1. **Total current state as restart authority** — replace complete `operationState`; never infer from absence (`harness.md §0.3` rule 3, invariant 20).
2. **Intent before effect, one settlement txn** — crash after the syscall is still `effect_pending` (`§0.3` rule 4; `runtime-simplification.md` procedure shape).
3. **Three stores, no fourth place** — entries / values+lists / ledger (`§0.3`, `§1.8`).
4. **`outcome_ready` vs source-order placement** — parallel tools (`tool-durability.md`; `session/types.ts` `ToolCall`).
5. **Auxiliary progress is not completion** — frames and tool checkpoints (`assistant-durability.md`; `tool-durability.md`; `progress.ts`).
6. **Invocation cancel ≠ durable abort** — (`telemetry.md` “Invocation cancellation versus durable cancellation”; `§4.6`; invariant 36).
7. **Close = controlled crash** — no synthetic terminal write (`§4.7`).
8. **Host owns single-writer; storage does not lease** — WP07; SQLite README. Rust: one writer task, not a DB lease.
9. **Bound typed addresses, no global registry** — `values.md`; `session/values.ts`.
10. **Accept is hook-free; drive owns work** — WP02; `§4.4`. Serving layer schedules `drive`; harness does not scan for abandoned sessions (`§0.6` non-goal).

**Also worth stealing:** UUIDv7 / time-cohesive tool-result ids (`§1.2`); `replay: "safe"|"never"` + `step.do` memos (`tool-durability.md` Flue section); compaction as a **self-contained checkpoint** (`retainedTail`, never scan past it) (`§2.1`); instrumented `commit()` spy instead of a production write journal (`§0.6`, Part 9).

### Top 5 tried and reverted/rejected

1. **Drive deadlines / `yielded`** — do not bound admitted work; recovery still required. **Removed.** WP03; invariant 25. **Verified absent** in source.
2. **Installer-owned Drive / `LostOwnership` / ABA fencing** — callers are observation peers; Lane owns the Drive. `runtime-simplification.md` Stage 5; **grep empty**.
3. **SQLite `writer_lease`** — second incomplete ownership system. WP07; **deleted**; tests only ignore leftover tables.
4. **Generic Procedure/scheduler/graph on AgentHarness** — “Do not introduce a generic Procedure interface, runner, scheduler…” (`runtime-simplification.md`). Pico3 **did** build a scheduler + membranes; Pico5 **rejects** membranes/proxy graphs (`pico-v5-handoff.md §6`). AgentHarness kept a **total `switch (state.at)`** (`drive.ts`).
5. **Standalone-compaction “promotion” into a run** — withdrawn: messy restore, unbalanced events (`WP05` status + §5). **No promotion code.** Also: **raw RemoteSession** deleted (`f8a6e670d`) then accidentally re-required by WP06 — unresolved C1. **Per-step `replay: "never"`** deferred (`tool-durability.md` Flue). **JSONL snapshot compaction (J1)** specified for years, **still missing** (no compact/rewrite in `jsonl/`).

---

**Bottom line for a Rust agent:** implement AgentHarness’s **stores + intent/settlement + unknown-outcome table**, not its 13-leaf TypeScript Drive as a forever machine. Treat Pico5’s task-kinds + Chord documents as where pi is heading, but do not wait on it — `packages/durable` is storage sketches. Do not copy Pico3 membranes or coding-agent v3 change-nodes. Do not put leases in SQLite. Do not confuse RPC disconnect with durable cancel.
