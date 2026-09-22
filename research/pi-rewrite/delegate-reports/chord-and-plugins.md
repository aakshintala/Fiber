# pi rewrite: chord and plugins

Delegate report (cursor `grok-4.6-high`, read-only) on pi checkout `1a584a7`, 2026-09-21. Unedited apart from this header; the opening lines are the delegate narrating its own progress. Claims it marks verified were checked against pi's source by the delegate. `../README.md` lists the claims re-checked by hand.

I'll research Chord, the plugin/facet/sandbox design, and the mobile-handoff units from the docs and code, then report what's implemented versus planned.Next I’ll read the delta findings, facet/sandbox specs, the shipped extension system, and Chord’s public API so I can separate code from plans.I'll now inspect Chord's public API and host, the shipped extension docs, sandbox/execenv/rate-limit notes, and git history so claims can be checked against code.I still need the isolation/capability sections, Chord host/reload reality, production file checks, and git history on these paths.Chord is a standalone composition runtime: plugins declare services, facets split those plugins by process, and replicated state plus JSON deltas keep UIs in other processes (or on another device) in sync. Pi is using it to leave the current in-process `ExtensionAPI` behind. Production is further along than the mobile-handoff table implies for the kernel, and further behind for isolation, ToolOutput, and scopes.

---

## 1. What Chord is, and what it solves

**Problem.** One pi feature (model picker, question dialog, slash commands) must run in several places: session worker, TUI, later web/mobile. The shipped extension system loads one TypeScript module into the agent process with full `fs`/`net` and a kitchen-sink `ExtensionAPI`. That cannot split authority, cannot ship UI to another process/device, and cannot reload without sharing one live object.

**Chord** (`@earendil-works/chord` v0.87.0) is an application-neutral kernel. It does not know about sessions, tools, or TUIs. Pi packages depend on it; it depends on none of them (`packages/chord/PLANNING.md` §2).

Five pieces, in the vocabulary they actually use:

| Piece | Role |
| --- | --- |
| **Facet / plugin** | Sync `setup(env)` unit that *declares* provides/requires. Host then validates the graph, activates providers before consumers, disposes reverse. |
| **Service** | Typed token. Singleton or keyed. Process-local (arbitrary JS) or remotely exposable (async methods + replicated state, strict JSON). Consumers hold a stable facade while the provider is replaced. |
| **Replicated state** | One-writer latest-value. Producer `change(ctx, draft => …)` publishes one atomic revision; consumers see immutable JSON. Not a CRDT, not durable history. |
| **Delta** | Standalone op vocabulary (`r/s/d/a/t/p/m`) that compresses those revisions for wire/disk. |
| **Remote adapters** | Transport-neutral `$chord.service` grammar. Framing, sockets, auth stay in the application. |

**Implemented (code).** Matches `PLANNING.md` header: context, JSON types, services, replicated state, facet host/loaders, Node bundler, service wire parsers. Cite:

- Public API: `packages/chord/src/index.ts`, `api.ts`
- Facet host, setup-derived ledger, shape-preserving reload: `src/facets/host.ts` (`reload` at L423 rejects shape change: “must preserve its service requirements and provisions”)
- Loaders: `src/facets/loader.ts`; Node VM compile + SHA-256: `src/node/bundle-loader.ts`
- Bundler (esbuild → content-addressed CJS): `src/node/bundle.ts`, `bundler.ts`
- Services/state/wire: `src/services/{provider,consumer,state,state-codec,wire,loopback,handle,instances}.ts`
- Copy-on-write drafts: `src/state/{draft,diff,value}.ts`
- Delta: `src/delta/index.ts`
- Context: `src/context/index.ts`

**Who imports it today.** Not just docs. `packages/coding-agent/src/experimental/**` builds real facet hosts (`session-worker.ts`, `client-tui.ts`, `services/worker.ts`) behind `PI_EXPERIMENTAL=1`. `packages/server` and `packages/protocol` parse Chord service envelopes. `packages/durable` uses `Context`/`JsonValue` and `applyImmutable`. Experimental plugin exports stay source-only (`coding-agent/test/package-distribution.test.ts`).

