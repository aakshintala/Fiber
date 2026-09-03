# Portable delegation core

Status: idea under discussion

Priority: after the Fiber product transition and OpenCode Go support

Last updated: September 3, 2026

See [Cross-harness delegation](harness-delegation.md) for how Fiber consumes delegation, and [Providers](providers.md) for why portable subscriptions stay native.

## Decision summary

Morph the existing `cursor-delegate` repo into a portable delegation core, built once and used from every harness. Each harness gets a thin adapter over the same core: MCP for Claude Code and Cursor, an extension for Pi, a Zig tool for Fiber. Do not reimplement backend logic per harness.

## User need

The user works from several harnesses over time (Claude Code today, Fiber once ready) and holds captive subscriptions (Cursor, Claude) that are only usable through vendor CLIs. Delegation behavior (model allow list, capability modes, safety checks, verification, the needs input round trip) should behave identically everywhere. Fixing or adding a backend once should fix it or add it for all harnesses.

## Shape

One core owns the backend matrix and the delegation lifecycle:

- backend command templates (headless vendor CLIs) plus resume variants
- curated model allow list with family tags for uncorrelated review
- capability modes mapping to vetted noninteractive flag sets
- fail closed safety preconditions
- ground truth verification (change set, gate, stderr)
- same path write serialization
- needs input round trip (park with session handle, answer, resume)

Each adapter translates between its harness tool protocol and the core, and nothing else:

| Harness | Adapter |
| --- | --- |
| Claude Code, Cursor | MCP stdio server surface |
| Pi | Pi extension |
| Fiber | Zig builtin tool spawning the core, parsing JSON |

The contract to freeze across adapters is the result schema (backend, model, change set, gate outcome, stderr, needs input marker), not the transport.

## Non-goals

- No per-harness reimplementation of backend logic. Adapters spawn, parse, and relay.
- No new backends for portable subscriptions. Codex and OpenCode Go stay native provider transports. A subscription that becomes portable gets its backend deleted.
- No peer mesh or delegate to delegate messaging. The calling harness mediates. See the steering discussion in [Cross-harness delegation](harness-delegation.md).

## Open questions (own ideation pass)

- Process model: long-lived stdio core (MCP plus plain JSONL modes sharing the in-memory job registry) versus true one-shot CLI subcommands (needs a file-backed job store, detached children, reaping, locking).
- Language and distribution: stay on Node, ship a compiled single binary, or rewrite natively. The core is about 3.4k lines of TypeScript with 4k lines of tests, so a rewrite is weeks, not an afternoon.
- Naming: `cursor-delegate` with non-Cursor backends inside it will confuse. Rename when the second backend lands.
