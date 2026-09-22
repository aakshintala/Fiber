# pi rewrite: pico lineage

Delegate report (cursor `grok-4.6-high`, read-only) on pi checkout `1a584a7`, 2026-09-21. Unedited apart from this header; the opening lines are the delegate narrating its own progress. Claims it marks verified were checked against pi's source by the delegate. `../README.md` lists the claims re-checked by hand.

I'll start from the Pico docs and git history, then map that against the durable/harness code so the version story and current implementation are grounded in both.Next I’ll read the Pico docs, durable package, and git history so the version map and “what actually shipped” claims rest on both.I have Pico5’s spec and current durable package. Next I’ll read the older Pico docs, pico3 code, and git history to reconstruct the version timeline.I’ll pull git history plus the remaining Pico docs so version dates, deletions, and design reversals are evidence-backed.I have enough to distinguish shipped code from spec claims. The report below maps the Pico lineage, then Pico5’s current implementation gap.

---

**Pico is the intended next harness.** AgentHarness remains the production runtime. Pico3 is a working experimental sibling. Pico5 is the normative successor, with only package 1 of 24 implemented.

## 1. Version timeline and document status

There is no shipped “pico v4” spec. `pico4` appears only as a deleted prototype (`packages/durable/docs/pico-v5-handoff.md` Status). Dates below are Mario Zechner commits, 2026-09-07..21.

| Version | Dates | What it was | Code that shipped | What was deleted |
|---|---|---|---|---|
| **pico2 / “v1 tree”** | 2026-09-07 (`73f3257d`), expanded 09-09 | Design only. `pico.md` had modelled a session as one resident node tree; paging and “folds” failed; `pico2.md` replaced both with transcript + stored context list + tasks + values/lists | none | original `pico.md` / tree drafts (survive only as history in `pico2.md` §History) |
| **pico v3 design** | 2026-09-09 (`e045ed2f`) | Conversations / immutable entries / durable tasks / scoped state. Context **derived** from heads+edits, not a stored list | none | — |
| **Pico v1 “simple”** | 2026-09-11–13 (`4819cc87`, `f467cf70`, `df484f27`, `51f30907`) | Clean-room impl spec for `packages/agent/src/harness/pico/`. `pending→running→terminal`, execute/recover closures, values/lists | compile-time types + MemoryStorage under `src/harness/pico/` | **deleted 2026-09-15** (`56cd5989`): all of `src/harness/pico/` and its tests (~4k lines) |
| **Pico v2 kernel** | 2026-09-13 (`99a3948c`, `a9930d28`) | Full kernel contract except ordinary tool API. Size target 3–4k production lines. Used AsyncLocalStorage for nested-line detection | same `pico/` tree, aligned to v2 | deleted with v1 code (`56cd5989`) |
| **Pico3** | docs 09-13 (`fd3b009d`, `09b03160`, `9b2aff2c`); kernel 09-14 (`46b66c59`) | Hardened spike: phase-map tasks, Chord rewindable/sticky/session docs, revocable membrane, rendering-shaped view + semantic events, namespace router | **still present**: `packages/agent/src/harness/pico3/` (~8k+ src), tests, export `@earendil-works/pi-agent-core/experimental/pico3` | not deleted. Handoff: “pico3 remains” |
| **Pico5** | spec 09-15..19 (`56cd5989` … `e80cf140`); package 09-18 (`cf8d5fac`, `08016016`) | Durable Session + typed Chord documents; no membrane, no semantic kernel events, no namespace router | `@earendil-works/pi-durable`: record types + `MemoryStorage` tables only | 09-17 `729d5cb7` deleted non-Pico5 docs (including `harness.md`); **09-18 `b5ef419d` restored them** |

**Doc classification** (status line in the file, plus git):