**Planned, not in tree.** No `packages/chord/src/rpc/` — symmetric `RpcPeer` is PLANNING WP2. Structural generation replacement (add/remove plugins) is specified (`PLANNING.md` §6.1) and not implemented; `reload()` is shape-preserving only. No `peer` service mode (`ServiceMode = "singleton" | "keyed"` in `src/types.ts`). Trust/sandbox/signing are explicit non-goals (`PLANNING.md` §15). Pi adoption (WP8) is gated experimental.

Git (chord): landed as `34dc9d05` “move facet services into Chord”, then wire (`1a7bc80e`), delta-backed state (`86bac52f`), op-log tracker (`2c995acf`), transactional replicated state (`10d1ad62`), reload-without-gap (`c4b0e35a`). Current tip around v0.87.0.

---

## 2. Document classification (table vs code)

Mobile-handoff `README.md` says three units ship code, four are specs. **Mostly right.** Two important mismatches: Chord already is a production kernel (not listed as a unit), and `facets.md` is a *later* spec that disagrees with the Chord that exists.

| Doc | Class | Evidence |
| --- | --- | --- |
| `packages/chord/README.md` | **IMPLEMENTED** | Matches exports in `src/index.ts`; bundler/node/delta/context subpaths exist. Overclaims slightly: “symmetric RPC peers are planned” is honest; README otherwise describes shipped APIs. |
| `packages/chord/PLANNING.md` | **PARTIAL** | Header is accurate. WP2 RPC, WP6 structural replace, WP8 Pi default path: not done. Layout’s `rpc/` never created. |
| `packages/chord/src/delta/README.md` | **IMPLEMENTED** | Production guide for `src/delta/index.ts`. |
| `packages/durable/docs/chord-delta-findings.md` | **HISTORICAL** | Graph tracker removed; hashes of uncommitted experiments; “keep tree delta + weak caches”. |
| `packages/agent/docs/plugins.md` | **PARTIAL** | Status line: “Design specification.” Experimental coding-agent implements this *shape* (setup-side-effect ledger, lazy `use()`, `own()`, Chord host) under `PI_EXPERIMENTAL`. Not the default product. `DeltaState` deferred section is **stale**: Chord already diffs revisions into ops. |
| `mobile-handoff/README.md` | **HISTORICAL index** | Status table is the intended source of truth; verified below. |
| `01-delta/delta.md` | **IMPLEMENTED** (prod in chord) | Banner points at `packages/chord/src/delta`. Files beside it (`delta.ts`, benches) are prototype evidence. |
| `01-delta/FINDINGS.md` | **HISTORICAL** | Banner: none of it applied to *this* directory. D1 fixed in production flush-time dirty tracking; D2 closed by `append-decision.md`. |
| `01-delta/append-decision.md` | **IMPLEMENTED decision** | Rejects explicit text API. Numbers measured against `packages/chord/src/delta/index.ts` at `1a7bc80e7`. |
| `02-scopes/scopes.md` + `implementation-handoff.md` | **SPEC-ONLY** | No `scopeId` / `retireScope` / `EphemeralScope` in `packages/agent/src`. |
| `03-execenv/execenv.md` | **IMPLEMENTED** | `packages/agent/src/harness/utils/{adaptive-publisher,output-capture}.ts` exist; `OutputCapture` constructs `AdaptivePublisher`; bash/nodejs paths cited. Prototype files beside the doc are historical. |
| `04-tool-output/{harness-tools,rate-limiting,bash-worked-example}.md` | **SPEC-ONLY / PARTIAL** | No `ToolOutput` sink in agent src (only `pendingToolOutput` addresses). Adaptive publisher **is** landed and reused by execenv; generic tool/durable integration is not. `rate-limiting.md` status line matches that split. |
| `05-assistant-output/message-update.md` | **SPEC-ONLY** | Describes removing `message`+`event` from `message_update`. Claims `AssistantMessageFrame` already exists one layer down; harness compact form not landed. |
| `02-plugins/01-facets/facets.md` | **SPEC-ONLY** | Static `uses`/`provides`/`observes`, `construct` after validation, `peer` mode, slots, HTTP/SSE protocol, isolated-vm — **none** of that is Chord or coding-agent production. Chord implements `plugins.md`, which this doc *supersedes*. §16 isolation row still says “SES” while §14 says isolated-vm (stale table). |
| `02-plugins/02-sandbox/README.md` + `src/*` | **PARTIAL (PoC only)** | Real `isolated-vm@6.2.0` membrane in the handoff folder. **Zero** production import: grep finds `isolated-vm` only under that PoC. 412 assertions are claimed in the PoC’s `property-test.ts`; not a workspace package of pi. |

