# The modules

The modules Fiber is made of, and the rules about which may call which. This is
what is true now, not a plan. It is settled by
[What modules exist, and who may call whom?](https://github.com/aakshintala/fiber/issues/7);
that ticket's resolution holds the rationale and the rejected alternatives.

Vocabulary is `CONTEXT.md`. Watcher, driver, participant, seam, hook, session,
turn, event and tool call mean what it says there and nothing else.

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
| `config` | Reads the configuration directory. Answers questions; never asks any. |
| `doors` | The non-interactive front door: argv in, JSON lines out. Which doors exist is [Front doors: which invocation modes does v0.0.1 have?](https://github.com/aakshintala/fiber/issues/10); this page only fixes that a door sits beside the TUI with no privilege the TUI lacks. |
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
   archived Zig tree on 2026-09-13 found about 211 string literals naming
   built-in tools inside `src/core/` production code, plus a core enum listing
   every built-in by name
   ([Core reasons about tool kinds, not builtin names](https://github.com/aakshintala/fiber-zig/issues/138)).
5. Only `config` reads the configuration directory. `main` distributes what it
   returns.
6. `main` holds no feature logic.

## The three seams

### Tool seam

"run this and give me a result." Fiber's own built-in tools are compiled in
and register through this seam exactly as an extension's would. An extension
registering the same name replaces the built-in, and **the replacement is
recorded in the session log**, so a headless caller, a resumed session and an
audit all see it. The loop asks the registry for a name and runs what comes
back; it never learns whether the answer was Fiber's or an extension's.

### Provider seam

"send this to a model and stream back actions."

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
the terminal or a future GUI's canvas directly, is a named future and is out
of v0.0.1 scope; its shape is settled after
[issue #11](https://github.com/aakshintala/fiber/issues/11).

## Not settled here

- How are these boundaries enforced — separate crates the compiler checks, or
  one crate with module privacy and a CI lint? That is still open, pending a
  measurement of whether a cargo workspace materially scopes builds and tests.
- Threading and streaming: [The threading and streaming model](https://github.com/aakshintala/fiber/issues/9)
- Which front doors exist: [Front doors: which invocation modes does v0.0.1 have?](https://github.com/aakshintala/fiber/issues/10)
- The extension runtime: [Extension runtime: Lua or something else?](https://github.com/aakshintala/fiber/issues/11)
- Provider routing: [Provider and model routing](https://github.com/aakshintala/fiber/issues/12)
- Permissions: [Permissions and approvals, attended and headless](https://github.com/aakshintala/fiber/issues/13)
- The tool set: [The v0.0.1 tool set](https://github.com/aakshintala/fiber/issues/14)
- Background jobs: [Background jobs: one killable object](https://github.com/aakshintala/fiber/issues/20)
- Subagents: [Subagents and delegates: children on one stream](https://github.com/aakshintala/fiber/issues/21)
- MCP: [Does v0.0.1 speak MCP, and as what?](https://github.com/aakshintala/fiber/issues/22)
- The state directory: [The state directory: what Fiber writes, and where](https://github.com/aakshintala/fiber/issues/23)
- Compaction: [Compaction: when a session outgrows its context](https://github.com/aakshintala/fiber/issues/24)