| File | Class | Evidence |
|---|---|---|
| `packages/durable/docs/pico-v5.md` | **NORMATIVE-CURRENT** | “This document is normative.” Spec §2.2: “Pico5 is not implemented yet.” |
| `packages/durable/docs/pico-v5-handoff.md` | **NORMATIVE-CURRENT** (implementation sequence) | “`pico-v5.md` is normative. Implement this list in order.” Status: “No Pico5 implementation exists” (stale vs package 1; see §2). |
| `packages/durable/docs/pico-v5-chord-usage.md` | **USAGE-GUIDE** | “This guide uses the contracts in the Pico5 specification.” Names have “no specified import path or runnable Pico5 package.” |
| `packages/durable/README.md` | **USAGE-GUIDE** | Points at the three Pico5 docs; public API is `MemoryStorage` + `ROOT_CONVERSATION_ID`. |
| `packages/durable/docs/chord-delta-findings.md` | **HISTORICAL** | Chord tracker experiment; “does not … adopt graph semantics in the Pico specifications.” |
| `packages/agent/docs/pico/pico-simple-handoff.md` | **HISTORICAL/SUPERSEDED** | Header still says “sole normative … `src/harness/pico/`” — that tree is gone. |
| `packages/agent/docs/pico/pico-simple-blockers.md`, `pico-work.md` | **HISTORICAL** | Point at simple-handoff / pico-v3 as then-current. |
| `packages/agent/docs/pico/pico-handoff-v2.md`, `pico-usage-v2.md` | **HISTORICAL** | v2 kernel + usage; Appendix B records v1→v2 deltas. |
| `packages/agent/docs/pico2.md`, `pico-v3.md`, `pico/pico-v3.md` | **HISTORICAL** | Explicit “design under review / not package exports.” |
| `packages/agent/docs/pico/pico-usage-guide.md`, `pico-rendering.md` | **USAGE-GUIDE, superseded** | Describe v3 surface; rendering still useful as a rejected Pico5 approach. |
| `packages/agent/docs/pico/v3/*.md` | **HISTORICAL for Pico5; still describes Pico3 code** | Canonical for the kernel that actually exists. |
| `packages/agent/docs/harness.md` | **NORMATIVE-CURRENT for AgentHarness**, not Pico | Separate product. Restored by `b5ef419d`. |

`pico-simple` **is** Pico v1. `pico-work.md` is the v3 clean-room plan that fed simple-handoff; it is not a separate shipped runtime.

## 2. Pico5 in plain terms

**Core rule** (`pico-v5.md` opening, §1):

> A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.

One writer, one mutation line. External effects never run inside the commit. After document flush, checkpoint or storage failure **poisons** the open Session: publish nothing, close/reopen. Listener callbacks run off the line.

**Data model**

- **Session**: one storage + one in-process kernel. Owns conversations, entries, tasks, inputs, documents.
- **Conversation**: transcript scope. `parent` = inherited history (fork at entry `E`). `owner` = `{conversationId, taskId}` for abort/idle (not history). Root ID is always `1`.
- **Entry**: append-only transcript record. `model` for the provider, `data` for apps, `head` to cut context, `edits` to omit/replace earlier messages. Storage never deletes old entries. Compaction appends a headed summary.
- **Task**: durable state machine on one conversation: `pending | running | terminal`, full checkpoint replacement, `after[]` dependencies, `background`, `abortRequested`. Terminal outcomes: completed / failed / aborted / orphaned / faulted. Memos are first-writer-wins JSON on the live envelope; they vanish at terminal.
- **Input**: host send/write handle: queued → placed → done | unanswered. Inbox is a **conversation document**, not a table of events.
- **Document**: mutable JSON as Chord ops + occasional complete bases. Scopes: session (current-only), conversation (`latest` or `rewindable`, fork `current|initial|asOf`), task (dies with the task, never forked). Incarnation IDs never reuse.

**Plugins / extensions vs state** (`pico-v5.md` §3, §7)