Handoff table vs code: **01-delta, 03-execenv, 02-sandbox PoC** match. **02-scopes, 04, 05, 01-facets** match “not built.” Do not treat `plugins.md` or experimental coding-agent as “facets.md shipped.”

---

## 3. Plugin story: extensions.md vs plugins.md vs facets.md

### Shipped: `packages/coding-agent/docs/extensions.md`

One process, one factory: `export default function (pi: ExtensionAPI)`. Loaded with **jiti** (`src/core/extensions/loader.ts`). Discovers `~/.pi/agent/extensions` and `.pi/extensions`. Can `registerTool`, `registerCommand`, subscribe to lifecycle events, own TUI widgets, `appendEntry`, import `node:fs`. Doc’s own security line: “Extensions run with your full system permissions and can execute arbitrary code.” Hot-reload is `/reload` of that same in-process module. No capability tokens, no isolate, no split between worker and UI.

### Next kernel: `plugins.md` (what Chord + experimental actually do)

A **plugin is not one object**. It is independently bundled **facets** per host (session / TUI / server / web) sharing only JSON contracts and service IDs (`plugins.md` “One feature, several independently loaded facets”). Session facets sit beside the real `AgentHarness` as **trusted local code** with a narrowed API — composition, not a sandbox. Presentation facets never see credentials, tools, or the harness; they `use()` remote services and render replicated state.

**Why leave extensions.** Same document, “Why this shape”:

- Authority stays in the worker (creds, tools, session data); presentations see only deliberate contracts.
- One feature stays coherent (question tool + dialog + renderer) without a shared JS object.
- A new surface (web, mobile) is presentation-only work against existing tokens.
- Built-ins and third-party code use the same facet environment.
- Testable: facet vs loopback vs routed path independently.

Concrete cross-process pattern: the question tool `provideMany(QuestionDialogs)` keyed by invocation id; every connected TUI `observe()`s it. Late joiners hydrate. Answer is durable via `memoOnce`, not live RPC to one client (`plugins.md` question section). That is the “mobile” unit: **state and discovery replicate; code does not**.

Experimental coding-agent already ships presentation bundles from the worker/server (`experimental/plugins/bundled.ts`: session entry locally, presentation artifacts sent as JSON). Gated by `PI_EXPERIMENTAL=1`.

### Later spec: `facets.md` (not implemented; supersedes plugins.md where they disagree)

Biggest deltas (`facets.md` §16):

| | `plugins.md` / Chord today | `facets.md` |
| --- | --- | --- |
| Dependencies | Derived from `setup()` `use`/`provide` | Static `uses`/`provides`/`observes`; validate **before any guest code** |
| Handles | Disconnected lazy proxies during setup | Real objects after graph validation |
| Mode | Inferred from call site | On the token (`singleton` / `keyed` / **`peer`**) |
| Ownership | Explicit `env.own()` | Implicit: every handle is a self-disposing binding |
| Isolation | Trusted in-process | isolated-vm + string membrane for presentation (and maybe session) |
| Presentation load | Host loads local bundles | **Presentation ships with no plugin facets**; server/worker **deliver** CJS over the wire (`facets.md` §7) |
| Replication | `ReplicatedState` + internal delta | One primitive; hydration = base batch `r` |

