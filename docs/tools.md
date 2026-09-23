# Tools

What every tool shares: what it declares, how a call is checked and bounded,
and what its result carries on the log and to the model. This is what is true
now, not a plan. It is settled by
[The tool contract: what every tool shares](https://github.com/aakshintala/fiber/issues/14);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. Tool call, effect, artifact, participant, seam,
extension and event mean what it says there and nothing else. How effects are
judged is `docs/permissions.md`; the events themselves are `docs/events.md`.

## What a tool declares

- A name, a description, and an input schema written in JSON Schema.
- An effects function. Fiber calls it with each call's arguments before
  permission is decided; it returns the call's effects, whether it is
  reversible, and the paths it touches, in the vocabulary of
  `docs/permissions.md`. Classification is per call, not per tool
  (`docs/permissions.md`).
- Optionally: which end of long output to keep (`head` by default; a shell-like
  tool declares `tail`), and its own size cap.
- There is no read-only flag and no parallel-safety flag. Calls in a step run
  concurrently; file safety comes from the per-path lock in
  `docs/architecture.md` ("Tool calls in a step").
- Adapting a schema to each wire protocol, and carrying images to a protocol
  that cannot take them in a tool result, is the provider module's job, not the
  tool's.

## Before a call runs

- Arguments are checked against the input schema before the effects function is
  called. A call that fails the check completes as `failed` with code
  `invalid_arguments` and never writes `tool_call_started`, so the log proves
  it never ran. The model is told what is wrong, one line per bad field.
- A call naming a tool that does not exist completes as `failed` with code
  `unknown_tool`, never starts, and the model is told which names exist.
- An effects function that itself errors (for example a bug in an extension)
  fails closed: the call completes as `failed` with code `tool_error` and never
  runs.

## What a result carries

`tool_call_completed` carries, beside `status`, `reason`, `error` and `process`
(defined in `docs/events.md`):

- `content`: text and image parts. It is exactly what the model is sent,
  including after an after-tool hook has rewritten it. The hook's timing
  belongs to
  [Hook points: what a hook can see and change](https://github.com/aakshintala/fiber/issues/48);
  this page only requires the completed line to be written after it.
- `details`: JSON for clients, such as an edit's diff for the terminal to draw.
  It is never sent to the model and the loop never reads it. A client that does
  not recognise a tool's `details` shows `content` instead: tool identity is an
  opaque name and an extension can replace any tool, so no client may depend
  on one tool's `details`.
- `artifact`: the path to the full output, present only when the result was cut.
- Images are written to the session's `artifacts/` (see `docs/state.md`) and
  referenced by path, never inlined as base64 in the log.
- The loop reads `status`, `error.code` and the declared effects, never
  `content` or `details`. A tool's prose cannot steer control flow.
- A `failed` status is sent to the provider as that protocol's error flag on
  the tool result.

## What a result proves

Content states what was observed, never "success": the lines an edit changed, a
command's exit code, the bytes written. Each tool's specification carries this
as an acceptance criterion; nothing can check it mechanically. Whether a call
ran at all is proved by the log structure (`docs/events.md`, resume table), not
by content.

## Bounded results

- A tool that declares no cap is cut at 16 KiB of model-facing content.
  Configuration can override any tool's cap. A tool may declare a larger or
  smaller cap: the file tools and web fetch set their own in
  [File tools: read, write and edit](https://github.com/aakshintala/fiber/issues/52)
  and
  [Web fetch and web search](https://github.com/aakshintala/fiber/issues/57).
- A cut result keeps the declared end (head or tail), a notice saying it was
  cut, and the artifact path. Nothing is lost, only moved out of the model's
  view. The full output is in the session's `artifacts/`.
- The model reads the rest with the ordinary `read` tool on that path. There is
  no dedicated tool for it. A read of `artifacts/` has only the `reads` effect,
  so it is never reviewed.
- There is no cap across one step's results. Overflow of the context window is
  [Compaction: when a session outgrows its context](https://github.com/aakshintala/fiber/issues/24)'s
  to handle.
- In the owner's 648 pi sessions (measured 2026-09-22 with
  `research/tool-result-sizes/sizes.py`; sizes, so they do not depend on the
  platform), 16 KiB cuts 1.2% of 26,829 shell results and almost no result of
  any other tool except file reads (16.8% of 5,070), search (about 9%) and web
  fetch (24% of 21). Those are the tools where the model asked for exactly the
  content, which is why they declare their own cap.

## Progress

While a call runs, it may stream output and progress as `tool_call_delta`,
which is ephemeral. Fiber paces updates to at most one every
`max(100 ms, encoded bytes ÷ 100 KiB/s)`; the first change after idle goes out
immediately, held changes collapse to the latest, and completion forces a final
flush. These are pi's numbers, not measured for Fiber.

## Cancellation

`cancelled` means the tool stopped. Fiber interrupts every kind of tool itself
rather than asking it to stop: it kills a process's process group; it raises an
error inside running Lua through mlua's instruction hook (`Lua::set_hook`, whose
documentation says the error "will be propagated through the Lua code that was
executing"); it closes the socket of a network call made through the host, as it
does for a model request; and a built-in Rust tool checks for cancellation
between chunks of work. The loop writes `tool_call_completed` with
`status: cancelled` only after the tool has returned, so the log never calls a
call cancelled while it can still change something. The one wait it cannot cut
short is a read blocked in the kernel, such as on a hung network filesystem.

## Background jobs

Settled by
[Background jobs: one killable object](https://github.com/aakshintala/fiber/issues/20);
that ticket's resolution holds the rationale and the rejected alternatives.
The kinds are `docs/events.md`.

- One object: one `job_id`, one lifecycle, stopped the same way whatever runs
  inside it. A job is a shell command, a monitor, a native child session, or a
  delegate to another harness.
- The call that starts a job completes in its own turn with a receipt naming
  the `job_id` and the path of the job's output file in the session's
  `artifacts/`. There is no pending status. Every provider needs a tool result
  before the model's next step, so a call held open across turns would stall
  the turn.
- A job's output streams to that file. The model reads it with the ordinary
  `read` tool ("Bounded results"). There is no output action.
- The model-facing tool is one `jobs` tool with actions `list`, `wait`, and
  `stop`. `wait` blocks up to a timeout. Cancelling a wait (for example because
  the turn is cancelled) stops only the wait and leaves the job running.
  `jobs` only sees and acts on jobs the calling session started, so a child
  cannot stop its parent's work.
- Completion reaches the model by waking it. If the loop is idle, a finished
  job starts a new turn whose input names the job or jobs. If a turn is
  running, the news joins it at the next step boundary, the way a steering
  message does. Jobs finishing together are delivered together in one turn,
  not one turn each. If a `jobs wait` already returned a job's final state to
  the model, no completion notice is sent for it.
- A monitor is a job running a watch command where each line on standard
  output becomes a notice to the model, delivered the same way as a
  completion. Standard error goes to a separate file and never becomes a
  notice. It ends when its command exits or it is stopped. A monitor that
  floods notices is stopped as `failed` with code `flooded`, with a message
  telling the model to tighten its filter.
- A job whose output file passes 5 GB is stopped as `failed` with code
  `output_cap` (Claude Code's documented kill threshold).
- Stopping one job uses the same mechanism as cancelling a tool call
  ("Cancellation"). The wait after the kill is bounded: if a descendant that
  escaped the process group still holds the output pipe open past the bound,
  the job ends `failed` with code `indeterminate`, never `completed`. A
  stopped job ends `cancelled`.
- Jobs live and die with the Fiber process. Nothing reattaches to a job after
  a restart. Stopping every job at exit belongs to
  [Shutdown: what SIGTERM has to guarantee](https://github.com/aakshintala/fiber/issues/34).
- When a session is about to end with jobs still running — a non-interactive
  run whose model has given its final answer, `close` or stdin EOF on
  `fiber serve`, or a child session finishing its task — Fiber wakes the model
  once with a notice listing the running jobs, telling it to stop the ones it
  does not need and that the rest will be waited for. Whatever is still
  running after that is waited for, whatever its kind, and each completion
  wakes the model. The session ends when it is idle with no jobs running.
  There is no cap on this wait: a hang is bounded at the command that hangs
  (the shell tool's timeout,
  [Shell: running a command, and when it becomes a job](https://github.com/aakshintala/fiber/issues/53))
  and by the caller's SIGTERM
  ([Shutdown: what SIGTERM has to guarantee](https://github.com/aakshintala/fiber/issues/34)),
  because a cap on the waiter cannot tell a hang from long healthy work such
  as a CI watch.
- There is no cap on running jobs. Parked threads are measured in
  `docs/architecture.md` ("The threads").

## Built in or extension

A first-party tool is compiled in unless its behaviour depends on a vendor or
on the person's environment. Read, write, edit, shell, background jobs,
subagents, the task list, asking the person and web fetch behave the same for
everyone and are compiled in, as is search if [Search: built-in tools or the
shell?](https://github.com/aakshintala/fiber/issues/54) keeps it as a tool.
The default tool set therefore never needs a Lua VM, and a headless run never
fails with `extension_missing` for one of them.
Built-ins register through the tool seam exactly as an extension does and can be
replaced by name (`docs/architecture.md`, "Tool seam").

Three kinds ship as extensions:

- Provider quota: each provider reports it differently, and providers are
  already extensions, so the quota lookup lives in each provider's package.
  Detail belongs to
  [Provider quota the model can see](https://github.com/aakshintala/fiber/issues/58).
- Web search backends: each search service has its own API, key and response
  shape. How the web search tool splits from its backend is
  [Web fetch and web search](https://github.com/aakshintala/fiber/issues/57)'s.
- Compact build and test output (the owner's `structured_return`): parsing
  depends on the person's toolchain, so it is an extension over an after-tool
  hook that replaces `content`, with the full log in the artifact.

## Not settled here

- Whether a call that started but never finished may be re-run after a crash:
  [Revisit: may a tool that never finished be re-run after a crash?](https://github.com/aakshintala/fiber/issues/40)
- Which tools the model sees, and when:
  [Which tools the model sees, and when](https://github.com/aakshintala/fiber/issues/51)
- Each tool's own design: the tickets indexed in
  [Epic: tools](https://github.com/aakshintala/fiber/issues/59).
- When a hook runs and what it may change:
  [Hook points](https://github.com/aakshintala/fiber/issues/48).
- Confinement:
  [Does Fiber confine what tools can touch?](https://github.com/aakshintala/fiber/issues/30)
- Whether a long shell command becomes a job on its own:
  [Shell: running a command, and when it becomes a job](https://github.com/aakshintala/fiber/issues/53).
- The flood threshold at which a monitor is stopped as `flooded`. Claude Code's
  number is unprobed.
