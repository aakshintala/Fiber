# North star: Fiber as a process

Status: draft, for owner review. Discussed 2026-09-12.

This document states what Fiber is for, the properties that follow from it,
and the order in which the open epics serve it. It is the frame the other
proposals and epics are sequenced against. It decides no slice on its own.

## Thesis

Most agent harnesses fail one of four ways: they are tied to one provider,
they are written in runtimes that burn memory and CPU at idle and worse as a
session grows, they are inseparable from their terminal UI so a GUI has to
reconcile live streaming with finalized history, or they cannot be extended
without patching the harness.

Fiber is a single process with this contract:

> A Fiber process turns a configuration directory plus a session log into a
> continued session, emits the same log as it goes, and exits clean.

Everything else is a consumer of that process: the terminal UI, a GUI, a
fleet daemon, a summarizing agent, a search index, an editor host, and an
extension.

## Deployment shapes

The contract has to hold in all three, with one runtime.

* **Attended.** A person at a terminal. The TUI is the client.
* **Unattended worker.** An ephemeral VM or sandbox, one prompt, run to
  completion, log shipped to durable storage by whoever owns the box.
* **Orchestrator.** A long-lived session that is unattended at times and has
  live users at times. Owned by a daemon on the box, which may own several
  Fiber processes at once across worktrees.

Attended and unattended is not a session kind. It is whether a client is
connected right now.

The factory that hosts the second and third shapes owns the process, the
network, authentication, fan-out to users and dashboards, log shipping, and
the index over old sessions. Fiber owns none of that. Fiber defines its input
and output contracts and the daemon adapts.

## Properties

Each property is a measurable budget, not an aspiration. Budgets live in
`benchmarks/` once set. The first number in each row is the current
expectation to be measured, not a promise.

### Lightweight, idle and grown

Memory scales with the model context window, not with the transcript. The
session log is append-only on disk; in-memory state is a bounded fold over
it; the renderer holds a window, not the history.

On a shared box the binary is not the cost. Per-session threads, MCP child
processes, and background shells are. Idle means an orchestrator waiting on
input sits at zero CPU with background threads quiescent.

Budgets to set: RSS at idle, RSS after a multi-million-token transcript,
threads per session, child processes per session, CPU at idle.

### One log, one stream

The session log is the single source of truth. Context projection, the TUI,
any GUI, persistence, replay, the C API, and extensions all consume it.
Finalized history is a fold over the events; live streaming is the same
events arriving now; replaying the log after the fact yields exactly the live
view.

Consequences:

* Fiber assigns every event an ID before first emission. Provider IDs are
  kept separately. Terminal events carry their full payload.
* One JSONL file per session, one event per line, every line valid on its
  own, flushed per event, a schema version on every line. A truncated log
  from a dead VM is still usable.
* The log is the checkpoint. Resume needs the log and the configuration
  directory, nothing else.
* Compaction writes its model-authored summary handoff into the log as an
  event at a turn boundary. The summary a person reads to orient on attach
  is the one the model continued from.
* The event schema is an external, versioned contract. Breaking it is a
  migration for every consumer, so it gets a document and a version number.

### Token and cache efficient

Prompt caching rewards a byte-stable prefix. If the model context is a
deterministic projection of the log, prefix stability holds by construction.

Rules:

* Static content first in the system prompt, volatile content last.
* Tool definitions sorted and byte-stable across MCP reconnects and across
  processes that connect to the same shared server.
* Compaction only at turn boundaries, with durable handles for evicted tool
  results.
* Cached versus uncached input tokens surfaced per turn, so a regression is
  visible in the footer and in `fiber usage`.

### Extensible without patching

pi is extensible because its harness has typed events and a registration
API, not because it is TypeScript. Fiber's extension surface is the same
event contract the GUI consumes: subscribe to events, register providers,
tools, hooks and commands, reach session state through a mediated API.

Resources arrive on disk before the process starts. In the factory the daemon
is the installer and the trust root, so Fiber loads what is on disk, reports
what it loaded, and refuses what does not validate. No registry, no network
install inside Fiber.

## The stdio protocol

`fiber serve` is the long-lived form of the contract. It reads a command
stream on stdin, emits the event stream on stdout, keeps diagnostics on
stderr, and exits when stdin closes or on a close command.