**Isolation model (PoC, not shipped).** `02-sandbox/src/membrane.ts`: guest sees `{number, string}` only. `encode()` is `JSON.stringify` with a replacer; host functions become integer ids in a host-side table; exactly one `isolated-vm` `Reference` (`__invokeRef`); `derefInto()` only on the guest’s own global. Threat model (`facets.md` §14.1): **malicious server ships a facet into the user’s process**; prevent disk and exfil; availability is out of scope. SES rejected (same-VM object confusion; Figma Realms breach). Workers rejected (full `fs`). QuickJS-WASM rejected on **8–17×** paint cost and missing `Intl.Segmenter`. Ambient `setInterval`/`fs` defeats “registration is ownership” unless endowments are exclusive (`§14.3`). Web DOM cannot be closed without iframes or declarative trees.

**State across process/device.** Not shared memory. Authoritative worker holds JSON; consumers hydrate from a complete snapshot then apply ordered op batches; disconnect clears readiness (`value === undefined`); reconnect is a fresh snapshot. No offline writes, no mutation replay (`plugins.md` “Never blindly replay a mutation after an uncertain disconnect”). Context never crosses the wire; the adapter rebuilds a local `Context` and stamps authenticated identity.

---

## 4. Measurements and findings

### Delta FINDINGS.md (prototype; D1/D2 closed in production)

**D1 — interleaved paths (high).** Adjacent-only coalescing: bash-like `{text, counter}` at 50 KB window, 200-byte chunks, no flush: 1000 writes → **2001 ops / 264 KB**. Same work without interleaving: **1 op / 51 KB**. Held-back writes (rate limit) therefore cost *everything*. Production fix: flush-time dirty tracking, not a retained op log (`delta.md` banner). Trap: first-touch slot order plus parent overwrite after child write: `a={x:1}; a.b=99; a={c:2}` → replica `{c:2,b:99}`. Parent set must invalidate descendant slots. Shallow generators missed it (1190 sequences passed).

**D2 — `overlap()` 94.5% of prototype time (closed).** 20k rolling-window writes: overlap dominated. Fresh V8 `SlicedString` overlap **149 µs** vs reused flattened strings **37 µs**. Earlier bench reported 29 µs by reusing two flattened strings — **never happens in the real loop**. Production uses `after.slice(0, before.length) === before` (`append-decision.md`). Explicit `appendText` API **rejected**: 200 KB assistant append **17.8–18.7 µs/flush**; 50 KB slide **2.43–2.46 µs**; transcript push **~0.75 µs** (Node 26, M5 Max, 3k warmup + 11×10k). At 100 updates/s ≈ **0.18% of one core**. Complexity of a text-specific dirty node was not worth microseconds.

**D3.** Nested path `{content:[{text}]}` **244 µs/write** vs top-level **63 µs** (4×). Unknown if still real; overlap swamped the old profile.

**D4 — not worth it.** Path trie 6×–93× in isolation but slot layer was 0.5% of runtime. Eager `a+a` concat ~5%.

**D5 — measurement traps (each produced a wrong conclusion).** (1) Benchmark through `tsx`: **2.6×** (183 vs 63 µs). (2) Reused flattened string hid cost **4×**. (3) `"x".repeat(n)` hits overlap candidate bound — measures fallback. (4) Cache-hit `Markdown.render()`: 0.065 ms vs real 0.86 ms. (5) Complexity reasoning while a constant dominated. (6) Heap vs retained size: 800×1 MB strings reported 40 MB “growth” that was garbage.

### chord-delta-findings.md (drawing workload, 20k strokes × 100 points ≈ 2.04M objects, ~139.5 MiB raw)

