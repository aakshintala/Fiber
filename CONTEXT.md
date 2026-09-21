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

**Tool call**:
Fiber doing something outside the conversation, such as reading a file or running
a command. It carries a request, a result, and a record of whether it actually
ran.
_Avoid_: tool use, function call

## Deliberately unnamed

**One Fiber process, from launch to exit.** The archived Zig tree called this a
`run` and set sessions above it. Fiber does not name it: resume, event ordering
and the headless slot are all expressed in terms of sessions, and a session's
processes never overlap, so nothing has to tell two of them apart. Name it when
a decision needs it.

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
