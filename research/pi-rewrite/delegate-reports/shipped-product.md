# pi rewrite: shipped product

Delegate report (cursor `grok-4.6-high`, read-only) on pi checkout `1a584a7`, 2026-09-21. Unedited apart from this header; the opening lines are the delegate narrating its own progress. Claims it marks verified were checked against pi's source by the delegate. `../README.md` lists the claims re-checked by hand.

I'll research the shipped product and the client/server split from the docs and source you listed, then answer the six questions with file and commit evidence.The user-facing docs describe a JSONL TUI CLI. Next I’ll trace the binary entrypoint and read the protocol/session/experimental packages.The experimental paths look gated; I’ll now trace the shipped CLI into `Agent` vs `AgentHarness` and pull changelog/git evidence.## 1. What ships today (0.87)

The user-facing product is **`@earendil-works/pi-coding-agent` 0.87.0**. The `pi` binary is that package’s CLI:

- npm: `"bin": { "pi": "dist/bundle/cli.js" }` in `packages/coding-agent/package.json`
- source entry: `packages/coding-agent/src/cli.ts` → `main()` in `packages/coding-agent/src/main.ts`
- standalone Bun binary: `packages/coding-agent/src/bun/cli.ts` re-exports the same `cli.ts`

`pi-test.sh` is **not** that path. It runs `packages/coding-agent/src/experimental/cli.ts` so checkout developers can hit `server`/`client`.

**Runtime: the old `Agent` / `runAgentLoop`, not `AgentHarness`.** Verified by import trace:

1. `main.ts` builds sessions with `createAgentSessionRuntime` / `createAgentSessionFromServices`.
2. `packages/coding-agent/src/core/sdk.ts` constructs `new Agent({…})` (around line 366) from `@earendil-works/pi-agent-core`.
3. `packages/coding-agent/src/core/agent-session.ts` types its core as `Agent` and drives interactive / print / RPC through that class.
4. `packages/agent/src/agent.ts` implements `Agent.prompt()` via `runAgentLoop` / `runAgentLoopContinue` from `packages/agent/src/agent-loop.ts` (around lines 434 and 447).

`AgentHarness` is also exported from `packages/agent/src/index.ts`, but **no shipped coding-agent mode imports it**. Harness construction lives only under `packages/coding-agent/src/experimental/` (e.g. `session-worker.ts`, `mini/worker/run.ts`).

What users get is a local Node/Bun TUI coding harness: JSONL sessions under `~/.pi/agent/sessions/`, four default tools (`read`/`write`/`edit`/`bash`), extensions/skills/packages, and four I/O modes (interactive, `-p`, `--mode json`, `--mode rpc` over stdin/stdout JSONL). That is documented in `packages/coding-agent/README.md` and matches the code above.

The 0.87 changelog made `SessionManager` the canonical history for `AgentSession` (`packages/coding-agent/CHANGELOG.md`; release `16787ad5`, 2026-09-21). That is a tightening of the **old** loop, not a switch to the harness.

---

## 2. Experimental mini / micro / services

None of these are on the published `pi` binary. `package.json` `"files"` excludes `dist/experimental` and `dist/cli/experimental`. `0.85.1` (`d981de12`, 2026-09-05) and `1382777e` made that explicit after 0.85.0 accidentally published them (`#9132`).

**Gate:** `PI_EXPERIMENTAL === "1"` in `packages/coding-agent/src/core/experimental.ts`. `runExperimentalCommand()` in `packages/coding-agent/src/experimental/commands.ts` only intercepts argv `server` or `client`.

### mini (`353c990f`, 2026-08-26)

A three-process prototype **on `AgentHarness` + `JsonlSessionRepo`**, with its **own** newline-JSON RPC (not `pi-protocol`). Topology: TUI ↔ unix socket `~/.pi/agent/experimental/mini.sock` ↔ server ↔ per-session worker stdio. Reach it only from source:

```text
tsx packages/coding-agent/src/experimental/mini/main.ts [--continue]
```

`--continue` attaches to the newest cwd session. Two TUIs can share one worker. No slash-command/extension stack. Documented shortcuts: N² event fan-out; login abort is incomplete.

### micro (`7e195076`, 2026-09-17)

One process. **Not** AgentHarness and **not** protocol/server. It uses Pico3 (`@earendil-works/pi-agent-core/experimental/pico3`: `Harness`, `JsonlStorage`) with a presentation-shaped `MicroView`/`MicroController`. Sessions: `~/.pi/agent/experimental/micro-sessions/<cwd-hash>/`. Same tsx invocation; `--continue` only.

### services / `pi client` / `pi server`

