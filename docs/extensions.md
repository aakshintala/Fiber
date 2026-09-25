# Extensions

What is true now about Fiber's extension system. Vocabulary is `CONTEXT.md`.
The seams are `docs/architecture.md`; the runtime choice and its reasoning are
[ADR 0006](adr/0006-extension-runtime-lua.md); the trust model is
`docs/permissions.md`. The measurements behind all of it are in
`research/extension-runtime/`.

## What an extension is

An extension is a package Fiber installs and loads. Its code runs with the
account's full rights. It registers capabilities through the same three seams a
built-in uses — tool, provider and hook — and a registration by an existing
name replaces the built-in, recorded in the session log. An extension that registers a tool named
`read` becomes the `read` tool; the loop never learns whether the answer came
from Fiber or from the extension.

The script does its work synchronously and returns. There is no background
execution, no event loop, no `async`. This follows
[ADR 0004](adr/0004-blocking-threads-no-async-runtime.md): a hook answers inside
the turn, under a timeout Fiber enforces.

## What a package holds

An extension is one directory. Its manifest states:

- its name, which is also where it is fetched from (see [Names](#names))
- its version
- the lowest Fiber version it runs on
- the other extensions it depends on, each with a minimum version
- the native binaries it ships, if any, with one download URL and one sha256
  per platform

Beside the manifest it may hold:

- data, such as a provider's models and flags
- Lua scripts, as many as it needs
- libraries it vendors: a copy of someone else's Lua code, kept inside the
  extension's own directory
- skills, prompt templates and themes

What a skill, a prompt template and a theme are to Fiber is not yet specified.
This page covers only how they arrive.

A script loads another script with `require`. `require` finds files inside the
extension's own directory and nowhere else, so one extension cannot load
another's code by path. Code shared between extensions reaches an extension in
one of two ways: the extension vendors a copy, or it depends on the extension
that holds the code.

A native binary never runs from Lua directly. The extension runs it through a
host call, and the tool making that call declares the `executes` effect, so the
permission decision in `docs/permissions.md` sees it like any other command.
That host call is not yet specified.

## The runtime

Extensions are written in **Lua 5.4**, embedded through `mlua` (vendored, so
Fiber's build compiles Lua's C itself and takes no system dependency). The
choice and the alternatives weighed — JavaScript via QuickJS, Luau, Starlark,
WASM, and full TypeScript — are in [ADR 0006](adr/0006-extension-runtime-lua.md).

The embedding is bare. An extension sees a stripped standard library — `table`,
`string`, `math`, `utf8`, `coroutine` — plus a `require` limited to its own
directory, and nothing else. There is no `io`, no `os`, no `package`, no
`debug`. It cannot open a file, make a socket,
read an environment variable, or spawn a process on its own. Every capability
reaches it through a host-provided global.

This is not a security boundary. Per `docs/permissions.md`, an extension runs
with the account's full rights; the stripped stdlib is a structural fact — the
host owns I/O — not a sandbox. A hostile extension is contained the way `npm
install` is contained: not at all at runtime, only by the decision to install
it. Trust is resolved when an extension is installed or approved, not while
it runs. How that works is [Distribution](#distribution).

## What an extension can do

Everything an extension touches outside pure computation goes through two
globals the host installs: `host` for capabilities, `fiber` for registration.

```
host.secret(name)              -- the configured secret string for `name`
host.http(opts)                -- one blocking HTTP request; returns { status, body }
host.log(msg)                  -- write a debug line
json.decode(str) / json.encode(value)   -- JSON, host-provided (Lua has none built in)
```

```
fiber.tool(name, { description, input_schema, run })
fiber.provider(name, { models })
fiber.hook(point, { on_failure, timeout, run })
```

An extension can make HTTP requests, read declared secrets, hold state across
calls (in its own Lua globals), and register any number of tools, providers and
hooks. It cannot reach the filesystem, network sockets, environment or other
processes except through `host`, because the embedding gives it no other way.

## What writing a provider looks like

A provider extension is mostly data: its name, how its credential is found, and
its models, each with a protocol, a base URL, flags and metadata. The wire
protocols are native Rust, so a provider never parses a stream. What a provider
declares, and why, is `docs/model-routing.md`. The file format for that data is
settled with configuration.

The one piece of Lua a provider may have is a function that discovers its
models. Here is one for a gateway that lists its models at `/models`:

```lua
fiber.provider("acme", {
  models = function()
    local key = host.secret("acme.api_key")
    local reply = host.http({
      url = "https://api.acme.dev/v1/models",
      headers = { authorization = "Bearer " .. key },
    })
    local list = {}
    for _, m in ipairs(json.decode(reply.body).data) do
      table.insert(list, {
        id = m.id,
        protocol = m.id:find("^claude") and "anthropic-messages" or "openai-completions",
        base_url = "https://api.acme.dev/v1",
        context_window = m.context_length,
      })
    end
    return list
  end,
})
```

In plain terms: Fiber calls `models` when it needs the model list. The function
fetches the API key, asks the gateway for its models, and returns one entry per
model, choosing each model's protocol from its name. Fiber caches the list on
disk and refreshes it in the background at startup. The function never runs
while a request is being sent.

Writing a tool or a hook has the same shape: register a name, receive a call, do
pure work plus host calls, return. The hook points are [Hooks](#hooks).

## Hooks

A hook is asked at a fixed point in a session and may change what happens
there. Fiber has seven hook points. Each one runs before the thing it changes
is written to the session log or sent to the model, never after. That one rule
keeps two settled promises: the log holds exactly what happened
([ADR 0001](adr/0001-session-log-is-the-only-state-of-record.md)), and no hook
rewrites a message the model has already been sent (`docs/prompt-cache.md`,
"Rules for other areas").

A hook only changes things. Something that only needs to know what happened,
such as a job that writes a worklog when a session ends, is a watcher: it reads
the event stream (`docs/events.md`) and has no hook point. How an extension
watches is
[Extension watchers](https://github.com/aakshintala/fiber/issues/101).

### The hook points

| Hook point | When it runs | What the hook sees | What it may return |
|---|---|---|---|
| `session_start` | A session starts, resumes, forks or rewinds, before the first model request | why it started, the session's id and workspace root | context to add |
| `before_message` | A person's or a driver's message arrives, as a turn's input or as steering, before it is logged | the message's text and images | a replacement message, a refusal with a reason, context to add |
| `turn_start` | A turn has started, before its first model request | the turn's input and what started it | context to add |
| `before_tool` | A call has passed its schema check and its effects function, before permission is decided | the tool's name, the arguments, the declared effects, paths and reversibility | replacement arguments, a refusal with a reason |
| `after_tool` | A call that ran has returned, before its output is cut, its artifact is written or it is logged | the tool's name, the arguments, `status`, the full output, `details`, `process` | replacement `content`, replacement `details`, text for the artifact |
| `turn_end` | The model has replied without calling a tool, so the turn would complete, before `turn_completed` is written | the model's final reply | a message to continue the turn with |
| `before_handoff` | A handoff has started, before the note request | the trigger, the person's instructions, and the conversation as the model would be sent it | a handoff note |

Returning nothing leaves things as they were.

**Context** a hook adds is appended to the conversation as its own message and
logged as `context_added`, naming the extension. An extension that delivers an
inbox of messages from other agents does it this way, at `session_start` or
`turn_start`. `session_start` runs again on every resume, and each time its
context is appended again. The hook sees why the session started, so an
extension that must not repeat itself adds only what is new.

**`before_message`** covers every message a person or a driver sends, so a
secret pasted into a prompt can be removed before anything records it. A
refused message is neither logged nor sent, and the sender is told why.

**`before_tool`** may rewrite a call or refuse it, but never approve one.
Approval is the permission decision's (`docs/permissions.md`), and a mode is
never changed by an extension. Fiber checks rewritten arguments against the
tool's schema and runs its effects function again, so the permission decision
judges the call that will run, not the one the model asked for. A refused call
completes `denied` with reason `hook` and the extension's name, and never
starts.

The model's call is sent back to it exactly as the model wrote it. What ran is
stated in the result instead: Fiber begins the result's `content` with a line
naming the extension and giving the arguments that ran. That line is part of
`content`, so the tool's size cap applies to it. Editing the model's own call
would tell the model it asked for something it did not, and a provider that
signs the reasoning before a call may reject the edited request.

**`after_tool`** runs on every call that ran: `completed`, `failed` and
`cancelled` alike, since a cancelled command's partial output can hold a
secret too. It does not run on a call that never started. What the hook
returns is what the rest of the pipeline sees: the size cap applies to the
returned `content` (`docs/tools.md`, "Bounded results"), and the artifact holds
the hook's artifact text when it returns one, or the returned output when it
does not. So a redaction hook removes a secret from the model's view and from
disk in one pass, and the original output is never stored. An extension that
compacts build and test output returns a short summary as `content` and the
full log as the artifact text. The hook cannot change `status`: whether a call
succeeded is the tool's answer.

**`turn_end`** runs only when a turn would complete normally, not when it is
cancelled or fails. A returned message joins the turn at the step boundary as a
steering message would, and is logged as `steering_applied` with the extension
as its source. The model then takes another step, and `turn_end` runs again
when that step ends without a tool call. Fiber puts no limit on how often a
hook continues a turn. An extension that does this should keep its own limit,
and a person can always end the turn with the cancel key. A goal that keeps the
agent working until a condition is met is built on this point.

**`before_handoff`** lets an extension write the handoff note instead of the
session's own model. When a hook returns a note, Fiber makes no note request.
When none does, Fiber makes its own (`docs/handoff.md`, "The handoff note").

### When several hooks share a point

Hooks at the same point run one after another. Configuration can set the
order of extensions at each hook point. Extensions it does not name run after
those it does, ordered by name, and one extension's hooks at the same point run
in the order it registered them. Each hook sees what the one before it
returned. A refusal ends the chain. The order is fixed so that the same inputs
give the same result on every run.

### When a hook fails

Every hook declares two things when it registers, and neither has a default.
A hook that leaves either out is not registered.

- `timeout`: how long it may run. Its author knows whether it only computes or
  calls a web service or a model. Configuration can override the timeout for
  any extension. A hook past its timeout is stopped ("When an extension
  misbehaves") and has failed.
- `on_failure`: `blocking` or `non-blocking`.

- **`non-blocking`**: if the hook errors or runs out of time, Fiber drops its
  change, carries on as if it had returned nothing, and gives a `notice` naming
  the extension. A formatter is `non-blocking`.
- **`blocking`**: if the hook errors or runs out of time, the thing it guards
  does not happen. A secret scanner is `blocking`, because carrying on without
  it would send the secret.

What a `blocking` failure stops, at each point:

| Hook point | What happens |
|---|---|
| `session_start` | The session does not start. Fiber exits with error `hook_failed`, naming the extension. |
| `before_message` | The message is neither logged nor sent, and the sender gets `hook_failed`. |
| `turn_start` | The turn completes `failed` with code `hook_failed`, before any model request. |
| `before_tool` | The call completes `failed` with code `hook_failed` and never starts. |
| `after_tool` | The call keeps the status the tool reported, since it ran. Its only content is a line saying its output was withheld because the extension's hook failed, and no artifact is written. |
| `turn_end` | The turn completes `failed` with code `hook_failed`. |
| `before_handoff` | The handoff completes `failed` with code `hook_failed`, as a failed note request does. |

### What a hook cannot do

- Change a message the model has already been sent, the system prompt or the
  tool definitions.
- Approve a tool call, or change a call's `status`.
- Run during a shutdown. When a signal stops Fiber, no hook runs
  (`docs/invocation.md`, "Shutdown").

### Recording a change

The log holds what a hook returned, never what it was given. Each line a hook
changed names the extensions that changed it in `changed_by`, so a reader can
see that a message or result was rewritten and by whom (`docs/events.md`).

Handing a value to a hook and taking its answer back is cheap next to the
hook's own work. A 16 KiB tool result crosses into Lua and back in under
10 µs, and a 1 MiB one in about 50 µs (macOS arm64,
[research/hook-conversion-cost](../research/hook-conversion-cost/README.md)).

## Loading, and cost when nothing is loaded

Each extension gets its own Lua VM, created the first time the extension is
invoked, not at startup. A session that loads no extension — or loads one it
never calls — creates no VM and pays no idle CPU and no runtime memory for the
extension system at all. Lazy creation, not a cheap runtime, is what makes this
true.

One VM per extension (rather than one shared VM for all) costs about 120 KiB per
extension — measured, `research/extension-runtime/vm-isolation/` — and buys real
isolation: each extension has its own globals, its own garbage collector, an
optional per-extension memory cap, and a crash or runaway allocation contained to
that one VM. A shared VM with per-extension environments is leaner at large
extension counts and is the documented fallback if that ever matters; it is not
what v0.0.1 does.

The `reload` driver command (`docs/invocation.md`) reloads extensions. It is how
a running session picks up an installed or updated extension. Each reloaded
extension's VM is created again the next time it is invoked.

## When an extension misbehaves

- **It errors.** A Lua error is caught at the call boundary. The extension's call
  fails; the session survives and the VM stays usable. Errors carry the
  extension's filename and line.
- **It loops or hangs.** Each hook answers under the timeout it declared
  ("When a hook fails"). Enforcement is a two-stage
  interrupt: a cheap instruction hook normally, escalating to fire on every
  instruction once the deadline passes, so an extension cannot swallow the
  deadline with `pcall`. Measured in `research/extension-runtime/pass1/`.
- **It allocates without bound.** A per-extension memory cap turns this into an
  error in that extension's VM, not an out-of-memory kill of the process.
- **It is hostile.** Nothing stops it at runtime; it has the account's rights.
  This is the trust model, not a gap. Fiber's obligation is that installing an
  extension is a deliberate act.

## Notes for authors

- The embedding is Lua 5.4, not LuaJIT and not Luau. Write ordinary Lua 5.4.
- `require` loads files from your extension's own directory only. To use
  someone else's Lua, vendor a copy into your directory or depend on the
  extension that holds it.
- Give your extension a version tag for every release. Dependents name a
  minimum version, and Fiber installs nothing newer than someone asked for.
- JSON is `json.decode` / `json.encode`, provided by the host. Lua has none.
- Do not reach for `io`, `os`, `fetch`, sockets or environment variables — they
  are absent. Route every side effect through `host`.

## Distribution

### Names

An extension's name is where it lives, as with Go modules:
`github.com/owner/repo/path`. A dependency is written the same way. Any git host
works, there is no registry, and two authors cannot claim the same name. A
local path also works, for an extension under development.

The five first-party provider extensions also have short names, so
`fiber install openrouter` means the first-party extension's full name.

Fiber fetches with the system `git`, so your SSH keys and credential helpers
apply. If `git` is missing, the command fails with a stable error.

### Versions

A version is a git tag, such as `v1.4.0`. When extensions depend on the same
extension, Fiber installs the lowest version that meets every stated minimum.
If `openrouter` needs `oauth-helper` 1.2 or later, `databricks` needs 1.4 or
later, and 1.9 is the newest, Fiber installs 1.4. The same inputs always give
the same result, so there is no lockfile and no solver. A newer version arrives
only when something raises its minimum.

Two extensions that need different major versions, such as 1.x and 2.x, stop
the install with an error naming both.

Fiber records the exact commit it installed and loads only that. Nothing is
signed. The fetch runs over TLS or SSH, and a binary is checked against the
sha256 in its manifest. Fiber downloads only the binary for the platform it is
running on.

### Installing

| Command | What it does |
|---|---|
| `fiber install <name>` | Installs an extension and its dependencies. If any part fails, nothing is installed. |
| `fiber update <name>` | Moves one extension to its newest version and re-resolves its dependencies. |
| `fiber remove <name>` | Removes an extension, and any dependency nothing else uses. |
| `fiber list` | Lists installed extensions with their versions and commits. |

In a terminal, `install` and `update` show a summary and ask before going
ahead. The summary is the same one described in
[Extensions a repository brings](#extensions-a-repository-brings), and on
update it adds the diff since the installed version. Without a terminal they go
ahead without asking, so scripts can set up a machine.

Install refuses an extension whose manifest needs a newer Fiber than the one
running.

Installed extensions live in [Fiber home](state.md), one directory each, at
`extensions/<name>/`.

Installing an extension runs none of its code. A pure-data provider is only
ever read, and a Lua script first runs when the extension is first used. An
extension that registers a tool is first used at session start, because the
tool set is fixed before the first request (`docs/prompt-cache.md`, "Tools").

### A fresh install

Installing Fiber also installs the five first-party provider extensions, so
the first run fetches nothing.

A Fiber binary that arrived some other way has no extensions. In the terminal,
the model picker offers the five first-party providers, and choosing one
installs it. A headless run fails with `extension_missing`.

### Staying current

`fiber upgrade` updates the Fiber binary and every installed extension
together, so a new Fiber and the extensions written for it arrive at the same
time. `fiber update <name>` updates one extension.

Nothing checks for updates on a timer. Extensions change only when someone runs
one of these commands, so an idle Fiber does no work.

### Extensions a repository brings

A repository can bring extensions in two ways:

- ship them in `.fiber/extensions/<name>/`
- declare them by name and version in project config, to be fetched

Fiber loads neither until a person approves it. The first time a session would
load one, the terminal shows:

- where it comes from and its version
- the tools it registers, each with its effects
- the providers it registers, each with its base URLs
- the hooks, skills, prompt templates, themes and binaries it carries

The full source is one key away. Approving a declared extension fetches it.

An approval covers exact content. If the extension changes, Fiber shows the
diff since the approved content and asks again. Approvals are recorded per
machine in [Fiber home](state.md) at `approvals/<content-hash>`, so content
approved in one repository is not asked about again in another.

A headless run never fetches and never loads unapproved content. If a repository
declares an extension that is not installed, the run fails with
`extension_missing`. If it brings one nobody has approved, the run fails with
`extension_unapproved`, listing each one. `fiber approve`, run in the
repository from a terminal, shows the same summary for each and records the
approvals, so a later headless run can load them.

An MCP server a repository declares runs a program, so it needs the same
approval (`docs/mcp.md`, "A repository's servers").