- **Rejected ID-addressed graph tracker.** Layer swap 10k strokes: graph **0.0026 ms / 109 B** vs tree **221 ms / 73 B** — but ready producer heap **430 vs 140 MiB**, snapshot wire **147 vs 66 MB**, snapshot apply **1417 vs 0.027 ms**, pipeline RSS **4.98 vs 0.85 GiB**. Fresh equal-geometry layer: graph **7.4 MB** vs tree **37 B**. Collection 510k nodes **705 ms**. Never exported; hashes are uncommitted source.
- **Tiny patches ≠ cheap.** Layer swap emits **73 bytes** of name sets after walking all geometry. Ten swaps restore original value (empty batch) but op-log paid **209 ms** vs baseline **49 ms** because it diffs on every assignment. Dissimilar 100-stroke swap tripped 4096-metadata threshold → **~66 MB root replace** vs **~2 MB** patches.
- **Weak proxy caches.** Before: retained after full read **3526 MiB**. After: **204 MiB**. Cold traversal **got slower**: 2.4 s → **6.3 s**. Immediately sampled heap still **~2.5 GiB** because `WeakRef` targets stay alive for the job. ~**1.2 KB extra sampled heap per visited container**. Do not treat post-GC retained heap as peak.
- **Spread-first clone.** Dynamic `{}` assignment: 56-byte points vs 48-byte literals → **+15.3 MiB** on 2M points. Spread-first clone: **139.5 MiB / 94 ms** vs **154.7 MiB / 162 ms**.
- **Alias correctness ≠ passing tests.** Tree replica duplicates shared objects; held refs must follow `unshift`. Graph solved identity, failed memory. No design hit all of: low retained+transient memory, cheap reads, cheap huge reassignment, ordinary JS mutation.

### append-decision.md

Closed: no `appendText`. Reopen only if a production profile shows flush is a real fraction of workload.

### Rate limiting (`04-tool-output/rate-limiting.md`) + execenv

**Landed algorithm** (`adaptive-publisher.ts`):  
`nextDelayMs = max(100ms, encodedBytes * 1000 / 100KiB/s)`. First dirty after idle is immediate; held writes collapse to latest state; one trailing timer; completion forces a bounded flush; baseline committed **before** consumer (prevents duplicate delta if apply-then-throw).

Doc trap: treating `intervalMs = 100` as 100 emits/s; it is **10/s**. Size-only or cadence-only fails: 50 KB × 10 Hz = 500 KB/s; byte budget alone allows a storm of tiny events.

**Execenv** (`output-capture.ts`, `execenv.md`): old `stdout += chunk` materialized `cat 1gb.txt` in the worker. Capture now owns a bounded head/tail view, lazy source-local spill (8 MB write HWM, pause on backpressure), adaptive publication. Spill lives where bytes originate so a remote env’s full stream is not pulled over the wire. Bash’s old rolling buffer/throttle gone; 2s durable checkpoint remains until ToolOutput owns cadence.

**Scopes measurement (spec only):** 20 operations × 400 assistant frames × 2 tools × 60 checkpoints of 50 KB → JSONL **93.89 MB**, of which settled history is **0.06 MB**. Encoding-only (not landed in storage) claimed **5.32 MB**. Scopes would move pending state out of the append-only log entirely.

---

## 5. Adopt / avoid for a Rust agent with Lua 5.4

Verified-in-code ideas first; spec-only marked.

### Top 10 ideas worth adopting

1. **Split extensions by runtime, not by one mega-plugin object.** Session/worker vs UI vs server are separate load units sharing tokens and JSON. (`plugins.md` “One feature, several independently loaded facets”; Chord `defineFacet` + `chord.facets` bundling in `packages/chord/README.md` “Bundling and loading facets”.) For Lua: one script per host, not one global table that imports everything.

2. **Services as capability tokens, local vs remote.** Local = unrestricted handles, never in the catalogue. Remote = async + JSON + replicated state only. (`plugins.md` “Local services and narrow remote facades”; Chord `defineService(..., { local: true })` in `src/api.ts`.) Map to Lua userdata that cannot be serialized.

3. **Declare deps, then run.** Chord still uses setup side effects; `facets.md` §3.1 argues that is a lie (`use()` returns an unusable proxy) and that third-party graphs should validate **with zero guest code**. For Lua, a static `uses`/`provides` table is the better half of that debate.

