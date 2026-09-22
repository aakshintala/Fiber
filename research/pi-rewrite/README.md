# pi's rewrite, harvested (2026-09-21)

pi is part-way through replacing its runtime. This note records which of its design documents describe shipped code and which describe plans, what its authors learned, and what bears on Fiber. It was read against pi at commit `1a584a7` (v0.87.0, 2026-09-21), cloned from `earendil-works/pi`. The npm install under `/opt/homebrew` does not contain these documents.

Four read-only delegates each covered one area; their full reports are in `delegate-reports/`. The claims this note relies on were then re-checked by hand, and are listed at the end.

Read pi and reimplement; never copy.

## The short version

The `pi` users run today is none of the new design. v0.87 still runs the old in-memory `Agent` loop over JSONL session format v3.

Three generations sit in the repository at once:

| Generation | What it is | Status |
|---|---|---|
| `Agent` | The original loop, `packages/agent/src/agent.ts` | Shipped. What every user runs. |
| AgentHarness | A durable runtime with a 13-state operation machine, specified in `packages/agent/docs/harness.md` | Built, but used only by experimental code behind `PI_EXPERIMENTAL=1` |
| Pico5 | Conversations, tasks and typed documents, specified in `packages/durable/docs/pico-v5.md` | Normative spec. Package 1 of 24 is built: record types and an in-memory store. |

Pico5 descends from the experimental Pico3 kernel, not from AgentHarness. On 2026-09-17 the Pico author deleted `harness.md` and all the AgentHarness work packages in a commit titled "finalize Pico5 specification set" (`729d5cb7`). They were restored the next day as "non-Pico5 documentation" (`b5ef419d`). The lead appears to see AgentHarness as superseded; the rest of main has not caught up. AgentHarness still gets most of the commits, mostly from other contributors.

The direction is not settled. Harvest invariants and lessons, not interfaces.

## Which document is which

| Status | Documents |
|---|---|
| Describes shipped `pi` | `packages/coding-agent/docs/*`; `tui-plan.md` (landed as opt-in `--tui-mode fullscreen` in 0.84; `regular` is still the default) |
| Built, experimental only | `harness.md` (its §0.9 lists what is missing); `work-packages/` WP00–WP07 and WP09; `tool-durability.md`; `assistant-durability.md`; `values.md`; `packages/chord/README.md`; `chord/src/delta/README.md`; `mobile-handoff/01-harness/03-execenv` |
| Partly built | WP08 (forks); `telemetry.md`; `plugins.md`; `chord/PLANNING.md` |
| Spec only, the intended direction | `packages/durable/docs/pico-v5.md`, `pico-v5-handoff.md`, `pico-v5-chord-usage.md` |
| Spec only, other | `mobile-handoff` units `02-scopes`, `04-tool-output`, `05-assistant-output`, `02-plugins/01-facets/facets.md`; `post-wp05-roadmap.md` |
| Proof of concept, not imported by product code | `mobile-handoff/02-plugins/02-sandbox` (an isolated-vm membrane) |
| Superseded history | `packages/agent/docs/pico/**`, `pico2.md`, `pico-v3.md`, `packages/durable/docs/chord-delta-findings.md`, `mobile-handoff/01-harness/01-delta/FINDINGS.md` |

The `mobile-handoff/README.md` status table is accurate. Its own rule applies throughout: if a document and the code disagree, the code wins.

## Where Fiber already agrees

Fiber reached these independently. They need no action.

- An intent is recorded before a side effect, and an outcome after it. Fiber fsyncs `tool_call_started` and `assistant_message_started` before the effect; pi calls this "intent, effect, settlement" (`harness.md` §0.3 rule 4).
- The log alone tells a reader what was in flight at a crash. Compare `docs/events.md` §Resume with `harness.md` §4.5.
- Closing is a controlled crash: neither writes a synthetic "finished" record on the way out (`harness.md` §4.7).
- Compaction never deletes history. In Pico5 the model's context is computed from the latest summary entry (a "head") plus a list of edits that omit or replace earlier messages (`pico-v5.md` §2). pi v0.86 shipped a `context_edit` entry that does this in the current product.
- A line must not restate earlier content. AgentHarness rewrites the complete operation state after every transition. A measured JSONL session grew to 93.89 MB, of which 0.06 MB was settled history (`mobile-handoff/01-harness/02-scopes/scopes.md`). This is the same failure as the Zig tree's 412 MB turn, found by another team.
- Parallel tool results. pi had to add an `outcome_ready` staging slot (`tool-durability.md`, WP09): tools finish in one order but belong in the transcript in the order the model issued them, and a crash must not re-run the ones that already finished. Fiber does not need this. Each `tool_call_completed` is its own durable line, and the model-order result list is computed from the log.
- One writer per session, owned by the process rather than the database. pi removed a writer lease from its SQLite backend because it duplicated ownership the host already had (WP07).

