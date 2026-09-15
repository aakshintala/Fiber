# Fiber

A terminal coding agent. This glossary covers the vocabulary of its sessions and the event contract that `fiber serve` and `fiber ask --json` expose.

## Sessions

**Turn**:
One run of the agent loop, from the input that starts it (a user message or a wakeup) until the agent yields control. Steering messages delivered during the run belong to that turn.

**Item**:
A unit of work inside a turn that has a lifecycle of started, deltas and completed: an assistant message, a reasoning block, or a tool call.
_Avoid_: block, entry, step

**Item id**:
Fiber's own identity for an item, assigned when the item first appears and never taken from a provider. It is opaque and unique within its session, so consumers key an item on its session id and item id together.
_Avoid_: call id, tool id

**Provider id**:
The identity a model provider gives an item, such as a tool call's `call_id`. Fiber keeps it only to talk back to that provider; it is never an item id.
_Avoid_: call id, tool id

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
