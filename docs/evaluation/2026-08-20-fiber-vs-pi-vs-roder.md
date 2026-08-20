# Fiber versus Pi versus Roder

Evaluation date: 20 August 2026.
Subject: `aakshintala/Fiber`, currently a clean fork of `vercel-labs/fx` at version 0.0.4.
Question: rework this Zig tree, or rewrite it in Rust?

This is a fork-owner memo, not product documentation. It describes the current tree and comparable projects as they exist today.

## Recommendation

Do not rework this Zig fork into a competing product, and do not port it 1:1 into Rust.

Treat this repository as a reference architecture. If Fiber is going to exist as an independent project, start a new Rust codebase that copies a *narrow thesis* from fx, not its source tree. If that thesis is "native harness substrate for products, evals, and RL," build on Roder instead of duplicating it. If the thesis is "a loved, hackable coding CLI," use Pi.

The only Zig rework that is rational is a read-only study fork: pull upstream when useful, do not add features here, do not rebrand aggressively while `vercel-labs/fx` is still moving.

## What this repo actually is

Fiber is not an original agent. At evaluation time the working tree matches upstream fx:

- Language: Zig 0.16, stdlib only, no third-party Zig packages.
- License: Apache-2.0.
- Version: 0.0.4, status experimental.
- History: 446 commits, three primary authors, all from the fx project.
- Local uniqueness: none. The Zig package fingerprint in `build.zig.zon` is still fx's. Changing it while upstream is maintained is the hostile-fork case that file already warns about.

The README pitch is "tiny, open, embeddable, native coding agent" with a Unix-shell form factor rather than an IDE-in-the-terminal. The implementation is a full product, not a small loop:

| Measure | Count |
| --- | --- |
| Zig files under `src/` | 543 |
| Production lines (excluding `test` blocks) | ~410,000 |
| In-source test lines | ~271,000 |
| In-source test blocks | ~8,300 |
| E2E files under `tests/e2e/` | 58 |
| Composition root `src/main.zig` | ~3,900 lines of imports and wiring |
| Largest production file | `src/core/mcp/mcp_runtime.zig` (~13,700 lines) |

Module ownership is real and unusually strict:

- `src/core/` owns contracts, sessions, permissions, MCP, skills, subagents, the agent orchestrator.
- `src/tools/` owns built-in tools.
- `src/ui/` owns terminal rendering and must not own product state.
- `src/gateway/` owns provider transport.
- `src/acp/` owns the Agent Client Protocol server.
- `sdk/` embeds the same runtime as `fx-core.wasm`, `fx-term.wasm`, and a native Node-API addon.

That discipline is the most valuable thing in the tree. The line counts are the most expensive.

## Comparable projects

"Py" in the original request is treated as **Pi** (`earendil-works/pi`). That is the coding-agent project people actually mean in this category. If a different "Py" was intended, this memo's Pi column still holds as the TypeScript baseline.

### Pi

Pi is a TypeScript monorepo: unified LLM API, agent loop, TUI library, and coding-agent CLI, published as packages. Roughly 90,000 GitHub stars. MIT. The cultural winner for "an agent you can take apart."

What Pi optimizes for:

- Layered packages you can embed without taking the CLI.
- A small built-in tool surface and a short system prompt.
- TypeScript extensions, skills, and self-extension.
- Session history as an append-only tree (JSONL, branching).
- Iteration speed and contributor density.

What Pi does not try to be:

- A single-digit-megabyte static native binary.
- A WASM-in-the-browser runtime with host-pluggable fetch and TTY.
- A permission-first OS-adjacent sandbox product.
- A Zig or Rust systems runtime.

Pi is the correct default if Fiber's goal is "a daily-driver coding agent people extend." Competing with it by forking fx is a category error.

### Roder