This is the Chord-faceted split in `packages/coding-agent/src/experimental/services/README.md`. **Verified in code:** `experimental/server.ts` uses `createUnixServer` + `JsonlSessionRepo` + `AgentHarness` via `session-worker.ts`; `experimental/client.ts` / `client-tui.ts` talk Chord services (`AgentController`, `Transcript`, `Models`, …) over `pi-protocol`.

How users (developers) reach it, from `packages/coding-agent/docs/development.md`:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server
PI_EXPERIMENTAL=1 ./pi-test.sh client
# also: pi client -c / -r, --connect unix:///… or radius://<serverId>
```

`--connect` parsers in `cli/experimental/command-options.ts` accept only `unix:` and `radius:`. Radius relay (`experimental/radius-relay.ts`, landed `1d0d110a` 2026-08-28) is a WebSocket byte pipe to `radius.pi.dev`, not a first-class protocol transport.

Doc claim vs code: the services README describes authenticated per-client projection as **not landed**. Code matches: protocol README says peer auth is unimplemented.

---

## 3. protocol / server / client / sqlite-node

These are workspace packages at 0.87.0. They are **devDependencies of coding-agent**, not runtime deps of published `pi` (`development.md`; `1382777e`). Root `README.md` does not list them among user packages.

**Wire protocol (`packages/protocol`, first commit `56eb685b` 2026-07-30):** version **8** (`PROTOCOL_VERSION` in `packages/protocol/src/protocol.ts`; test asserts `8`). Frames: 4-byte big-endian length + definite CBOR. Handshake identifies logical `serverId`. Routes: server `{serverId}` vs Session `{serverId, sessionId, attachmentId}`. Payloads are opaque strict JSON; **Chord** owns `{serviceId, instance?, member, args}`, catalogues, and Delta codecs. Experimental, no compatibility promise; unknown properties rejected.

**Transports:** byte-stream only. Implemented: Unix domain sockets (`pi-server/unix`, `pi-client/unix`, discovery under a runtime dir). Client README mentions WebSocket as a factory the app can supply; **no WebSocket listener ships in `pi-server`**. Coding-agent adds Radius WebSocket relay in experimental code. Auth is “application policy,” not in the transport.

**What it enables:** multiple presentations on one durable Session worker; local TUI detached from agent state; a path to remote/mobile clients via Radius without putting `Session`/`AgentHarness` on the wire. Protocol README (verified by server README): “The real `Session` and `AgentHarness` remain process-local.”

**Status:** local unix server + client work in-tree. Chord moved onto the wire around `1a7bc80e` / `ae2cc511` (2026-08-31–09-01). `watchSession` is still `SliceNotImplemented` (harness spec §0.9). Format 4 is still WIP. Experimental coordinator/lifecycle is outside the public protocol.

**sqlite-node** (`@earendil-works/pi-session-backend-sqlite-node`, renamed `a80008b9` 2026-08-05): Node `node:sqlite` backend for harness sessions. One file per Session (or shared container). Host owns single-writer; **no** cross-process lease. Experimental coding-agent server still uses **JSONL** `JsonlSessionRepo`, not SQLite.

---

## 4. `tui-plan.md`

Plan (`tui-plan.md`, authored with the landing commit): constrained layout for **alternate-screen** only (`TuiMainScreen` keeps terminal scrollback). Public primitives `VStack` / `HStack` / `ScrollView`; sticky bottom dock (pending/status/editor/footer); transcript independently scrollable; layout tree rebuilt per frame.

**Landed.** First implementation: `ea1e77e2` (2026-07-31) “feat(tui): add alternate-screen viewport layouts”; filename normalize `583f153d` (2026-08-01). Present in `packages/tui/src/components/{v-stack,h-stack,scroll-view}.ts`, `TuiAltScreen.setLayoutRoot`, `isViewportTUI`. Coding-agent wires it in `interactive-mode.ts` / `chat-viewport.ts`.

Shipped to users in **0.84.0** (`a5f43bf8`, 2026-08-06) as `--tui-mode fullscreen` / `/settings` (still labeled experimental in the settings UI). Later commits added search, scrollbar, jump-to-end, Alt-wheel, copy-on-select. This is a TUI rewrite, **orthogonal** to AgentHarness; fullscreen still runs on `Agent` + JSONL v3.

---

## 5. Jul–Sep 2026 timeline and session migration

Dated from CHANGELOGs + git tags. Distinguish **user-visible `pi`** from **library/experimental**.

| Date | Tag / commit | Visible to `pi` users? | What |
|---|---|---|---|
| 2026-05-03 | `a5b27367` | no | Initial `AgentHarness` foundation |
| 2026-07-21 | 0.81.0 `9c480b6a`; `8495f9d0` | no | `orchestrator` package renamed `server` |
| 2026-07-24 | 0.82.0 | no | Harness `toolContext` replaces context-free tools |
| 2026-07-30/31 | `56eb685b`, `33bc0a7b`, `ea1e77e2` | TUI yes in 0.84 | Protocol + client appear; alt-screen layouts land |
| 2026-08-06 | **0.84.0** `a5f43bf8` | **yes: fullscreen TUI** | Changelog also promotes harness v4 APIs and remote `PiClient` — those are inherited library/experimental, not the default CLI loop |
| 2026-08-26 | `353c990f`; `8b691073` | no | `mini`; durable drive marked total |
| 2026-08-28 | `1d0d110a` | no | Radius remote experimental sessions |
| 2026-08-29–09-01 | `28b49a6b` … `1a7bc80e` | no | Chord runtime; service payloads leave pi-protocol |
| 2026-09-04/05 | 0.85.0 then **0.85.1** | **yes (fix)** | Experimental client/server accidentally published; pulled back to `pi-test.sh` |
| 2026-09-17/18 | `7e195076`, `08016016` | no | `micro` on Pico3; Pico moved to `packages/durable` |
| 2026-09-19–21 | 0.86.0–**0.87.0** | **yes** | Cache warming, `/bug`, `context_edit`, SessionManager as canonical context |

**JSONL versions (shipped product):** `session-format.md` and `CURRENT_SESSION_VERSION = 3` in `session-manager.ts`. v1 linear → v2 tree `id`/`parentId` → v3 `hookMessage` → `custom`. Load auto-migrates to v3. Compaction is a tree entry; raw history is kept.

**Harness format 4** (not used by shipped `pi`): JSONL header `{"v":4,...,"storageVersion":1}`. Appendix B of `packages/agent/docs/harness.md` (and `packages/agent/src/harness/session/jsonl/legacy-v3.ts`, tests in `jsonl-v3-migration.test.ts`) is the migration path:

- Open v3 unchanged, restore idle.
- Normalize: `custom_message` → custom agent message; `label`/`session_info` leave the tree as values; `model_change` / `thinking_level_change` / `active_tools_change` become lane config; reparent around discarded nodes; compaction `firstKeptEntryId` → `retainedTail`; ISO timestamps → Unix ms; ids re-minted to UUIDv7 with legacy timestamp prefix.
- First format-4 **write** atomically rewrites the file and appends one usage row `{ source: "v3-import" }`.
- Fork of an **open** v3 session is rejected until that write.

Spec claim: format 4 is still WIP; pre-stabilization shape changes have no migrator. J1 snapshot compaction (reclaim dead JSONL `pi.op.state` lines) is specified, not implemented.

There is **no user-facing `pi` command** that converts `~/.pi/agent/sessions/*.jsonl` to format 4. Conversion happens if/when a harness `JsonlSessionRepo` opens and commits those files.

---

## 6. Limitations they name, and what the rewrite is for

From **shipped** docs/code:

- Compaction is lossy for the model; JSONL keeps the tree (`compaction.md`, `sessions.md`).
- No built-in sandbox; project trust is only an input-loading guard (`security.md`). Intentional, not a harness fix.
- `Agent.state.messages` was a second source of truth; 0.87 forbids using it as request history (`CHANGELOG` breaking change). That is an in-place correction of the old loop.
- 0.85.0 shipping experimental client/server was called out as a mistake and reverted in 0.85.1.

From the **harness spec** (doc, with code backing for several items):

- The old runtime is process-local: `Agent` holds messages in memory and loops with `runAgentLoop`. The harness exists so “interrupted work resumes without repeating settled effects” (`harness.md` §0.1). Operations are durable; acceptance and driving are separate.
- **C1:** a specified raw `RemoteSession` mutation transport “contradicts the shipped process-local product”; they **deleted** raw RemoteSession in favor of process-local Session + routed semantic services (`harness.md` §2.8 / §0.9). That is an explicit design reversal.
- JSONL-as-replay-log grows dead bytes (J1 unimplemented). SQLite branch index can copy O(history) on uncompacted branches.
- `watchSession` is the only stubbed Harness method. Telemetry and search are incomplete. Precise rewrite / Postgres partitioning are future.
- Mini’s own README lists presentation shortcuts the protocol/Chord stack is meant to replace (homegrown RPC, N² broadcast).

**Bottom line:** 0.87 `pi` is still the 2025-era Agent + JSONL v3 TUI, plus a landed fullscreen layout from `tui-plan.md`. The client/server split, AgentHarness, format 4, Chord, and Pico/micro are a parallel, development-gated product. The migration story for existing user sessions is Appendix B, triggered only when the new storage stack writes, not by today’s CLI.