There is no plugin object and no document-definition registry. A host passes `defineDoc` / `defineTask` / tool / section **tokens** into typed access. Chord facets are process-local: they acquire a `DocumentSource`, wrap it as `ReplicatedState`, and mutate through `session.commit`. Reload of Session-side code is close → dispose → open new Harness over the same storage (`§7.4`). Registries may move declarations while running; they must not hot-swap executing callbacks.

**Rendering / views / events** (`§9`)

- `watchDoc`: incarnation-bound. Capture immutable `value`, then `start(listener)`. Serialized async callbacks. Slow watches compact the pending suffix to `[["r", latestValue]]` by **operation count**, not `JSON.stringify` size. Convergent state, not an audit log.
- `Conversation.watch()`: structural `{ conversation, entries, docs }` — raw active transcript plus mounted built-in documents. **No semantic events in the kernel.**
- Agent-mode JSON/RPC notifications are a thin adapter over **uncoalesced** commits (`§9.4`). TUI hydrates the structural view; print awaits `InputHandle`; late joiners do not replay events.

**Durability / crash recovery** (`§4–5, §8, §10–11`)

Intent sandwich: commit intent → effect outside the line → commit outcome. Reopen: `running` → `pending`, migrate or orphan. Tools replay only if stored policy **and** current declaration are `safe`. JSONL: sidecars first, `main.jsonl` marker last; unconfirmed tails discarded. Default JSONL is process-crash consistent, not power-fail durable. SQLite: one SQL txn = one Session commit.

**Implemented today — verified in code, not just docs**

`packages/durable/src` is three files:

| Exists | Does not exist |
|---|---|
| `Id`, `Seq`, `ROOT_CONVERSATION_ID` | `Session`, `Tx`, `Harness`, `Conversation` objects |
| `ConversationRecord`, `EntryRecord`, `EntryDraft`, `ContextEdit` | `defineDoc`, `defineDocFamily`, `defineTask`, `defineEntry` |
| `Input` (queued/placed/done/unanswered) | document `StorageWrite`s (`document.create/change/retire`) |
| `TaskRecord` / `TaskState` / `TaskOutcome` | `findDocument`, `document()`, `scanDocuments` |
| `DocumentRecord`, `DocumentCreate` **as types only** | tracker, membrane, watches, Chord adapter |
| `Storage` + `MemoryStorage`: `commit`, `mintId`, conversation/entry/task/input lookups and scans, `findLatestHeadMarker`, fork-aware newest-first `scanEntries`, detached clones, immutable conversation/entry IDs | SQLite, JSONL, scheduler, generation/tool/collapse, hooks, sections, view mount |
| tests: `test/memory-storage.test.ts`, `test/types.test.ts` | handoff packages 2–24 |

`StorageWrite` in code is only `conversation | entry | task | input` (`types.ts` ~291–296). Spec `Storage` (`pico-v5.md` §10) also has document APIs. Handoff package 1 (tables) matches the code; package 2 (memory documents) has not started. `CHANGELOG.md` `[0.86.0]`: “initial Pico durable record contracts and detached in-memory storage.”

Pico3 **is** a full kernel (session, scheduler, kinds, membrane, jsonl, view) but it is not Pico5.

## 3. What changed, and why (reversals)

Each item is an author-recorded reversal, not inference.

1. **Resident tree → transcript** (`pico2.md` History). Tree paging and folds failed. Keep driver/kinds/scratch/line; replace the tree with entries + tasks + versioned values.

2. **Stored context list → derived heads/edits** (`pico/pico-v3.md` §2, usage-guide mental model). Compaction/fork/reset must not rewrite history. Newest `head` plus `edits`; model context is a reducer, not stored state.

