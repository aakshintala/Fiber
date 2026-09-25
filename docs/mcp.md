# MCP

How Fiber uses MCP servers: what it starts, what the model sees, how a call is
judged, and what happens when a server fails. It is settled by
[MCP client](https://github.com/aakshintala/fiber/issues/22); the reasoning and
the rejected alternatives are
[ADR 0008](adr/0008-the-mcp-client-is-built-in.md). What pi, codex and Claude
Code do is in `research/mcp-client/`.

Vocabulary is `CONTEXT.md`. MCP server, tool call, effect, workspace, driver,
driver command, session and event mean what it says there and nothing else.

## What Fiber does with MCP

Fiber is an MCP client. The client is built into the binary, as the wire
protocols in `docs/model-routing.md` are. Fiber serves no MCP
([ADR 0005](adr/0005-no-mcp-server-the-supervisor-is-external.md)).

Fiber speaks two transports:

- stdio, for a server Fiber starts as a child process
- streamable HTTP, for a remote server

It has no legacy HTTP with server-sent events (HTTP+SSE). codex has none
either.

A remote server that needs OAuth uses a native flow. `docs/model-routing.md`
says of providers: "OAuth flows are native, like protocols." A person logs in to
a server with `fiber mcp login <server>`. Token refresh follows the provider
rule in `docs/model-routing.md`. A headless start with no valid token counts as
the server failing to start (see [Starting servers](#starting-servers)).

## Tools and their names

Each tool a server offers becomes a Fiber tool named `mcp__<server>__<tool>`,
the convention codex and Claude Code both use. A name longer than a protocol
allows is cut short and given a short hash suffix, so two long names stay
distinct.

MCP tools register through the tool seam like any built-in
(`docs/architecture.md`, "Tool seam"). The seam's rule applies unchanged:
registering an existing name replaces it, and the replacement is recorded in the
session log. An extension can replace any MCP tool, or `mcp_resources`, by
registering its name.

The tool set is fixed at the session's first request. A resumed session lists
its servers' tools again and fixes its tool set at its own first request. Tools
are sorted by name, with every schema's keys sorted (`docs/prompt-cache.md`,
"Bytes"), and only [reload](#reload) changes the set. Changing tool definitions
mid-session misses the whole prompt cache.

### Deferred tools

A protocol with native deferral declares MCP tools deferred by default: the
model sees each tool's name and loads its full definition when it needs it.
Anthropic's `defer_loading` is the only one. Every other protocol declares every
tool in full; OpenAI's `allowed_tools` restricts calls but still sends each
definition. A server can be
marked eager, so its tools are always declared in full.

Why deferral keeps the cache is `docs/prompt-cache.md`. Which tools the
model sees in general is
[Which tools the model sees, and when](https://github.com/aakshintala/fiber/issues/51).

## Effects

An MCP tool's effects come from the hints its server declares for it, in the
vocabulary of `docs/permissions.md`:

| Hint | Effect |
|---|---|
| `readOnlyHint` true | `reads`, reversible |
| `destructiveHint` true | `writes`, irreversible |
| `destructiveHint` false | `writes`, reversible |
| `openWorldHint` true, or absent | adds `network` |
| any remote (HTTP) server | adds `network` |
| neither `readOnlyHint` nor `destructiveHint` | `executes`, irreversible |

A tool with no hints at all therefore declares `executes` and `network`,
irreversible, so `auto` sends every call to it to the reviewer. Configuration
can override any tool's hints.

The hints are believed, on the same grounds as an extension's declarations. The
person installed the server, and `docs/permissions.md` says of extensions: "An
extension runs with the account's full rights, so misdeclaring buys it nothing
it could not do directly."

MCP hints are per tool, not per call. That is weaker than `docs/permissions.md`
asks: "Classification is per call, not per tool." MCP offers nothing per call,
so Fiber cannot do better. Every call to one MCP tool declares the same effects,
whatever its arguments.

An MCP tool declares no paths. A `reads` call takes the permission fast path. A
`writes` call never does, because the workspace fast path needs paths inside
the workspace. The credential deny (`docs/permissions.md`, "Credentials") cannot
see what an MCP tool touches, as it cannot for a shell command it does not
recognize.

## Prompts and resources

A server's prompts become prompt templates. How a person invokes a prompt
template is not yet specified: `docs/extensions.md` says "What a skill, a prompt
template and a theme are to Fiber is not yet specified."

A server's resources are reached through one tool, `mcp_resources`, with two
actions:

- `list`, which lists the resources a server offers
- `read`, which reads one resource

`mcp_resources` is declared only when at least one configured server offers
resources. Its effect is `reads`, plus `network` for a remote server.

## Calls

Each call has a timeout, 10 minutes by default, the same as the shell's
`timeout_ms` (`docs/tools.md`, "Timeout"). Configuration can change it per
server. A call that times out ends `failed` with code `timeout`.

Cancelling a turn sends MCP's `notifications/cancelled` for each call in
flight and stops waiting. The call ends `failed` with code
`mcp_cancel_requested`: Fiber asked the server to stop, and the server may still
act. MCP says a server receiving that notice should not respond, so Fiber never
learns whether the server stopped, and the call is never `cancelled`
(`docs/tools.md`, "Cancellation").

A result goes through the tool contract in `docs/tools.md`:

- text goes to `content`
- an image goes to `content` as an image part, written to `artifacts/`
- the 16 KiB cap applies, and a cut result keeps its full bytes in an artifact
- a result the server marks as an error ends `failed` with code `tool_error`

## Starting servers

Every configured server starts when the session starts. The first request to the
model waits until each server has listed its tools or reached its startup
deadline. The deadline is 5 seconds by default, and configuration can change it
per server. A person can type while servers connect.

A server that misses its deadline, or fails to start, leaves its tools out for
the whole session. The session log records which server and why, as the durable
event `mcp_server_failed` (`docs/events.md`). A server marked
`required` makes that failure fatal instead: the session does not start, and a
headless run exits with code 1 and error code `mcp_required_server_failed`.

The 5-second deadline:

- The MCP specification sets no number. It says only "Implementations SHOULD
  establish timeouts for all sent requests".
- codex and Claude Code wait 30 seconds.
- The owner's three local servers took 82 to 105 ms median, 143 ms at most,
  from launch to their tool list (macOS arm64, `research/mcp-client/`).
- 5 seconds is Claude Code's connect timeout.
- A cold `npx -y` start or a slow OAuth exchange can miss it. That server's
  configuration raises it.

A stdio server starts in the session's workspace.

Each server pipe takes one parked thread, as `docs/architecture.md` ("The
threads") already budgets.

## When a server dies

A server that dies mid-session is restarted once, on the next call to one of its
tools. Each death is recorded as `mcp_server_failed`. If it dies again, it
stays dead for the rest of the session. Its tools
stay declared, so the prompt cache holds, and every call to them fails with code
`mcp_server_unavailable`.

A server's notice that its tool list changed is ignored until reload. A tool the
server removed fails with code `mcp_tool_removed`. A tool the server added is
not declared.

## Reload

`reload` is a driver command (`docs/invocation.md`). The terminal and every
driver have it, because `docs/architecture.md` gives the terminal no privilege
a second client lacks.

Reload:

1. Re-reads configuration.
2. Keeps unchanged, healthy servers connected.
3. Restarts changed servers and servers that died.
4. Reloads extensions (`docs/extensions.md`).
5. Declares the new tool set.

It costs one prompt-cache miss. The log records it as the durable event
`reloaded` (`docs/events.md`).

## Elicitation, sampling and roots

A server can ask the person a question in the middle of a call. This is MCP
elicitation, and Fiber answers it. An elicitation is an interaction like any
other: Fiber raises it on the event stream as one of the interactions
`docs/architecture.md` already names, and any driver answers it with `reply`.

Fiber advertises form elicitation. The server sends a form of typed fields.
Fiber asks each field in turn:

| Field type | Interaction |
|---|---|
| boolean | confirm |
| enum | select |
| string, number or integer | text input |

When no answer is possible, Fiber declines, which is a response MCP defines.
That is the same case as an escalation's block (`docs/permissions.md`,
"Headless"): a session started by `fiber ask`, or one that has been sent
`close`. Otherwise a pending elicitation waits for a client within the call's
timeout ("Calls"); an elicitation does not extend it. An elicitation from a delegate is relayed up the tree like a
delegate's escalation (`docs/permissions.md`, "Delegates").

On stdio, an elicitation carries nothing that links it to the call that raised
it: the MCP TypeScript SDK 1.29.0 passes `relatedRequestId` to its transport
(`shared/protocol.js:337`), and the stdio transport's `send(message)` drops it
(`server/stdio.js:63`). A tree's sessions share its servers ("Where servers
run"), so when a server with calls in flight from more than one session
elicits, Fiber cannot tell whose call raised it. Then the elicitation goes to
whoever drives the root, labelled with the server's name, and the root's log
records it with the `action_id` of every call in flight on that server. With
one session's calls in flight, it is that session's.

Fiber does not advertise sampling and does not answer a sampling request.
Neither codex nor Claude Code advertises it.

Fiber does not advertise roots. codex advertises none; Claude Code does.

## A repository's servers

A server declared in a repository's configuration runs a program, so it needs
the same approval as an extension a repository brings (`docs/extensions.md`,
"Extensions a repository brings"). The approval covers the server's exact
declaration: a changed declaration needs a new approval. A headless run fails
with `mcp_server_unapproved` if a repository declares a server nobody has
approved. `fiber approve` records the approval from a terminal.

The approval covers what the declaration says to run, not the program itself. A
declaration that fetches its program at start, such as `npx -y`, can run
different code later under the same approval.

## Error codes

| Code | Meaning |
|---|---|
| `mcp_server_unavailable` | a call to a server that failed to start or died |
| `mcp_tool_removed` | a call to a tool the server has since removed |
| `mcp_cancel_requested` | a cancelled turn asked the server to stop a call, and the server may still act |
| `mcp_required_server_failed` | a server marked `required` failed to start |
| `mcp_server_unapproved` | a repository declares a server nobody has approved |

## Configuration

Each server has:

- a command, arguments and environment, for a stdio server
- a URL, for a remote server
- `required`
- a startup deadline
- a call timeout
- whether it is eager
- per-tool hint overrides
- which tools are enabled and which are disabled

The file format belongs to Configuration, which is not yet specified.

## Where servers run

Every session is one process ([ADR 0009](adr/0009-each-session-is-one-process.md)),
and the root's process owns the tree's servers. A delegate starts none. It
gets their tool definitions from its parent as the driver command `mcp_tools`
before its first prompt, and runs a call by raising `mcp_call_requested` on
its event stream, which its parent answers with `mcp_result`
(`docs/invocation.md`, `docs/events.md`). A parent that is itself a delegate
passes both up. This is the request-and-reply shape the loop already uses to
ask a human anything, with the parent as the answerer. Separate trees share
none: each top-level session starts its own.

- The tool set is still fixed per session. A delegate's first request declares
  the tree's server tools as `mcp_tools` gave them.
- A server whose behavior depends on the folder it started in serves every
  session in the tree, including a delegate in a worktree, as the root started
  it. A call that names no path acts in the root's workspace, not the
  delegate's. The owner's cursor-delegate server is one: a call works
  in the server's own directory unless it passes `isolation: CallerProvided`
  with a path.
- Each of the owner's servers takes 43 to 93 MiB
  (`research/delegate-memory/README.md`, "MCP servers"), once per tree.

## Not settled here

- How a person invokes a prompt template
- Where a server's OAuth token is stored
- How MCP content other than text and images, such as audio and resource
  links, reaches the model
- The configuration file format: Configuration
