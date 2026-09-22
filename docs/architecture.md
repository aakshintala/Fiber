# The modules

The modules Fiber is made of, and the rules about which may call which. This is
what is true now, not a plan. It is settled by
[What modules exist, and who may call whom?](https://github.com/aakshintala/fiber/issues/7);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. Watcher, driver, participant, seam, hook, session,
turn, event and tool call mean what it says there and nothing else.

How Fiber is started, and the commands a driver may send, is
`docs/invocation.md`.

## Three kinds of participant

Everything that touches a running session is one of three things.

- **Watcher** — reads events, cannot reply. The terminal's rendering, the
  non-interactive door's stdout, a future GUI, a log shipper. A watcher may be
  absent, slow, or added later, and nothing about the session changes.
- **Driver** — sends commands in. The terminal's input handling, and stdin on
  the non-interactive door. A driver may only send commands Fiber defines.
- **Participant** — is asked during a turn and may refuse or change what
  happens. Tools, providers and extension hooks. A participant's answer
  changes the turn.

Map premise 5 ("Fiber is a set of modules with defined API semantics and no
cross-module reach. The TUI is an ordinary consumer of the event stream, with
no privilege a second GUI client would not have.") governs watchers and
drivers absolutely. Participants are a deliberate, named exception whose
entire surface is the three seams below.

**The terminal is a watcher and a driver, never a participant.** When the loop
needs an answer from a human it emits a request and waits for a reply
command. The terminal is one possible answerer; a calling harness is another,
answering identically. This follows from `docs/events.md`: "The TUI consumes
the same event stream in-process and holds no private path to state; anything
it renders exists in this contract, as an ephemeral event where it is
display-only."

## The modules

| Module | Job |
|---|---|
| `contract` | The vocabulary every other module speaks: what an event looks like, what a command looks like, and what a tool, a provider and a hook must each be able to do. It contains no behaviour at all. |
| `log` | Owns the session directory. The only thing that opens `events.jsonl`, holds the lock, mints `seq` and decides fsync order. Also hands events to whoever is watching. |
| `loop` | Runs turns and steps. The only thing that decides what happens next. |
| `provider` | Talks to model APIs: wire formats, credentials, streaming. Reached only through the provider seam. |
| `tools` | Runs tool calls: shell, file edits, search. Reached only through the tool seam. |
| `extensions` | Loads extension code, hosts the runtime, and wires what extensions register into the three seams. |
| `tui` | Draws the terminal. Watches events, sends commands, knows nothing else. |
| `config` | Reads the configuration files in [Fiber home](state.md). Answers questions; never asks any. |
| `doors` | The non-interactive front door: argv or stdin in, JSON lines out. Which doors exist and what a driver may send them is `docs/invocation.md`; this page only fixes that a door sits beside the TUI with no privilege the TUI lacks. |
| `main` | The composition root. Parses argv, builds everything once, picks a door. No feature logic. |

### Why contract exists

Everything else points one direction: the loop calling down into providers,
tools and extensions, with nothing calling back up — except that an extension
mid-turn needs to ask Fiber something, such as what is in the session. That is
a call upward, and it is the one thing that would make the dependency graph
circular. Putting the types and the seam definitions in a module that depends
on nothing, and that everything else depends on, breaks that cycle: the
extension talks to `contract`, not to `loop`.

## The call rules

`contract` depends on nothing and everything depends on it. `log` and
`config` depend only on `contract`. `provider`, `tools` and `extensions`
depend on `contract` and never on `loop`, on each other, or on `tui`. `loop`
depends on `contract`, `log` and the three seams, and never on `tui`, `doors`
or `main`. `tui` and `doors` depend on `contract` and on `log`'s reading side,
and never on `loop`, `provider`, `tools` or `extensions`. `main` depends on
everything, and nothing depends on `main`.

1. Calls point one way. If A may call B, B may never call A. B answers, or it
   emits an event and A picks it up.
2. `loop` is the only module that decides what happens next.
3. Only `log` opens the session directory, holds the lock, or mints `seq`.
4. `loop` never names a tool, a vendor or a provider. It reasons about what a
   tool is allowed to do, never about which tool it is. An audit of the
   archived Zig tree found about 211 string literals naming
   built-in tools inside `src/core/` production code, plus a core enum listing
   every built-in by name
   ([Core reasons about tool kinds, not builtin names](https://github.com/aakshintala/fiber-zig/issues/138)).
5. Only `config` reads the configuration files in [Fiber home](state.md).
   `main` distributes what it returns.
6. `main` holds no feature logic.

## How the boundaries are enforced

Fiber is a cargo workspace with one crate per module. Each crate's
manifest lists what it may use, so a call the rules above forbid does
not compile — it is a build failure, not a lint finding or a review
comment. The rationale is
[Module boundaries are crate boundaries](adr/0002-module-boundaries-are-crate-boundaries.md);
the measurements are on
[issue #7](https://github.com/aakshintala/fiber/issues/7#issuecomment-5756970986).
This is why `contract` depends on nothing: a cycle between crates is a
build failure, so the module holding the shared types has to sit at the
bottom.

## The three seams

### Tool seam

"run this and give me a result." Fiber's own built-in tools are compiled in
and register through this seam exactly as an extension's would. An extension
registering the same name replaces the built-in, and **the replacement is
recorded in the session log**, so a headless caller, a resumed session and an
audit all see it. The loop asks the registry for a name and runs what comes
back; it never learns whether the answer was Fiber's or an extension's.

### Provider seam

"send this to a model and stream back actions." A provider is an extension
over a native wire protocol; see `docs/model-routing.md` and
[ADR 0007](adr/0007-protocols-are-native-providers-are-extensions.md).

### Hook seam

"here is what is about to happen: allow it, change it, or refuse it."
Synchronous: the loop stops, asks, waits and honours the answer, under a
timeout Fiber enforces. Whether an extension runtime is in-process or a
subprocess is [issue #11](https://github.com/aakshintala/fiber/issues/11)'s
decision; whatever it picks must be able to answer synchronously inside a
turn.

## Asking a human

**Anything Fiber itself needs from a human goes through the contract. A
medium-specific surface may only add capability a client is free not to
offer.**

v0.0.1 ships one closed, versioned set of interactions — approval, confirm,
select, text input, status — carried on the same request events the loop uses
to ask a human anything, and answerable by any connected client including a
headless one. A medium-specific drawing surface, letting an extension take
the terminal or a future GUI's canvas directly, is a named future; whether
v0.0.1 includes it is not yet ruled, and its shape is settled after
[issue #11](https://github.com/aakshintala/fiber/issues/11).

What an approval actually asks about, and what answers it when nobody is at
the keyboard, is `docs/permissions.md`.

## Concurrency

Settled by
[The threading and streaming model](https://github.com/aakshintala/fiber/issues/9);
the rationale and the rejected runtimes are
[ADR 0004](adr/0004-blocking-threads-no-async-runtime.md).

### What a thread is here, and what owning means

A thread is a worker inside the Fiber process. It does one thing at a time and
parks — asleep, costing nothing — until something wakes it. Fiber needs
several because some work blocks: reading a model's answer off the network
takes twenty seconds, and nothing else can happen on that worker meanwhile.

**Owning** a piece of state means exactly one worker may touch it, and
everyone else asks that worker. It is the whole of Fiber's concurrency
discipline: the rules below say who owns what, and nothing else is shared.

Fiber uses blocking threads and no async runtime.

### The threads

| Thread | Owns | Lives |
|---|---|---|
| loop | the turn: what happens next, and every durable event | the process |
| terminal input | the keyboard | the process, when a terminal is attached |
| terminal render | the screen | the process, when a terminal is attached |
| driver input | a door's stdin | the process, on a non-interactive door |
| one per running tool call | that call's subprocess and its output | the call |

`log` is not a thread. It is a shared object behind a lock: whoever emits an
event calls it, and it mints `seq`, writes, fsyncs and fans out.

Background jobs, child sessions and MCP servers each add one parked thread per
blocking pipe. That is affordable: 512 parked threads measured 11.6 MiB RSS
and 0.35 ms of CPU over ten seconds on macOS arm64.

### One inbox

Everything that wants the loop's attention sends to one queue: a driver's
commands, a finished tool call, news from a background job. The loop blocks on
that queue when it is idle, which is why an idle Fiber costs nothing.

The loop drains the queue **at step boundaries** — between one round-trip to
the model and the next. It does not drain it while a model response is
streaming, and it does not need to: cancellation does not travel through the
queue, and a steering message applies at the next step boundary anyway.

### Streaming

The loop reads the model's response itself, on its own thread, blocking. There
is no separate reader thread and no parser task: during a model response the
loop has nothing else to decide.

As fragments arrive it emits them as ephemeral events and keeps reading.
Watchers receive events on bounded channels. **When a watcher falls behind,
ephemeral events are dropped and durable ones are not** — a lagging watcher
re-reads what it missed from the log by `seq`, which `docs/events.md` already
guarantees is possible. The loop never blocks on a watcher, so a slow screen
cannot stall a turn.

**Only the loop thread emits durable events.** Any thread may emit ephemeral
ones through an emitter handle defined in `contract`. This keeps `seq` minted
in one place and keeps the fsync ordering rule in `docs/events.md` — two
fsyncs bracketing each side effect — a property of one thread's sequence of
calls rather than of a race.

### Tool calls in a step

A step may request several tool calls. **Permission decisions are made in
order, before any of them runs**, so `ask` mode never raises four prompts at
once and the reviewer is never asked about a call whose sibling has already
changed the workspace. Once they are all decided, they **run concurrently**,
one thread each, and their results are returned to the model in the order the
model asked for them.

Two tools writing the same file at the same time is the hazard this creates.
`tools` owns a per-path lock that its file-mutating built-ins take, and that is
available to an extension's tool. It is offered, not enforced: an extension
runs with the account's full rights, so an extension that skips it corrupts
its own writes and nothing else, exactly as `docs/permissions.md` already
accepts for misdeclared effects.

### Cancellation

Fiber owns the socket its model requests run on. The HTTP client is ureq
behind a custom connector that keeps the `TcpStream` handle, so a second
thread can close the socket and unblock a read that is stuck inside the
client — measured at 211 µs on macOS arm64.

One press of the cancel key ends the **turn**:

- the model stream stops,
- any in-flight tool call completes as `cancelled`,
- the turn ends with `turn_completed { outcome: interrupted }`,
- background jobs keep running, because a job outlives the turn that started
  it.

What the log shows afterwards follows from `docs/events.md` and adds nothing
new: the cancelled calls carry `status: cancelled`, there is no
`assistant_message_completed` for the interrupted response, and the partial
text is gone, because deltas are ephemeral. It is on screen for the rest of
the session and absent after a resume.

A cancelled turn always writes `turn_completed`. A `turn_started` with no
`turn_completed` therefore means the process died, not that someone pressed
escape.

### Steering

A message typed while a turn is running reaches the loop immediately and is
applied at the next step boundary: after the current tool calls finish, before
the next model call. It is a durable event, so the log shows exactly what the
turn received. A message that a turn ends before applying becomes the next
turn's input rather than being dropped.

### Both front doors

The threading is identical on the non-interactive door, as map premise 6
requires. The render and terminal-input threads are replaced by a stdin reader
that is a driver and a stdout writer that is a watcher; the loop, the inbox,
the streaming, the cancellation and the tool-call scheduling are the same code.
A door has no privilege the terminal lacks, and neither has a path to state
that the other does not.

## Not settled here

- The extension runtime: [Extension runtime: Lua or something else?](https://github.com/aakshintala/fiber/issues/11)
- Confinement: [Does Fiber confine what tools can touch?](https://github.com/aakshintala/fiber/issues/30)
- The tool set: [The tool contract: what every tool shares](https://github.com/aakshintala/fiber/issues/14)
- Background jobs: [Background jobs: one killable object](https://github.com/aakshintala/fiber/issues/20)
- Subagents: [Subagents and delegates: children on one stream](https://github.com/aakshintala/fiber/issues/21)
- MCP: [Does v0.0.1 speak MCP, and as what?](https://github.com/aakshintala/fiber/issues/22)
- Compaction: [Compaction: when a session outgrows its context](https://github.com/aakshintala/fiber/issues/24)
