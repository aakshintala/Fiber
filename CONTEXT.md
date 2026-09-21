# Fiber

Fiber is a terminal coding agent. This glossary is the project's vocabulary and
nothing else: it defines what words mean, never how anything is built.

It is deliberately small. Terms are added when a decision gives them meaning,
not in advance. Nothing here was inherited wholesale from the archived Zig tree;
each word was argued on its own merits.

## Language

**Session**:
The whole piece of work, from the first input to the last, surviving Fiber being
closed and reopened. A headless one-shot review started by another harness is a
session like any other.

**Turn**:
One round of the loop: input arrives, Fiber works, Fiber yields and waits.
_Avoid_: exchange, round

**Step**:
One round-trip to the model within a turn. A turn that makes four tool calls has
five steps.
_Avoid_: iteration, cycle, round

**Action**:
One thing Fiber produces inside a step that has a beginning, a middle and an end:
a message, a block of reasoning, or a tool call. Messages and reasoning are
actions as much as tool calls are.
_Avoid_: item, part, block, entry, step, move

**Event**:
One written record of something that happened. The event stream is the record.
_Avoid_: record, entry, line

**Session log**:
The events of one session, in order, as written down. It is the session's only
state of record: everything else is derived from it.
_Avoid_: journal, transcript, history file

**Durable event**:
An event a client needs in order to know the session's true state, work in
flight included. Durable events are exactly the session log.

**Ephemeral event**:
An event a later durable event makes obsolete, such as a fragment of streamed
text. Losing one costs nothing.

**Sequence number**:
A durable event's position in its session log. It is what a client stores to
say where it got to, and it is never reset or reused.
_Avoid_: offset, index, cursor position

**Fold**:
Replaying events in order to arrive at some present fact — what the model is
sent, what the screen shows, what a session has cost. A fold is never written
down as its own record.
_Avoid_: projection, snapshot, materialised view

**Tool call**:
Fiber doing something outside the conversation, such as reading a file or running
a command. It carries a request, a result, and a record of whether it actually
ran.
_Avoid_: tool use, function call

**Watcher**:
Something that reads the event stream and cannot reply. The terminal's
rendering, a non-interactive run's stdout, a second client. A watcher can be
absent, slow or added later without changing the session.

**Driver**:
Something that sends commands to a session. The terminal's input, and stdin on
the non-interactive door. A driver may only send the commands Fiber defines.
_Avoid_: controller, client

**Participant**:
Something the loop asks during a turn, whose answer may refuse or change what
happens. Tools, providers and hooks are participants. A watcher and a driver
never are.

**Seam**:
The defined surface one kind of participant is reached through. Fiber has three:
the tool seam, the provider seam and the hook seam.
_Avoid_: interface, plugin point, API

**Hook**:
A participant asked before or after something happens, which may allow it,
change it or refuse it. Distinct from a tool, which is asked to do work, and a
provider, which is asked for a model's response.

## Deliberately unnamed

**One Fiber process, from launch to exit.** The archived Zig tree called this a
`run` and set sessions above it. Fiber does not name it: resume, event ordering
and the headless slot are all expressed in terms of sessions, and a session's
processes never overlap, so nothing has to tell two of them apart. Name it when
a decision needs it.

The session log records the boundary without naming the unit: `fiber_started`
and `fiber_exited`. A start with no matching exit is how a resumed session knows
the previous process died rather than finished.

## Reading pi's source

pi is Fiber's reference for provider and wire behaviour, not for these nouns, and
the two vocabularies collide. When reading pi:

| The thing | Fiber | pi |
|---|---|---|
| The whole piece of work | session | session |
| Input arrives, Fiber works, Fiber yields | **turn** | agent run (`agent_start` … `agent_settled`) |
| One round-trip to the model | **step** | **turn** (`turn_start` / `turn_end`) |
| One message, reasoning block or tool call | **action** | message (`message_start` / `message_update`) |
| One process, launch to exit | *(unnamed)* | *(unnamed)* |
