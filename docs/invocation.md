# The front doors

How Fiber is started, what goes in, and what comes back out. This is what is
true now, not a plan. It is settled by
[Front doors: which invocation modes does v0.0.1 have?](https://github.com/aakshintala/fiber/issues/10);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. Front door, driver command, session, turn, step
boundary, steering message, watcher and driver mean what it says there and
nothing else. The events named here are `docs/events.md`; this page is only
the process contract over them.

## Two doors

| | What it is |
|---|---|
| `fiber` | The terminal. Requires a tty; without one it is a usage error naming `fiber serve`. |
| `fiber serve` | The non-interactive door. Stays open. Its stdin is the driver channel: one JSON command per line. This is the door a GUI frontend, a supervising tool or a script uses. |
| `fiber ask` | The same non-interactive door with the prompt already supplied and no further prompts accepted. Its stdin is the prompt. |

`ask` is not a second door and not a second code path. It is `serve` with its
input already supplied and no more coming — the archived tree reached the same
conclusion in
[fiber-zig#190](https://github.com/aakshintala/fiber-zig/issues/190): "There is
no second execution path."

Map premise 6 governs both: "Both interactive and non-interactive sessions are
one agent loop behind two front doors: same session, same event stream, same
log." A door has no privilege the terminal lacks, and neither has a path to
state the other does not.

## Getting a prompt in

`ask` takes its prompt three ways, and supplying two is an error rather than a
precedence rule, because ambiguous input is a caller bug worth surfacing:

```sh
fiber ask "review the diff on this branch"
cat brief.md | fiber ask
fiber ask --prompt-file brief.md
```

`--prompt-file` is not redundant with argv. Linux caps a single argument at
`MAX_ARG_STRLEN`, 32 pages — 131072 bytes — independently of `ARG_MAX`, and
premise 9 makes Linux the platform that carries the usage weight. macOS is far
looser: a 1 MiB argument passes on Darwin 25.6.0, where `ARG_MAX` is 1048576.
A brief that runs fine on a Mac can fail with `E2BIG` on the machine that
matters, so the flag exists to take the size cliff off the table. The Linux
figure is documented, not measured here.

`fiber ask` with no prompt and stdin on a terminal is a usage error, not a
silent drop into the TUI.

## Why stdin means different things

On `serve`, stdin is the driver channel. On `ask`, stdin is the prompt. That
split is deliberate and it is the only difference between them worth naming.

The alternative was deciding what stdin holds by looking at it — treat a line
that parses as a command object as a command, anything else as text. That
fails in this repository specifically: a brief asking Fiber about Fiber's own
command set would open with exactly such a line. A mode switch on content is a
bug that arrives once, at the worst moment.

What `ask` gives up by spending its stdin on the prompt is the ability to
answer an interaction or steer mid-run. That costs nothing, because
`docs/permissions.md` already settles the unattended case — "With no client
attached and no answer possible, escalation is a block and the run continues
under the rule above until it exhausts the block budget" — and cancelling is a
signal, not a command. A caller that wants to talk back uses `serve`, which is
what it is for.

## Driver commands

The closed set a driver may send. Every command is answered with exactly one
ephemeral `command_accepted` or `command_rejected` echoing the command's id;
acknowledgements carry no `seq`, so they never reach the log.

| Command | What it does |
|---|---|
| `prompt` | Starts a turn. Rejected `busy` if a turn is running. |
| `steer` | Sends a steering message, which joins the running turn at its next step boundary. A steering message also moves any running shell call to the background, so it reaches the model at the next step boundary. Takes an optional `session_id` naming a delegate. |
| `steer_amend` | Replaces a steering message's text while it is still queued. |
| `steer_drop` | Removes a queued steering message, so nothing is applied. |
| `cancel` | Ends the running turn. |
| `reply` | Answers an interaction the loop raised: approval, confirm, select, text input or status. Takes an optional `session_id` naming a delegate. |
| `job_stop` | Stops a running job by `job_id`. Rejected `stale_request` if the job is not running. |
| `background` | Moves every shell call running in the current turn to the background (`docs/tools.md`, "Shell"). Rejected `stale_request` if none is running. |
| `close` | Accept no more prompts; finish the turn in flight, then any running jobs (`docs/tools.md`, "Background jobs"), and exit. |

Rejection codes: `malformed`, `unknown_command`, `busy`, `stale_request`.

**`reply` answers all five interactions, not just approvals.**
`docs/architecture.md` fixes the set: "v0.0.1 ships one closed, versioned set
of interactions — approval, confirm, select, text input, status — carried on
the same request events the loop uses to ask a human anything, and answerable
by any connected client including a headless one." The interaction kinds are
versioned and may grow; one command that carries a `request_id` does not have
to grow with them. What happens to a stale one is already `docs/events.md`'s:
"a reply naming a request that is no longer pending is rejected and does
nothing, so a late approval can never authorise a different action."

**`steer_amend` is the atomic form of drop-then-steer.** Without it a client
changing queued text sends `steer_drop` then `steer`, and the loop can drain
the queue between them — the turn gets nothing when it should have got the new
text. One command closes that window. Both amend and drop are rejected
`stale_request` once `steering_applied` has landed, and neither can tear:
`docs/architecture.md` puts one inbox behind one thread draining at step
boundaries, so an amend lands wholly before a drain or wholly after it.

**`steer` and `reply` can name a delegate.** With an optional `session_id`
naming a delegate, the command goes to that delegate instead of this session.
Each parent forwards a command addressed to a descendant down the tree, so a
driver reaches any delegate in it (`docs/delegates.md`). The command is
rejected `stale_request` if no such delegate is running.

**`job_stop` names a running `job_id`.** It is rejected `stale_request` if the
job is not running. The terminal lists jobs with `/jobs` and can stop one from
there. The list is a fold of the log, so there is no driver list command.

**`background` frees the turn without a message.** It does what a steering
message does to running shell calls, with nothing sent to the model. The
terminal binds it to Ctrl+B. It never kills a command: the command becomes a
job and keeps its timeout.

**The set is a floor, not a proof.** It is what Fiber's settled semantics
require today. An open ticket may add one — [#24](https://github.com/aakshintala/fiber/issues/24)
if a human can force compaction, [#12](https://github.com/aakshintala/fiber/issues/12)
if a model can be switched mid-session. Adding a command is additive and not
breaking, which is why `unknown_command` exists: an older Fiber tells a newer
client no, in words, instead of ignoring it.

A driver that needs a command Fiber does not define has found a hole in the
contract, not a reason for a private channel. Premise 5 gives the TUI "no
privilege a second GUI client would not have", so a command the terminal needs
is a command every driver gets.

## Lifecycle

**First line is `fiber_started`**, carrying the Fiber version, the
`schema_version`, the `session_id`, and whether the session is new or resumed.
Both subcommands take the same resume selector.

**Stdin EOF and `close` mean the same thing: no more prompts are coming.**
Neither cancels. Fiber finishes the turn in flight, gives the ending notice and
waits for any running jobs (`docs/tools.md`, "Background jobs"), then exits.

One rule covers both cases that matter. A GUI frontend that dies mid-turn
closes the pipe, and Fiber follows that same path rather than orphaning
itself. A delegated run is spawned with its prompt supplied and stdin already
at EOF, so it runs until the model's final answer — twenty minutes if it takes
twenty minutes — on the same path; its caller's turn ending changes nothing,
because the caller's turn was never holding the pipe.

**A prompt arriving mid-turn is rejected `busy` and starts nothing.** Steering
is the mid-turn channel. Fiber holds no prompt queue that no durable event
describes; the admission-ordered steering queue is the only queue.

**Cancellation targets the turn, not the process.** What it does is the
concurrency section of `docs/architecture.md` and adds nothing here.

**Exit codes: 0 success, 1 failure, 130 interrupt, 143 SIGTERM.** What SIGTERM
has to guarantee before the process goes is
[#34](https://github.com/aakshintala/fiber/issues/34).

## What a caller gets back

Nothing on this door is a second format. `docs/events.md`: "Filter a
non-interactive run's stdout to durable lines carrying its own `session_id` and
you have `events.jsonl`, byte for byte."

- **The verdict** is `fiber_exited`, the last line, which copies the final
  message's text so a one-shot caller reads one line and is done.
- **Finished or died** is whether `fiber_exited` is there at all. A
  `fiber_started` with no matching `fiber_exited` means the process died.
- **Progress** is the ephemeral lines. They carry no `seq` and never reach the
  log.

Two consequences for the door: **stdout carries no terminal escape codes and
no tty is required**, because either would break that byte-for-byte equality.

## Isolation

Fiber accepts a workspace path, runs in it, and records it on
`session_started`. Fiber creates a worktree only for a delegate that asks for
one (`docs/delegates.md`). A supervisor starting Fiber still makes the tree
and passes the path; it needs git anyway to report what changed. This follows
`docs/architecture.md`'s "`main` holds no feature logic" and keeps git out of
the binary.

## Fiber serves no MCP

v0.0.1 ships no MCP server, and the job supervisor that manages several
outstanding delegations lives outside Fiber. The rationale is
[ADR 0005](adr/0005-no-mcp-server-the-supervisor-is-external.md). Whether Fiber
is an MCP *client* — consuming tool servers — is a separate question and stays
[#22](https://github.com/aakshintala/fiber/issues/22)'s.

What Fiber owes the delegation slot instead is being cleanly wrappable, and
that is the whole of it:

- start non-interactively with a prompt, with no tty,
- put no escape codes on stdout,
- announce the session id on the first line,
- emit a documented, versioned event stream,
- exit with a stable code,
- run in a workspace path it is given rather than one it makes.

Everything a supervisor does beyond that — tracking several jobs, waiting on
any or all of them, running a verification gate afterwards, reporting a git
change set — is orchestration that is identical for any agent binary, and a
supervisor that knows only about Fiber is worth less than one that does not.

## Not settled here

- The TUI's own shape, including whether it edits a queued steering message:
  [TUI: scrollback or full screen?](https://github.com/aakshintala/fiber/issues/15)
- What SIGTERM guarantees:
  [Shutdown: what SIGTERM has to guarantee](https://github.com/aakshintala/fiber/issues/34)
- Whether Fiber consumes MCP servers:
  [Does v0.0.1 speak MCP, and as what?](https://github.com/aakshintala/fiber/issues/22)
