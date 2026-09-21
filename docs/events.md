# The event stream

What Fiber writes down, what it emits, and what a consumer can rely on. This is
what is true now, not a plan. It is settled by
[What is the event stream, and what is durable?](https://github.com/aakshintala/fiber/issues/6);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. Session, turn, step, action, event and tool call
mean what it says there and nothing else.

## The rule everything else follows from

**The session log is the only state of record.** Anything the loop, the TUI or
an extension needs after a resume is an event, or a fold of events. Runtime
objects may cache and index; none of them is ever a second authority. No file
beside the log holds state.

Two consequences that get violated first, so they are stated first:

- **No sidecar.** A session directory holds the log, a lock, and directories for
  bytes too big to inline. No `session.json`, no usage ledger, no checkpoint, no
  manifest. Token totals, history length and what the last turn was doing are
  folds computed at open.
- **The log is append-only for the life of the session.** Compaction emits new
  events. It never rewrites, renames or restarts the file, because a sequence
  number a consumer stored yesterday must still point at the same event today.

## The envelope

One JSON object per line, one event per line, every line valid on its own.

| Field | On | Meaning |
|---|---|---|
| `kind` | every line | the only discriminator a consumer switches on |
| `session_id` | every line | the session this event belongs to |
| `ts` | every line | milliseconds since the epoch |
| `schema_version` | every line | every line must be readable without negotiation |
| `turn_id` | lines about a turn, or an action in one | correlation |
| `action_id` | lines about an action | correlation |
| `seq` | durable lines only | position; contiguous per session, never reset or reused |
| `payload` | every line | kind-specific body, nested so it can never collide with the envelope |

Kind-specific fields live under `payload`. A consumer skips any `kind` it does
not recognise and ignores fields it does not know.

## Durable and ephemeral

**A line is durable if and only if it carries `seq`.** There is no separate
flag, because a flag can disagree with the thing it describes.

- **Durable** means a client that was not listening needs this line to know the
  session's true state, work in flight included: a tool call that started, an
  approval still pending, a turn that never ended.
- **Ephemeral** means a later durable line makes it obsolete: text deltas,
  progress ticks, command acknowledgements.

The durable lines, in order, are the log. Filter a non-interactive run's stdout
to durable lines carrying its own `session_id` and you have `events.jsonl`, byte
for byte. There is no second format and no replay command: a client catching up
reads the file.

In an attended run stdout is the terminal, so that equality binds the
non-interactive door only. The TUI consumes the same event stream in-process and
holds no private path to state; anything it renders exists in this contract, as
an ephemeral event where it is display-only.

## Identity and ordering

- Fiber mints every id — `session_id`, `turn_id`, `action_id` — from random
  bytes, when the thing first appears and before any line about it is emitted.
  The id a consumer sees first is the id it keeps, through execution,
  persistence and resume. There is no provisional id and no reconciliation
  event.
- Ids are opaque and unique within their session. A consumer keys on
  (`session_id`, `action_id`); nothing has to be globally unique.
- Random, not a counter: a crash before the first durable write would let a
  resumed session remint a number a consumer already saw.
- A provider's own id for a tool call is recorded in the payload of the durable
  completed line, so provider history can be rebuilt on resume. It is never used
  for correlation — it means a different thing per provider, redaction can
  rewrite it, and switching model mid-session can move it under a consumer.
- `seq` is the cursor. Ids say what a line is about; `seq` says where it sits.
  Several durable lines share one action, and some sit between turns, so no id
  can serve as a cursor.

## Kinds

v0.0.1's loop emits the kinds below. Children, background jobs, delegates and
MCP elicitation are in v0.0.1's scope but their kinds are defined by their own
tickets, which inherit every rule on this page and cannot violate one.

### Process boundary

| Kind | Durable | Payload |
|---|---|---|
| `fiber_started` | yes | Fiber version, `schema_version`, new session or resumed |
| `fiber_exited` | yes | exit code, the final message's `action_id` and its text, `error` if it failed |

A process is not a named unit in the glossary; these two lines record its
boundary without inventing one. They are durable for one reason: a
`fiber_started` with no matching `fiber_exited` is the only record that a process
died rather than finished. That is the same trick tool calls use below.

`fiber_exited` copies the final message's text as well as pointing at it, so a
one-shot caller reads the last line and is done:

```sh
answer=$(fiber ask --json "$prompt" | tail -1 | jq -r .payload.text)
```

**That copy is output, never a source.** Fiber never reads it back, no fold
consults it, and if it ever disagrees with the action it points at, the action
wins. This is the one place a line restates content another line already
carries, and it is safe for a specific reason: it is written once, at exit,
from the message it copies, so it cannot drift while a session is running.
Every other duplicate is the bug this page exists to prevent — a stored fold
that is read back and goes stale.

The alternative was making callers filter the stream for the last
`assistant_message_completed`, which is a one-liner today and stops being one
as soon as a child session relays its own messages onto the same stdout.

### Session and turn

| Kind | Durable | Payload |
|---|---|---|
| `session_started` | yes | creation time, workspace root |
| `turn_started` | yes | the input that started it |
| `turn_completed` | yes | `outcome` (`completed`, `interrupted`, `failed`), `error` on failure |
| `steering_applied` | yes | the text a running turn received at a step boundary, and where it came from |

A **steering message** — input sent while a turn is running — joins that turn
at its next step boundary, and `steering_applied` is how the log shows what
the turn actually received. A message the turn ends before applying becomes
the next turn's input, so it appears on the next `turn_started` instead. The
threading this rests on is the concurrency section of `docs/architecture.md`;
the driver commands that send, amend and withdraw one are
[Front doors](https://github.com/aakshintala/fiber/issues/10).

`turn_completed` means settled. Retries and compaction happen inside the turn
and appear as actions, so there is never a second "really finished" event.

A **step** gets no event. It is one round-trip to the model, and its boundary is
derivable from the action sequence, so naming it on the wire would add a line
that carries nothing a consumer cannot compute.

### Actions

Every line carries `action_id`. Deltas are ephemeral; everything else is
durable.

- `assistant_message_started` / `_delta` / `_completed`
- `reasoning_started` / `_delta` / `_completed`
- `tool_call_requested` — the model finished emitting the call: name, full
  arguments, provider id.
- `tool_call_started` — execution began, wherever it runs, including a
  provider-hosted tool the provider reports as in progress.
- `tool_call_delta` — streamed output and progress. Ephemeral.
- `tool_call_completed` — outcome.

A failed model call is an assistant message that completed with a failed
outcome, a cause and an attempt number; the retry is a new action. There is no
separate error channel, so no failure is ever reported twice.

`tool_call_completed` carries:

- `status`, a closed set: `completed | failed | denied | cancelled`. Adding a
  value here is a breaking change.
- `reason`, an open set, on a denial.
- `error { code, message }` on a failure, with a stable `code` so a consumer can
  treat `timeout` differently from `invalid_arguments` without parsing English.
  A nonzero exit is `failed` with code `nonzero_exit`.
- `process { exit_code?, signal?, timed_out }` on any call that ran a process,
  keyed on whether the field is present rather than on the tool's name.

An unknown `error.code` is a generic failure and an unknown `reason` is a
generic denial; the consumer shows the message. Adding either value is additive.

A call stopped by Fiber or the user is `cancelled`, not a signal failure. An
interrupt is not a crash.

### Approval

| Kind | Durable | Payload |
|---|---|---|
| `permission_requested` | yes | `request_id`, the tool call's `action_id`, what is being asked |
| `permission_resolved` | yes | the decision, any feedback, who answered |

Both are durable so that a driver reconnecting to an unattended session learns
it is blocked on a human rather than hanging on silence. `request_id` is minted
like any other id; a reply naming a request that is no longer pending is
rejected and does nothing, so a late approval can never authorise a different
action.

The full shape of approvals, and what happens with no human present, is
`docs/permissions.md`. It fixes these two payloads' contents: a request
carries the tool call's `action_id`, the call's declared effects and paths,
and why it was raised; a resolution carries the decision, the reason, and what
decided it — a human, a standing rule, a session grant, the reviewer, or the
mode.

### Usage and notices

| Kind | Durable | Payload |
|---|---|---|
| `usage_recorded` | yes | generation id, model, tokens, cost or `null` when unknown, `action_id` where it belongs to one |
| `retry_scheduled` | no | cause, attempt, delay |
| `notice` | no | open-set `code` and message, for a failure outside any action |

One `usage_recorded` per model call, whatever started it. A cost that settles
late is a second `usage_recorded` with the same generation id, replacing the
first. Consumers sum; resume rebuilds the ledger by folding. No pending queue,
no watermarks, no reconciliation file.

## Resume

A session is reconstructed from the log and the configuration directory,
nothing else.

Open memory-maps or scans the file into an offset table and folds the
latest-wins facts as it goes. Only the window a consumer actually needs is
parsed. The model's context, the TUI's viewport and any search are three
residency policies over one primitive: a range read by `seq`. Compaction
shortening what the model sees must not shorten what a person can scroll back
to.

What the reader can tell about work that was in flight, from the log alone:

| What the log shows | What it means |
|---|---|
| `tool_call_requested`, no `tool_call_started` | provably never ran; safe to run or discard |
| `tool_call_started`, no `tool_call_completed` | uncertain; never blindly re-run |
| `tool_call_completed` | ran, with its outcome |
| `turn_started`, no `turn_completed` | the turn was cut short; render what was logged and say so |
| `fiber_started`, no `fiber_exited` | that process died rather than exited |

Partial assistant text from an interrupted response is gone, because deltas are
ephemeral. The log does not pay to store text a completion would supersede.

An attempt count is derived by counting `assistant_message_started` lines, never
from a stored counter, so it cannot drift from the record.

## Writing

**Fsync the record of a side effect after it happens and before causing the
next one.** Two exceptions, both because the effect costs money or touches the
world: `tool_call_started` is fsynced *before* the tool runs, and
`assistant_message_started` *before* the model request is sent. Two fsyncs
bracket each effect, so a quiet text turn costs two.

**No line restates the content of an earlier line in the same turn.** This is
part of the durability rule, not an optimisation. A per-step line that carries
steps 1..N makes the log quadratic in tool calls within a turn; measured on the
Zig implementation, a 429-call turn wrote 412 MB and peaked at 2.1 GiB RSS,
where per-action lines carry the same information written once each. Any future
line that summarises the turn so far reintroduces this, so it needs this
decision overturned first. The one restatement in the contract, the final text
on `fiber_exited`, sits outside any turn and is never read back.

**A torn tail is discarded.** A reader stops at the last complete line and a
writer truncates a partial line before appending, so a power cut cannot make a
session unopenable.

**One writer per session, enforced by a lock file.** A second Fiber process
opening the same session refuses and names the holder, plainly, rather than
hanging or corrupting the log. Readers need no lock at all: append-only plus
"stop at the last complete line" is the whole protocol.

## The session directory

```
<state dir>/sessions/<session_id>/
  events.jsonl     the log
  session.lock     one writer
  artifacts/       bytes too large to inline
```

Nothing else. A directory is a session when its log parses and begins with
`session_started`; no marker file can outlive the thing it marks. Listing
sessions reads the logs — 601 session files' first lines took 39 ms warm on
macOS arm64, so there is nothing for an index to save yet. Whether Fiber ever
writes a derived database, and where this directory lives, is the state
directory ticket; whatever it decides, any such store is derived from the logs,
rebuildable at will, and never the truth.

## Versioning

One integer `schema_version` on every line, shared by durable and ephemeral,
never negotiated at startup — a line relayed from another Fiber build has to be
readable on its own.

- **Additive, no bump:** a new kind, a new optional field, a new value in an open
  set (`error.code`, denial `reason`, `notice.code`). Consumers skip unknown
  kinds and ignore unknown fields.
- **Breaking, bump:** removing, renaming or retyping a field or kind; changing a
  field's meaning; making an optional field required; adding a value to a closed
  set (`status`).

Before 1.0 there are no migrations: a session written against an older version
may fail to open, because there is no installed base to strand. From the first
release, every breaking bump ships a migration that upgrades an older log when
Fiber opens it, plus its test. Fiber then reads exactly one version, so reader
branches never accumulate.

## Testing

A test asserts on what a consumer sees: the lines and the file left behind. A
test that reaches inside Fiber to check an emitter was called proves nothing
about the stream, and the central invariant — durable output equals the log,
byte for byte — is not even expressible from in there.

The numbers quoted on this page were measured on the archived Zig
implementation. They justify the rules; they are not Fiber's budgets. Fiber
measures its own, on Linux, because the fsync cost that drove the write path is
25–53% of turn wall time there and under 3% on macOS.