`fiber ask` is `serve` with one prompt command and stdin closed. One
implementation, two entrypoints, one serialization. Workers use `ask`; the
orchestrator uses `serve`.

Stdout carries the same JSONL lines the session file carries. A daemon can
persist stdout directly; Fiber's local file exists for resume.

Stdin carries: prompt, steer, cancel, permission reply, elicitation reply,
close. Fiber defines the set. The current permission model already handles
the unattended case: a held action returns guidance and the turn continues.
A connected client may resolve a held action over the channel.

Fiber never listens on a socket, never authenticates a client, and never
fans out to more than one client. The daemon does.

### Process lifecycle

The daemon reaps processes, so SIGTERM must flush the log, terminate shells
and MCP children, and exit with a code within a bound. A hung child join is a
fleet defect, not a cosmetic one.

Several Fiber processes may share one box and one user. Each needs a private
state directory set by the daemon. There is no such override today;
everything lives under `~/.fiber/`.

### Subagents are stdio harnesses

Once the protocol exists, a Fiber child, a headless Claude Code, and a
headless Cursor agent have the same shape: a subprocess that takes a prompt
and emits an event stream. Delegation to another harness is one adapter per
harness that translates its stream into Fiber's event contract, plus vetted
flag sets, the untrusted-output rule, and a diff Fiber computes itself. Model
selection, lineage, and transcript display work the same for every child.

Fiber's own subagents stay in-process for now. The child seam speaks the
event contract so a child could later run as a `fiber serve` subprocess for
isolation and a clean kill.

The inverse direction needs nothing new. Another harness runs
`fiber ask --json` for one shot or `fiber serve` for a conversation.

## Things Fiber does not own

* A database or search index. Search, dashboards, and review pipelines read
  the factory's store. The no-dependency rule stands because there is no
  need to break it, not because it is sacred.
* A network listener or client authentication.
* Extension installation, provenance, or a registry.
* Log shipping.

## Sequence

Ordered by what unblocks the most. Each step maps onto existing epics.

1. **Run on a fresh box.** Install with no build (#46), a state-directory
   override for the daemon, and the SIGTERM contract with the shell
   termination fixes (#104, #7). Disjoint from the routing seam, so it
   proceeds in parallel with step 2. The flaky-test and CI health epics
   (#73) run alongside; they tax every other step.
2. **The event contract.** Fiber-owned IDs and typed outcomes (#55), the
   stdin command set, and the versioned JSONL schema, written down before
   code. Then `fiber serve`, with `ask` re-based on it (#56). This is the
   spine; the routing work is built on it rather than rewritten for it.
3. **Routing on the contract.** Slice 1 (#95), then the mechanical rename,
   then per-subagent model selection (#58), then Anthropic Messages (#38),
   then MCP result images (#64) on the vision capability from `ModelInfo`.
4. **Compaction and resume.** Reconcile the context numbers (#18), then
   automatic compaction with summary handoffs as log events (#33, #54), then
   resume-from-log hardening (#9) and the traversal design (#35), which
   depends on how compaction addresses history.
5. **Delegate adapters.** Claude Code and Cursor as stdio harness backends
   (#59), after the child seam and #58 exist.
6. **Extensions.** The security contract (#25) designed against the two
   concrete adapters that need outbound HTTP and a credential: catalog fetch
   and quota probe. Then Lua catalog and quota adapters (#96, #43) and the
   remaining provider presets.
7. **C API.** The in-process form of the stdio protocol (#34), when an
   editor host needs it. Its acceptance criteria constrain steps 2 through 4
   now: side-effect-free construction, close joins owned threads, transport
   supplied explicitly.

Providers and extensions hang off the sides of this list. Nothing in the
north star says more providers first.

## Open decisions

* Whether a Fiber subagent should run as a subprocess by default once
  `serve` exists, or stay in-process until isolation is needed.
* Whether the state-directory override is one variable for all of
  `~/.fiber/` or separate for sessions, settings, and credentials.
* The exact stdin command set and the reply shape for permission and
  elicitation.

These get settled in the slice that first needs them, with the decision
record on that slice's issue.
