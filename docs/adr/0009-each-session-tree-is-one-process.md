# 9. Each session tree is one process; the daemon holds none

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

A delegate costs about 2 MiB as threads and 8 to 9.5 MiB as its own process.
Each of the owner's MCP servers costs 43 to 93 MiB.

## Decision

- A session tree, meaning a top-level session and its delegates, is one
  `fiber serve` process. Delegates are threads in it. The root's process owns
  the tree's MCP servers.
- The terminal UI is its own process, a client of a `fiber serve` session over
  that session's local socket.
- `fiber remote` is an optional daemon for remote clients. It starts and
  resumes `fiber serve` processes and relays clients to them. It holds no
  session.
- Fiber ships no relay service. The person brings the network.

## Consequences

- `fiber upgrade` can restart `fiber remote` without stopping any session.
  A running session keeps its binary until it exits.
- A crash in C code (Lua, SQLite) ends the whole tree it happens in, and no
  other tree.
- A TUI crash, or a TUI extension's error, cannot end a session.
- The TUI can use only what the socket carries, so premise 5 holds by
  construction.
- Separate session trees share nothing in memory. Each pays for its own MCP
  servers and model catalog.
- A stdio MCP server's elicitation carries no link to the call that raised it,
  so one shared by several sessions of a tree cannot always be attributed
  (`docs/mcp.md`, "Elicitation, sampling and roots").

## Rejected

A daemon that runs every session, as codex does. It gives one address for
every client, cheap sessions as threads, and MCP sharing across the whole
host. Restarting it for an upgrade stops every model stream and child process
in every session, and one crash ends every session on the host.

A delegate as its own process. A crash in C code would stay in one delegate,
and a stop would be a signal to a process group, which always works. It costs
4 to 5 times the memory of threads, and the delegate would need a proxy to
reach the root's MCP servers.

Sharing MCP servers across session trees through the daemon. It would save
about 80 to 100 MiB per extra concurrent session, but only in about 1 active
window in 8. It adds five costs: elicitations that cannot be attributed across
sessions, a reload that needs a private instance, a daemon restart that
restarts servers under running sessions, a daemon crash that removes MCP from
every session, and a second code path for sessions started without the daemon.
Sharing can be added later without changing the tool contract.

A hosted relay, as Claude Code's Remote Control uses. It works from any
network with nothing installed on the phone. Fiber would have to run the
service, and without end-to-end encryption it would see every event and
command.

The TUI in the session's process, as Claude Code and pi do. It is one process
with fewer parts. A TUI crash or a TUI extension's error would end the session.
