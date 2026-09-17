# Fiber

A terminal coding agent. This glossary covers the vocabulary of its sessions and the event contract that `fiber serve` and `fiber ask --json` expose.

## Sessions

**Run**:
One Fiber process working on a session, from start to exit, such as one `fiber ask` or one `fiber serve`. A session spans many runs through resume, and a run spans many turns; a session's runs never overlap.
_Avoid_: invocation, process run

**Turn**:
One run of the agent loop, from the input that starts it (a user message or a wakeup) until the agent yields control. Steering messages delivered during the run belong to that turn.

**Item**:
A unit of work inside a turn that has a lifecycle of started, deltas and completed: an assistant message, a reasoning block, a tool call, or a compaction. A tool call is first requested by the model and only later started by whoever runs it, so a call that was never started provably never ran.
_Avoid_: block, entry, step

**Item id**:
Fiber's own identity for an item, assigned when the item first appears and never taken from a provider. It is opaque and unique within its session, so consumers key an item on its session id and item id together.
_Avoid_: call id, tool id

**Provider id**:
The identity a model provider gives an item, such as a tool call's `call_id`. Fiber keeps it only to talk back to that provider; it is never an item id.
_Avoid_: call id, tool id

**Tool outcome**:
How a finished tool call ended: completed, failed, denied or cancelled. A denial says why, and a failure names a stable error code; whether a tool ran a process is read from the facts it reports, never from its name.
_Avoid_: tool status, tool result

**Job**:
Long-running work that outlives the tool call that started it, such as a background shell command, a background subagent child or a watcher. The starting call completes with a receipt naming the job; the job then has its own lifecycle, can span turns, and reports later by its own events. `/background` lists and stops jobs.
_Avoid_: background session, background task, pending tool call

**Child**:
A session started by another session's tool call, whose events the parent relays on its own stdout. A child runs either inside the call or in the background as a job.
_Avoid_: subagent session, worker

**Delegate**:
A child run by another harness, such as Claude Code or Cursor, supervised as a job. It is not a Fiber session: its output is shown but never logged, and its own harness keeps its record.
_Avoid_: external agent, backend

**Steering message**:
Input that arrives while a turn is running, from the user or from a parent, and joins that turn at its next safe point. If the turn ends first, it starts the next turn instead.
_Avoid_: interrupt, follow-up

## Events

**Event**:
One JSONL line in Fiber's versioned event schema, shared by stdout and the session log.

**Durable event**:
An event a reconnecting or resuming client needs in order to know the session's state, including in-flight work such as a started tool call or a pending approval. Durable events are exactly the session log.
_Avoid_: persistent event, logged event

**Ephemeral event**:
An event made obsolete by a later durable event, such as a text delta or a progress tick. It appears on stdout only and may be lost without losing state.
_Avoid_: transient event, live event

**Sequence number**:
A durable event's contiguous position in its session's log, never reset or reused for the life of the session. Reconnect and resume cursors are sequence numbers; ephemeral events have none.
_Avoid_: offset, index

## Routing

**Connection**:
A configured endpoint a user can send models to: its credential, default protocol, default base URL, billing kind and the models it offers. Connections belong to the user's profile, never to a project.
_Avoid_: provider, account, backend

**Preset**:
A connection shipped with Fiber, such as `codex` or `opencode-go`. A user connection with the same name overrides it field by field.
_Avoid_: built-in provider

**Model reference**:
A model named by its connection and model id, written `connection/model` and split at the first slash. Sessions and settings always store the full reference.
_Avoid_: model id, qualified name

**Alias**:
A short name a user defines for a model reference. It resolves only where a person or a tool call types it, so editing an alias never changes a stored reference.
_Avoid_: nickname, shortcut

**Protocol**:
One wire format for talking to models, such as Responses, Chat Completions, Anthropic Messages or Google Generative AI. A connection has a default protocol, and a model may use another.
_Avoid_: API, provider

**Route**:
A model reference resolved to the connection, protocol and base URL a request is sent to.
_Avoid_: target

**Credential kind**:
How a connection authenticates: a login owned by an auth scheme, a stored key, a reference to an environment variable, or none.
_Avoid_: auth source, auth strategy

**Billing kind**:
Whether a connection charges per use (metered) or through a plan (subscription), declared by the connection rather than inferred from how it logs in.
_Avoid_: pricing mode, plan type

**Provider state**:
Data a model provider returns that only that provider can read back, such as encrypted reasoning or a message's provider-side id. Fiber stores it verbatim and never interprets it.
_Avoid_: reasoning state, signature blob

**Origin**:
The connection, endpoint fingerprint, protocol and model that produced an item. Provider state is replayed only to an exact origin match; any other route gets the history transform.
_Avoid_: provider tag, source