## Lessons that bear on Fiber

1. **Mid-conversation system messages keep the prompt cache.** pi-ai added a transcript-level `SystemMessage` that patches named prompt sections and adds or removes tools later in the conversation, instead of rewriting the top of the request (PR #9548, landed 2026-09-16; `packages/ai/README.md` §System Messages; `pico-v5.md` §7.3). Models that support it get the message in place. On Anthropic, tool changes go as deferred tool additions, and removed tools stay declared. Other providers get the prompt collapsed back to the top, which costs a cache miss. Relevant to #33.
2. **Extension state needs a declared scope and a declared fork rule.** Pico5 gives every piece of mutable extension state a typed definition that says whether it lives for the session, a conversation or one task. For conversation state, it also says what a fork inherits: the current value, the initial value, or the value at the fork point (`pico-v5.md` §3.1–3.2, §12). `docs/extensions.md` currently keeps extension state in Lua globals, which contradicts ADR 0001. Revisit ticket opened.
3. **A tool can declare that it is safe to re-run after a crash.** pi stores a replay policy with the call before it runs (`"safe" | "never"` in AgentHarness, `"safe" | "unsafe"` in Pico5, where omitted means unsafe). Recovery re-runs only if both the stored and the current declaration say safe; a current unsafe declaration can veto, but a current safe one never upgrades a stored unsafe one (`tool-durability.md`; `pico-v5.md` §7.2). Fiber's rule is "started without completed is never blindly re-run", with no exception. Revisit ticket opened.
4. **History parent is not ownership parent.** A Pico5 conversation records where its history came from (`parent`: a conversation and an entry) separately from who owns it (`owner`: a conversation and a task). A subagent can start with empty history yet still be aborted with its owner (`pico-v5.md` §2, §5.4). Relevant to #21 and #32.
5. **Cancelling a caller is not aborting the work.** A disconnected client or an abandoned wait must never write a durable cancel; only an explicit abort does (`harness.md` §4.6, invariant 36; `telemetry.md`). Relevant to #20 and #34.
6. **Tool output is bounded where it is produced.** pi's shell tool used to accumulate all output in memory, so `cat 1gb.txt` pulled the whole file into the worker. It now keeps a bounded head and tail, spills the rest to a file on the machine that produced it, and pauses the child on backpressure (`execenv.md`, shipped). Updates are published at most every `max(100 ms, encoded bytes / 100 KiB per second)`, with held updates collapsed to the latest (`rate-limiting.md`). Pico5 also bounds every tool result by default at 64 KiB and 200 lines (`pico-v5.md` §7.2). The constants are pi's, not measured for Fiber. Relevant to #14.
7. **Finished background work leaves a receipt.** Pico5 keeps terminal task records so that a dependency or a `waitForTask` still resolves after a reopen; an earlier version pruned them and broke that (`pico/v3/hardening-handoff.md` §11; `pico-v5.md` §5.3). Relevant to #20.

## Things pi built and then removed

- Deadlines on in-flight work (WP03). Work already started outlived the deadline, so crash recovery was needed anyway.
- A writer lease in SQLite (WP07).
- A generic procedure runner and scheduler for AgentHarness (`runtime-simplification.md`). The durable machine is one exhaustive `switch` over 13 states.
- Ambient context through AsyncLocalStorage. It is now forbidden; context is passed explicitly (`pico/v3/hardening-handoff.md` §7).
- A membrane guarding mutable state (Pico3). Pico5 documents the hazard instead, and poisons the session if a commit fails after flush.
- Semantic events in the kernel (Pico3). Pico5 exposes a structural view; any event protocol is an adapter over committed changes.
- A special append API for streamed text. Measured at 18 µs a flush and rejected (`01-delta/append-decision.md`).
- An ID-addressed graph tracker for state changes. About 3× the producer heap and 6× the pipeline RSS of a tree tracker (`chord-delta-findings.md`).

Measurement traps pi recorded (`01-delta/FINDINGS.md` D5): benchmarking through the `tsx` loader inflated results 2.6×; reusing already-flattened strings in a benchmark hid a 4× cost the real loop pays; heap measured after garbage collection is not peak memory.

## Facets: pi's per-host plugin split

pi's shipped extensions are one TypeScript module loaded into the agent process. That module registers tools, draws TUI widgets and reads files, all in one object with full system rights (`coding-agent/docs/extensions.md`).

The rewrite splits pi into several processes: a server, one worker per session, and any number of presentations (the TUI now, web and mobile later). A presentation talks to the server, which routes calls to the right session worker. One loaded object can no longer serve every process, so pi splits each extension into facets.

A facet is the part of an extension built for one kind of process. An extension ships a shared contract file, which holds JSON message shapes and named service tokens. Beside it are separately bundled facets: one for the session worker, one for the TUI, optionally one for web or the server. Each process loads only the facets built for it. The session facet runs next to the real agent and holds the authority: credentials, tool execution, session data. A presentation facet never sees any of that. It can only use services that another facet published across the process boundary, and render state replicated to it (`plugins.md`, "One feature, several independently loaded facets").

pi's own example is a question tool, where the model asks the user a question:

1. The model calls the `question` tool. The session facet handles the call.
2. The session facet publishes one dialog service instance, keyed by the tool call.
3. Every connected TUI or web facet observes that instance and draws its own dialog.
4. The first answer from any client settles it for all of them.
5. The session facet records the answer durably and returns the tool result. Every client's dialog closes.

If no client is connected, the question waits. A client that connects later sees the same pending question.

Chord (`packages/chord`) is the runtime underneath. It gives each process a service graph: facets declare what they provide and use, the host checks the graph, starts providers before consumers, and disposes in reverse. It also provides one-writer replicated JSON state, sent as small diffs over a length-prefixed CBOR wire. It is implemented, and used behind `PI_EXPERIMENTAL=1`.

A later spec, `facets.md`, goes further. It is not built.

- Dependencies are declared statically, so the graph can be validated before any extension code runs.
- A presentation ships with no extension code of its own. The server sends facet bundles to it over the wire.
- Because a malicious server could then run code inside the user's process, presentation facets run in an isolated-vm isolate. The isolate sees only strings and numbers, and host functions appear as integer handles (`02-sandbox/src/membrane.ts`). SES was rejected over same-VM object confusion, and QuickJS-in-WASM over an 8–17× paint cost.

What this means for Fiber:

[#7](https://github.com/aakshintala/fiber/issues/7) already settled two tiers for anything an extension or the loop needs from a person (`docs/architecture.md`, "Asking a human"). Facets line up with the upper tier and have no equivalent of the lower one.

- **Tier 1, portable.** A closed, versioned set of interactions (approval, confirm, select, text input, status) carried as request events. Any connected client answers with `reply` and a `request_id`, including a headless driver. The first answer wins and a stale reply is rejected. pi's question tool has the same lifecycle: one pending request per call, every client shows it, the first answer settles it for all, and a late joiner sees it pending. But in pi each extension defines its own contract and must ship a facet for every client it wants to appear on. In Fiber, an extension that asks through tier 1 appears on every client with no UI code, and an unattended driver can always answer.
- **Tier 2, per medium.** #7 found that "a drawing surface is always a surface *for one medium*": pi's `ctx.ui.custom()` cannot be reached from a React GUI without embedding a terminal. So above the portable tier, code is written per medium. That is exactly what a facet is. Fiber named this tier as a future outside v0.0.1, shaped after #11. It is listed on the map as not yet specified, with this section as its reference.

Both designs start from the same diagnosis. #7 cites pi's docs saying its TUI methods are "no-ops or return defaults" in RPC mode, and facets are pi's fix for that. pi's fix makes every extension write per-client code. Fiber's fix gives extensions a small shared vocabulary that works everywhere, with per-medium code as the escape hatch. The #7 resolution argues that having the escape hatch is what lets tier 1 stay small.

When tier 2 is shaped, pi's design offers:

- A shared contract file plus one bundle per medium, so a web build never contains terminal code.
- Instances keyed per invocation, with late joiners picking up what is pending.
- Authority stays in the session. A client facet sees JSON contracts and copied state, never credentials or tools.
- The trust question. If the server or session ships drawing code to a client, as `facets.md` proposes, a malicious session can run code in the client's process. pi's answer is an isolated-vm isolate that exchanges only strings and numbers (`02-sandbox/src/membrane.ts`). Fiber avoids the question only if a client runs extension code it installed itself.

Separately, the membrane lesson applies to the Lua runtime only if Fiber ever makes Lua a security boundary, which ADR 0006 explicitly does not. If that changes: never hand Lua a userdata wrapping a live host object. Pass strings and numbers, and keep the host's objects in a Rust-side table indexed by integer.

## Claims re-checked by hand

- The shipped CLI builds the old loop: `packages/coding-agent/src/core/sdk.ts:366` calls `new Agent(...)`, and no non-experimental file in `packages/coding-agent/src` references AgentHarness.
- `experimental/micro` imports `@earendil-works/pi-agent-core/experimental/pico3`.
- `packages/durable/src/index.ts` exports `MemoryStorage` and record types only; `pico-v5.md` line 194 says "Pico5 is not implemented yet".
- `729d5cb7` deleted `harness.md` and the work packages; `b5ef419d` restored them.
- `context_edit` and mid-conversation system messages are in the coding-agent and pi-ai changelogs; `--tui-mode` defaults to `regular`.
