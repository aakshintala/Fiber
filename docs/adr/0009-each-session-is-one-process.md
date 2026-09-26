# 9. Each session is one process; the daemon holds none

Date: 2026-09-24

## Status

Accepted. Settled by
[Process architecture: core, TUI and shared services](https://github.com/aakshintala/fiber/issues/81).
The contract is `docs/invocation.md` ("Processes"). What pi, codex, opencode
and Claude Code do is `research/process-architecture/README.md`. The memory
figures are `research/delegate-memory/README.md`.

## Context

A web or mobile client must be able to attach to a session on the host and
start a new one, with no terminal open. Something must therefore listen while
no session runs.

The owner runs several top-level sessions at once. Across their Claude Code
and pi logs, top-level sessions active in the same 10 minutes are p50 1, p90 3,
p99 4, max 8, and 12.7% of active windows have 3 or more.

codex runs every session inside one host-wide daemon that its TUI starts
automatically. Its `codex app-server daemon update` "may interrupt work".
Claude Code runs one process per session and a separate `remote-control`
server started by hand. opencode runs its server and TUI as two threads of one
process. None of the four runs a sub-agent as its own process.

A delegate costs about 2 MiB as threads and 8 to 9.5 MiB as its own process:
about 7 MiB more per delegate, or about 56 MiB at the owner's measured peak of
8. Each of the owner's MCP servers costs 43 to 93 MiB.

## Decision

- Every session is one `fiber serve` process, a delegate included. A Fiber
  delegate is a child `fiber serve` of its parent, driven over the pipe it was
  spawned with, exactly as a delegate running another harness is.
- The root's process owns the tree's MCP servers. A delegate reaches them
  through its parent: it raises the call on its event stream and its parent
  answers with the result (`docs/mcp.md`, "Where servers run").
- The terminal UI is its own process, client zero of the `fiber serve` it
  spawns, over that process's stdin and stdout.
- Every running session listens on a local socket for further clients.
- `fiber remote` is an optional daemon for remote clients. It starts and
  resumes `fiber serve` processes and relays clients to them. It holds no
  session.
- Fiber ships no relay service. The person brings the network.

## Consequences

- One process is one session: one log, one lock, one socket, one set of
  extension VMs. Nothing in the process has to ask which session it is in.
- The Fiber harness has the same shape as every other harness: a child
  process with a prompt in and an event stream out.
- Stopping a delegate is a signal to its process group, which always works.
  A crash in C code (Lua, ring), an out-of-memory kill or a panic ends one
  delegate and nothing else.
- `fiber upgrade` can restart `fiber remote` without stopping any session.
  A running session keeps its binary until it exits.
- A TUI crash, or a TUI extension's error, cannot interrupt a session's work.
  The session then follows the lifecycle rule like any session without a
  client.
- The TUI can use only what the pipe and the socket carry, so premise 5 holds
  by construction.
- Separate session trees share nothing in memory. Each pays for its own MCP
  servers and model catalog.
- A stdio MCP server's elicitation carries no link to the call that raised it,
  so one shared by several sessions of a tree cannot always be attributed
  (`docs/mcp.md`, "Elicitation, sampling and roots"). Threads would not have
  changed this.

## Rejected

A delegate as threads in its root's process. It saves about 7 MiB per
delegate, less than one MCP server at the measured peak. It makes
`fiber serve` a multi-session process: several loops, logs, locks and sockets
in one process, a model catalog and an MCP client called from several loops at
once, a Lua VM per extension per session in one process, and a stop that is a
flag native code need never check. A crash in C code or an out-of-memory kill
would end every session in the tree, and a delegate stuck in native code could
not be stopped without ending the tree, which
[Shutdown](https://github.com/aakshintala/fiber/issues/34) forbids. It would
also make the Fiber harness a different shape from every other harness.

A daemon that runs every session, as codex does. It gives one address for
every client, cheap sessions as threads, and MCP sharing across the whole
host. Restarting it for an upgrade stops every model stream and child process
in every session, and one crash ends every session on the host.

Sharing MCP servers across session trees through the daemon. It would save
about 80 to 100 MiB per extra concurrent session, but only in about 1 active
window in 8. It adds five costs: elicitations that cannot be attributed across
sessions, a reload that needs a private instance, a daemon restart that
restarts servers under running sessions, a daemon crash that removes MCP from
every session, and a second code path for sessions started without the daemon.
Sharing can be added later without changing the tool contract: the relay a
delegate uses is the mechanism.

A hosted relay, as Claude Code's Remote Control uses. It works from any
network with nothing installed on the phone. Fiber would have to run the
service, and without end-to-end encryption it would see every event and
command.

The TUI in the session's process, as Claude Code and pi do. It is one process
with fewer parts. A TUI crash or a TUI extension's error would end the session.

The TUI attaching to its own session over the socket rather than the pipe. It
would need the TUI to wait for the socket to appear, and the session to know
it was started without a stdin driver. The pipe is there at spawn and carries
the same bytes.