Roder (`RoderAI/roder`, https://roder.sh) is a Rust-native, extension-first agent harness. Alpha. A handful of stars at evaluation time. MIT. It is the closest *architectural* cousin to fx, and the closest *language* cousin to a Rust rewrite.

What Roder optimizes for:

- A stable core that owns lifecycle, cancellation, event ordering, and permission enforcement.
- Native extensions for inference engines, thread stores, context, memory, sandbox backends, and tools. Extensions depend on `roder-api`, never on `roder-core`.
- Canonical typed events as the substrate for replay, audit, and RL trajectories.
- An embedded app-server control plane. The TUI is a client, not the product.
- Distributions via `roder-configure`, so labs ship a composed binary without forking core.
- Remote runners, subagents, plan review, knowledge, memories, and a wide provider catalog.

What Roder is not yet:

- A mature, widely used product.
- A frozen API. The README says breaking changes are expected.
- A proven WASM/JSPI embed story comparable to fx's `libfx`.
- A Unix-shell UX in the fx sense. It is infrastructure first, reference TUI second.

Roder is the correct default if Fiber's goal is "Rust harness infrastructure we can build products and evals on." Rewriting fx in Rust without first trying to be a Roder distribution would recreate Roder's reason to exist.

### fx / this fork

fx is a Vercel Labs experiment: native Zig, ~6 to 8 MiB ReleaseSafe binary, ACP, WASM SDK, permission-first policy, hosted terminal engine, record/replay, subagents as sessions, MCP, skills. About a thousand GitHub stars, moving quickly, still labeled experimental.

What fx uniquely has among the three:

1. **Host-pluggable native and WASM runtime.** Applications can supply network, session storage, config, permissions, and terminal I/O. Browser JSPI is a first-class target, not a side project.
2. **Size and startup as product constraints.** Linux CI budgets raw wall-clock in milliseconds. Binary-size deltas are measured on every PR. PGSO qualification exists for macOS arm64.
3. **Unix-shell UX, not a TUI IDE.** Alternate-screen owners are enumerated and rare. Transcript stays inline.
4. **Permission-first execution.** Configured denies, saved-session exact rules, auto classification, and opaque approval request IDs that only the real permission screen may satisfy.
5. **Shared bounded terminal engine** plus `FX_RECORD` tapes that replay without a TTY.
6. **Stdlib-only Zig.** No crate graph, no Node runtime in the main binary, no GC.

What fx does *not* uniquely have: an agent loop, read/write/edit/bash, MCP, skills, subagents, sessions, or provider abstraction. Pi and Roder already cover those.

## Decision criteria

| Criterion | Rework this Zig fork | 1:1 Rust port of this tree | New Rust product on Roder or a small original core | Adopt Pi |
| --- | --- | --- | --- | --- |
| Time to a distinct Fiber | Poor. You inherit 410k lines and an upstream that ships weekly. | Worst. You reimplement MCP, TUI, sessions, WASM, and CI. | Best, if the thesis is narrow. | Immediate, if Fiber does not need to exist. |
| Talent and ecosystem | Zig 0.16, pre-1.0 language, tiny hiring pool, Juicy-Main I/O still churning. | Rust ecosystem is the reason to switch. | Same, plus Roder's extension kernel. | TypeScript, largest pool, fastest iteration. |
| Binary size / WASM embed | Best in class today. | Easy to lose. Idiomatic Tokio/reqwest/serde will not stay under 8 MiB without a size program as strict as fx's. | Possible only if size is a stated constraint from day one. | Not a native/WASM story. |
| Differentiation versus upstream fx | None until you diverge, then you pay merge tax forever. | None unless you drop 80% of the product. | Real, if Fiber is a distribution or a different UX. | Already differentiated. |
| Research / RL / replay | Record tapes and session logs exist, but the runtime is a product binary. | You would be rebuilding Roder's event bus. | Roder already models this as the point of the project. | Sessions exist; not an RL substrate. |
| Risk of competing with a lab that out-executes you | High. Vercel is staffed on this exact tree. | High, and slower. | Lower if you refuse to clone the CLI feature-for-feature. | You are a user, not a competitor. |

## Why a Zig rework is a bad bet

1. **There is no Fiber yet.** A rename does not create a product. Every feature you add here is either upstreamed (you did free work for Vercel) or diverged (you own a hostile fork of a 410k-line moving target).
2. **Zig 0.16 is a strategy, not an accident.** fx chose it for a single static binary, WASM, and no dependency graph. Keeping Zig only makes sense if those constraints are *your* strategy too, and you are willing to staff a Zig 0.16 specialist team. That is not a solo-fork staffing model.
3. **The files that will hurt you are already huge.** MCP runtime, transcript runtime, session store, input runtime, subagent manager, terminal store. Reworking them in Zig means living inside someone else's architecture at the scale where files exceed 10,000 lines.
4. **CI is a product.** Full native matrix on four architectures, E2E shards, PGSO, binary-size gates. A fork that does not reproduce that will rot. A fork that does is a second fx team.
5. **`build.zig.zon` already tells you the fork semantics.** If upstream remains maintained, regenerating the fingerprint is how Zig packages detect a hostile identity takeover. That is the wrong relationship to have with a 2026 Vercel Labs experiment.

## Why a 1:1 Rust rewrite is a worse bet

A faithful port copies the wrong thing.

You would reimplement:

- MCP client runtime (~14k production lines)
- transcript and TUI (~130k lines under `src/ui/`)
- session persistence, migration, catalogs
- subagent manager and hosted terminal
- permission classifier and sandbox
- WASM host imports and Node-API
- the four-architecture CI machine

That is a multi-year reconstruction of an experimental product whose owners are still changing it. At the end you would have "fx, in Rust, slightly behind," while Roder already claims the "Rust harness substrate" slot and Pi already owns "hackable CLI agent."

Rust is the right *language* for a long-lived native harness. It is the wrong *plan* to transcribe this tree.

## What is worth stealing from fx

If Fiber proceeds in Rust, copy these contracts, not the files:

1. **Host trait.** Network, filesystem, process, secrets, session store, TTY are supplied by the embedder. Native CLI is one host. WASM is another. Tests are a third.
2. **Permission admission as a gate, not a prompt.** Exact rules, configured denies before session allows, opaque approval IDs, live revalidation.
3. **Unix-shell rendering.** Inline transcript. Alternate screen only for a closed set of owners. Deterministic replay of bytes written to the TTY.
4. **Size budget as a test.** If Fiber is native, pick a number and fail CI when you blow it. Otherwise you will become every other Rust agent binary.
5. **One agent core, many surfaces.** CLI, `ask`, ACP, and embed must share the turn engine. Do not grow a second loop.
6. **Stdlib or a tiny crate allowlist.** fx's "no dependencies" rule is how the binary stays small. A Rust Fiber should name every crate and why.

Do not steal:

- Vercel login and AI Gateway as identity.
- The full MCP implementation as a starting milestone.
- The subagent TUI.
- Auto-upgrade.
- The 8,300 in-source tests as a port checklist.

## Three approaches, with a pick

### A. Study fork only (Zig stays, no product)

Keep Fiber as a local mirror. Read the contracts. Do not ship it. Use Pi day to day. Watch Roder.

Use this if you wanted to understand native harness engineering and have not yet committed to building a product.

### B. Fiber as a Roder distribution (recommended if you want Rust)

Write a small distribution crate: Unix-shell client, fx-like permission policy, host-pluggable I/O, maybe ACP. Let Roder own the turn engine, events, extensions, and replay.

Cost: you accept Roder's alpha API. Benefit: you do not rebuild inference, thread store, sandbox brokers, or provider adapters. This is the path Roder's own `roder-configure` docs describe as the reason not to fork a core.

Use this if Fiber is infrastructure or a branded runtime, not "another coding TUI."

### C. Greenfield Rust core, fx-sized ambition, Pi-sized surface

A new crate with a host trait, a turn loop, four tools, JSONL sessions, and a Unix-shell renderer. Add MCP, subagents, and WASM only when a user-visible need appears.

Cost: you rebuild primitives Roder already has. Benefit: you keep full control and a tiny conceptual surface, closer to Pi's philosophy than fx's current tree.

Use this only if Roder's extension model cannot express the permission/host/WASM thesis after a serious spike, not after a README read.

**Pick: B if Fiber must be native Rust infrastructure. C only after a Roder spike fails. A if Fiber does not need to ship. Never "rework this repo" and never "port `src/` to Rust."**

## What a Roder spike should prove

Before writing Fiber code, spend a bounded exploration on Roder answering only:

1. Can a distribution replace the TUI with an inline Unix-shell renderer?
2. Can permission enforcement sit in core (not an extension) at fx's strictness: configured deny, exact session rules, opaque approval IDs, live revalidation?
3. Can a host supply fetch, session bytes, and process execution the way `libfx` does?
4. Can you emit a replayable event log sufficient for evals without forking `roder-core`?
5. What is the stripped ReleaseSafe binary size of `minimal` versus `full`?

If 1 to 4 are yes, Fiber is a distribution. If 2 or 3 are structurally impossible, then and only then consider C.

## Explicit non-goals for this fork

- Do not rename symbols from fx to Fiber in this tree. That is churn without a product.
- Do not start Zig feature work here that upstream will also do.
- Do not treat passing `zig build test` as evidence that Fiber is a viable independent codebase. It is evidence that you cloned a well-tested project.

## Open assumption

The comparison target "Py" is Pi. If that was a different project, the recommendation still holds against any TypeScript agent toolkit: do not rework this Zig product to beat it, and do not 1:1 rewrite it in Rust to beat it either.