4. **Stable facades across reload; keyed instances get new generations.** Shape-preserving reload keeps singleton identity; keyed spawn is `(id, key, generation)` so stale calls cannot hit the replacement. (`PLANNING.md` §6.1 / §7.5; `host.ts` `reload`.) Lua should not hold raw provider tables.

5. **One-writer replicated state + small op vocabulary, not CRDTs and not “send the whole tool result.”** Six verbs; consumers apply ops, never run provider reducers (`facets.md` §9.2 “Ops never carry provider code”). Chord `src/delta/README.md` “Operation vocabulary.” A Lua applier is a page of code.

6. **String-only membrane.** JSON in/out; host callables are integer ids; no live host object to the guest. (`02-sandbox/src/membrane.ts` header; `facets.md` §14.2.) Lua `lua_pushcfunction` with a bound table of host objects is the isolated-vm `Reference` footgun. Push numbers and strings; keep the host table in Rust.

7. **Registration-is-ownership only if the surface is exclusive.** Endow `timer`/`fs` as host bindings that auto-dispose; do not leave `os.execute` ambient. (`facets.md` §14.3–14.4.) Lua 5.4: strip `io`/`os`/`package`/`debug` unless granted.

8. **Bound state size and publication independently; collapse held writes.** Adaptive token-bucket + cap (`adaptive-publisher.ts`; `rate-limiting.md` §4). Delta compresses a *published* change; it does not cap RAM. Spill at the source (`execenv.md` §5–6).

9. **Reconnect = fresh snapshot; never replay mutations.** (`plugins.md` “Connection loss”; Chord replica `value === undefined` until hydrate.) Idempotency keys (`memoOnce`, `commentId`) for the operations that must survive.

10. **Measure the real boundary, then refuse special APIs.** Production closed D2 without `appendText` (`append-decision.md`). Graph tracker won swaps and lost import/hydration (`chord-delta-findings.md` “Decision and scope”). Profile with the production compiler, varied data, and job-boundary GC.

### Top 5 pitfalls

1. **Handing Lua a userdata that wraps a live host object.** isolated-vm’s `derefInto()` analogue. One leak and the guest walks the world. (`membrane.ts` L8–12; `facets.md` §14.2.)

2. **Retaining one op per mutation while the UI is rate-limited.** D1: 1000 interleaved writes → 2001 ops for a 50 KB window (`FINDINGS.md` D1). Flush from dirty tree vs baseline, or Lua will amplify the hot path you thought you bounded.

3. **Trusting tests and post-GC heap.** Nested parent-overwrite after child write was invisible to 1190 sequences (`FINDINGS.md` D1 trap). Weak caches looked “fixed” at 204 MiB retained while cold traversal allocated gigabytes and slowed 2.6× (`chord-delta-findings.md` “Existing delta: permanent retention fixed”). `tsx` inflated 2.6× (`FINDINGS.md` D5).

4. **Blurring cancellation domains.** Invocation abort ≠ job cancel ≠ durable harness abort; disconnect must not write `cancel_requested` (`plugins.md` “Context, cancellation, and telemetry”). Lua pcall/kill of a callback is not session abort.

5. **Shipping presentation plugins into the user process without a membrane, then calling it a sandbox.** Current extensions.md is that world. `facets.md` §7.1 still flags directory-local TUI bundles as third-party code in the presentation process — **open trust decision**. Native isolate addons also couple Node ABI (`sandbox README` Limitations: no darwin-x64 prebuild; `getHeapStatisticsSync` **aborted the process**). For Lua: a separate Lua state is necessary but not sufficient if you push host pointers.

Doc-claim-only (do not treat as shipped): `peer` services, HTTP/SSE catalogue, isolated-vm in production, ToolOutput sink, scoped storage, structural host replace, symmetric Chord RPC.

---

**Verified-in-code vs docs.** Chord kernel, delta, experimental facet hosts, adaptive shell capture: code. Facets.md plugin author API, sandbox in product, scopes, ToolOutput, assistant `message_update` shrink, peer mode, SES-then-isolate as default: documents and a folder of PoC. When they disagree, the code wins — and the code is `plugins.md`-shaped Chord, not `facets.md`.
