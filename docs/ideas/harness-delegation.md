# Cross-harness delegation

Status: idea under discussion

Priority: after the Fiber product transition and OpenCode Go support

Last updated: September 3, 2026

See [Providers](providers.md) for the portable provider shape. This document covers the captive remainder: subscriptions that are only usable through their own harness.

## Decision summary

Add a single `delegate` tool usable from Fiber that shells out to captive harness CLIs in headless mode. Start with Cursor and Claude as backends. Keep Codex and OpenCode Go as native providers, not backends. The portable implementation lives in the existing delegation repo (today `cursor-delegate`, generalized to multiple backends) as an MCP stdio server; Fiber consumes it as an external MCP tool. Do not build a peer mesh or IPC daemon, and do not reimplement the delegate natively in Zig until the shared server proves painful.

## User need

One user holds four subscriptions at once: Anthropic, OpenAI (via Codex), Cursor, and OpenCode Go. Anthropic and Cursor are only usable through their own harnesses. OpenAI and OpenCode Go are usable from any harness with the right transport.

The user wants Fiber as the home harness once it is ready, spending most time there, while still drawing on all four model pools. Today that works through a Node MCP server (`cursor-delegate`) that lets Claude Code call out to `cursor-agent`. That server cannot ship with Fiber, which has no Node runtime, and its job registry duplicates what Fiber already owns.

A user should be able to, from Fiber:

- dispatch a task to a Cursor or Claude model by name
- keep working while it runs, with progress and cancellation
- receive the result, including files changed and stderr on failure
- answer a clarifying question from the delegate and resume it
- get a clear error when the backend CLI is missing, logged out, or the model is unknown

## Captive versus portable

| Class | Examples | Path in Fiber |
| --- | --- | --- |
| Portable | Codex, OpenCode Go | native provider transport, model selection routes the request |
| Captive | Cursor, Claude subscription | `delegate` tool spawning the vendor CLI |

No backend is needed for a portable subscription. If a subscription becomes portable later, its backend is deleted, not maintained in parallel.

## Where the code lives

Portability argues for one implementation, not one per harness. The delegation repo keeps the backend matrix (command templates, model allow list, capability mapping, verification, needs input round trip) as an MCP stdio server. Claude Code, Pi, and Fiber all consume the same server over MCP. Fiber already supports stdio MCP servers via `.mcp.json`, so v1 is configuration, not Zig code.

A native Zig port inside Fiber is deferred work. It earns its keep only with evidence the shared server is painful from Fiber: startup latency, process management, or distribution friction that configuration cannot fix. Until then a second implementation is duplication, not leverage.

## Initial boundary

The first version adds only what the external CLIs require: command templates, a model allow list, capability mapping, and result parsing. It must not depend on a generic extension system or a runtime provider registry.

Reuse what Fiber already owns and do not reimplement it:

- async execution, progress events, and cancellation from the tool and subagent runtime
- permission decisions from the existing permission layer
- session persistence and usage reporting from the session layer

The reference design is the existing `cursor-delegate` behavior, minus its process hosting: curated models, capability modes, fail closed safety, ground truth verification, same path serialization, and the needs input round trip. The MCP server wrapper, job registry, and poll/wait tool family do not carry over. Each of those maps to a native Fiber primitive.

## Tool shape

One tool, backend selected per call:

```text
delegate { backend: cursor | claude, capability, model, prompt, workdir }
```

Backends are data, not code paths. Each backend defines a headless command template plus its resume variant:

```text
cursor: cursor-agent --print --force --model {model} ...
claude: claude -p --model {model} ...
```

Resume passes the retained session handle back through the matching template flag (`--resume` or equivalent). Model selection alone determines the route within a backend. There is no profile wide backend setting.

Capability modes map to vetted noninteractive flag sets: read only (`ask`, `plan`) versus mutating (`write`, `write-unsandboxed`). Every mode runs noninteractively so a delegate never blocks on an approval prompt.

## Safety

Capability modes are only labels. Enforcement stays in Fiber:

- every call passes the existing permission review before spawning
- read only calls must not gain filesystem mutation through shell escape; the permission layer sees the full spawned command
- concurrent mutating delegates against one worktree are refused, not interleaved
- the delegate output is untrusted text until Fiber verifies it

Fail closed: a backend whose CLI is missing, logged out, or whose safety preconditions are unmet refuses the call with a structured error naming the remedy.

## Verification

Do not trust the delegate self report. On completion Fiber computes the change set itself (git status and diff over the workdir), runs an optional postcondition gate command when configured, and surfaces delegate stderr on failure. The result records backend, model, change set, and gate outcome in session state.

## Needs input round trip

A delegate that cannot proceed ends with a terminal marker carrying its question instead of failing. Fiber parks the run with its session handle and resume context. Answering resumes through the backend resume template. Cancellation and progress flow through the normal tool lifecycle while parked or running.

## Non-goals

- No peer mesh, socket protocol, discovery, or daemon. Any harness can already call any other by spawning its headless CLI. A transport is only justified by live mid-turn steering that resume cannot express.
- No delegate to delegate messaging. The orchestrator mediates. Direct peer chat removes the single point where permissions and verification live.
- No Node.js in the shipped Fiber binary. The shared delegation server may stay Node; Fiber consumes it over MCP as an external tool, which is already the supported boundary for external processes.
- No automatic model routing. Explicit backend and model selection is enough until evidence shows policy routing saves work.

## When to revisit

Add live cross-harness steering only when long running delegates routinely need redirecting without the context loss of cancel plus resume. That is the one pain resume cannot fix. Peer messaging earns reconsideration only with evidence of a workflow where orchestrator mediation is the bottleneck rather than the audit point.