3. **`execute`/`recover` closures → exhaustive phase maps** (pico3 accepted direction #4; Pico5 §5.1). One `initial` + phase handlers; scheduler faults if a handler makes no durable progress. Avoid a second handwritten recovery program.

4. **Values/lists addresses → Chord documents** (pico3 `types.ts` header; Pico5 §3). Then Pico5 drops Pico3’s fixed `rewindable()`/`sticky()` accessors and namespace router (`pico-v5.md` §2.2). Scope lives on the definition token. Reason: routing and capability façades leaked into the kernel; conflicting tokens claiming one kind are caller misuse, not a registry problem (`§3.1`, `§12`).

5. **ID = journal seq → separate `Id` and `Seq`** (pico3 accepted #9; Pico5 §2, §10). Seq holes on failed callbacks; state-only writes need a sequence without minting identity.

6. **AsyncLocalStorage for nested-line detection → forbidden** (`pico-handoff-v2.md` ~2166 vs `pico/v3/hardening-handoff.md` §7, commit `9b2aff2c`). Use Chord `Context` key `LINE_KEY`. Reason: ALS is Node/`async_hooks`, hides ambient identity, misses outer-ctx self-waits anyway. Same rule in `harness.md` §0.2 for AgentHarness.

7. **Revocable membrane required → documented, not enforced** (pico3 `membrane.ts` + hardening “Proxy lifetime”; Pico5 invariant 6 and non-goals). Post-flush failure poisons the Session, so defensive clone/membrane is not v1 (`pico-v5-handoff.md` §6: “Do not add membranes”).

8. **Rendering-shaped view + named events as kernel protocol → structural view + optional product adapter** (`pico/v3/view-and-events.md` §1–2 vs Pico5 §9.3–9.4, non-goals). Pico3: “ops are the truth, events are annotations,” turn/tool slots projected by `describe()`. Pico5: kernel has no semantic journal; Codex-style split `item/completed` vs `turn/completed` is exactly what they refuse. TUI hydrates structure; RPC may derive notifications from uncoalesced commits, never from a compacted watch.

9. **Synchronous watch listeners + overflow-close → async serialized watches with reset compaction** (view-and-events §3 vs Pico5 §9.2). Slow UIs must not fail the writer or unbounded-queue the kernel.

10. **Quiescent in-process extension reload → close/reopen generation boundary** (pico3 plugins §5 vs Pico5 §7.4). Non-cooperative JS cannot be forcibly taken over in-process.

11. **Visible-undurable streaming → none** (Pico5 §1.3, §8, non-goals). Clients see committed throttled progress only. Crash loses the current throttle window.

12. **Terminal pruning → retain terminal receipts** (pico3 hardening §11; Pico5 §5.3). Dependencies and `waitForTask` must survive reopen.

13. **Automatic checkpoint heuristic / SQL translation of Chord ops / CRDT merge / JSONL global compaction** — all non-goals (`pico-v5.md` §13). Definition owns `checkpointWhen`; storage does not invent bases (`§3.5`).

14. **Standalone ID-addressed graph tracker** — measured and removed (`chord-delta-findings.md`). Heap/import cost on a 2M-point drawing was unacceptable; keep tree/path deltas.

15. **Compatibility layer for removed Pico prototypes** — explicit non-goal. `56cd5989` deleted `src/harness/pico/`; Pico5 does not migrate it.

## 4. Pico5 vs AgentHarness

**Sibling rewrite, intended long-term replacement of Pico3 (and conceptually of AgentHarness). Not a layer on top.**

Evidence:

- Production export is AgentHarness (`packages/agent/src/index.ts` exports `./harness/agent-harness.ts`). Pico3 is a **separate** export `./experimental/pico3` (`package.json`). `pico3/index.ts`: “intentionally separate from the package root while the kernel … [is] validated.”
- `harness.md` is the AgentHarness spec: entry **tree**, Branches/AgentLanes, **operations** (`accept`/`drive`), bound values/lists, usage ledger. Pico has conversations, entries, tasks, documents — no lanes, no operations, no drive.
- `post-wp05-roadmap.md` inventories AgentHarness remaining work and never mentions Pico.
- Pico5 `§2.2`: “retains the useful Pico3 host shape” (`open/resume/suspend`, `send`/`write`, watches) — Pico3, not AgentHarness.
- Handoff: “Pico3 is reference material only. Preserve useful behavior, not its capability facades…”
- Shared ideas (one mutation line, explicit `Context`, no ALS, intent→effect→settle, JSONL marker protocol) crossed both tracks; the runtimes do not call each other. `packages/durable` does not import AgentHarness.

Today you have **two harnesses plus a spec**: AgentHarness (product), Pico3 (experimental kernel), Pico5 (normative design + table storage).

## 5. Adopt for a durable Rust agent / pitfalls

**Top 10 ideas** (cite spec §; Pico5 unless noted):

1. **Only committed state is observable** (`pico-v5.md` core rule, §1.3). No shadow live channel. Rust: publish after `fsync`/txn commit, never from a working buffer.
2. **Intent sandwich for every external effect** (`§5.2`, AgentHarness `harness.md` §0.4–0.5). Reopen in intent = “maybe happened.” Persist replay policy **before** the call (`§7.2`).
3. **Full checkpoint replacement, not patches** (`§5.1`). Phase map + “no progress ⇒ faulted.” Avoid a second recover() program.
4. **Separate identity (`Id`) from commit order (`Seq`)** (`§2`, §10). Don’t reuse committed IDs; uncommitted mints may reuse after reopen.
5. **History parent ≠ ownership parent** (`§2` ConversationRecord). Fork ancestry for transcript; owner tree for abort/idle. Subagents can start empty.
6. **Context is derived, history is append-only** (`§2.1`, §8). Heads and edits; compaction does not delete. View reducer ≠ model reducer.
7. **Documents as typed, scoped CRDT-log JSON** (`§3`). Session / conversation / task lifetimes; `asOf|current|initial` fork policies as **product semantics**, not storage optimizations (`§12`).
8. **Watches observe convergent state** (`§9.2`). Bound the pending op list; compact to a root replacement. Persist anything you must audit as an entry.
9. **JSONL publication: sidecars then marker** (`§11.3`). Marker is the commit. Torn tails and unconfirmed sidecars rollback. Poison on uncertain append.
10. **Explicit Context, no thread-locals** (pico3 hardening §7; `harness.md` §0.2). Cancellation of a wait ≠ abort of shared work (`§5.4`). Extension reload = new process generation (`§7.4`).

**Top 5 pitfalls they discovered:**

1. **Draft/proxy escape.** Pico3 built a membrane (`membrane.ts`); Pico5 documents it as a footgun instead (`§12`). Mutating a retained draft contaminates a later commit. In Rust, don’t hand out `&mut` document state across await points.
2. **Read-after-write on tables** (`§4`, pico3 hardening §5). Scans after the first table write lie or deadlock overlays. Read first, then write; documents keep read-your-writes via the tracker.
3. **Holding the line across effects** (`§12` Long transactions). Awaiting models/tools/humans inside `commit` stalls the whole Session. Same class of bug as AgentHarness drive deadlines.
4. **Events as a second source of truth** (`pico/v3/view-and-events.md` vs Pico5 §9.4). Split completion messages (Codex) and lossy compacted watches both fail late joiners. Hydrate structure; don’t replay a semantic journal you didn’t persist.
5. **Exactly-once is a lie** (pico3 plugins §1; Pico5 §5.2). Memos are coordination, not idempotency. Persist the external key **before** the effect. JSONL without fsync does not survive power loss (`§11.3`, `§12`). Checkpoint starvation (`checkpointWhen` never true) grows replay without bound (`§3.5`).

**Precision note:** Pico3 is the only complete Pico kernel in tree; treat it as a reference implementation of a **rejected** façade (membrane, namespaces, semantic view), not of Pico5. Pico5’s type file is ahead of storage (DocumentRecord exists; document writes do not). Pico4’s design is not recoverable from this checkout.
