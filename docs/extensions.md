# Extensions

What is true now about Fiber's extension system. Vocabulary is `CONTEXT.md`.
The seams are `docs/architecture.md`; the runtime choice and its reasoning are
[ADR 0006](adr/0006-extension-runtime-lua.md); the trust model is
`docs/permissions.md`. The measurements behind all of it are in
`research/extension-runtime/`.

## What an extension is

An extension is a single script Fiber loads and runs with the account's full
rights. It registers capabilities through the same three seams a built-in uses —
tool, provider and hook — and a registration by an existing name replaces the
built-in, recorded in the session log. An extension that registers a tool named
`read` becomes the `read` tool; the loop never learns whether the answer came
from Fiber or from the extension.

The script does its work synchronously and returns. There is no background
execution, no event loop, no `async`. This follows
[ADR 0004](adr/0004-blocking-threads-no-async-runtime.md): a hook answers inside
the turn, under a timeout Fiber enforces.

## The runtime

Extensions are written in **Lua 5.4**, embedded through `mlua` (vendored, so
Fiber's build compiles Lua's C itself and takes no system dependency). The
choice and the alternatives weighed — JavaScript via QuickJS, Luau, Starlark,
WASM, and full TypeScript — are in [ADR 0006](adr/0006-extension-runtime-lua.md).

The embedding is bare. An extension sees a stripped standard library — `table`,
`string`, `math`, `utf8`, `coroutine` — and nothing else. There is no `io`, no
`os`, no `package`/`require`, no `debug`. It cannot open a file, make a socket,
read an environment variable, or spawn a process on its own. Every capability
reaches it through a host-provided global.

This is not a security boundary. Per `docs/permissions.md`, an extension runs
with the account's full rights; the stripped stdlib is a structural fact — the
host owns I/O — not a sandbox. A hostile extension is contained the way `npm
install` is contained: not at all at runtime, only by the decision to install
it. Trust is resolved when an extension is installed, not while it runs.

## What an extension can do

Everything an extension touches outside pure computation goes through two
globals the host installs: `host` for capabilities, `fiber` for registration.

```
host.secret(name)              -- the configured secret string for `name`
host.http(opts)                -- one blocking HTTP request; returns { status, body }
host.http_stream(opts, on_line)-- streams a response; calls on_line(line) per line, blocking
host.emit(text)                -- append text to the assistant's turn output
host.log(msg)                  -- write a debug line
json.decode(str) / json.encode(value)   -- JSON, host-provided (Lua has none built in)
```

```
fiber.tool(name, { description, input_schema, run })
fiber.provider(name, { chat })
fiber.hook(event, handler)
```

An extension can make HTTP requests, read declared secrets, hold state across
calls (in its own Lua globals), and register any number of tools, providers and
hooks. It cannot reach the filesystem, network sockets, environment or other
processes except through `host`, because the embedding gives it no other way.

## What writing a provider looks like

A provider turns a request into a stream of assistant text. Here is the whole of
one, for a vendor that streams in the Anthropic wire format:

```lua
fiber.provider("acme", {
  chat = function(req)
    local key = host.secret("acme.api_key")
    host.http_stream({
      url = "https://api.acme.dev/v1/messages",
      method = "POST",
      headers = { authorization = "Bearer " .. key },
      body = json.encode({ model = req.model, max_tokens = req.max_tokens, messages = req.messages }),
    }, function(line)
      if string.sub(line, 1, 6) ~= "data: " then return end
      local payload = string.sub(line, 7)
      if payload == "[DONE]" then return end
      local ev = json.decode(payload)
      if ev.type == "content_block_delta" and ev.delta and ev.delta.type == "text_delta" then
        host.emit(ev.delta.text)
      end
    end)
  end,
})
```

In plain terms: Fiber calls `chat` with the request. The extension fetches the
API key, builds the request body as JSON, and asks the host to POST it and
stream the reply. The host does the network work and hands back one line at a
time. For each line the extension skips anything that is not a data line, decodes
the JSON, and when a line carries a piece of assistant text, passes that text to
`host.emit`. Fiber assembles what is emitted into the turn's answer. The
extension never opens a socket, manages a connection, or parses HTTP — the host
owns all of that; the extension owns the shape of one vendor's request and reply.

Writing a tool or a hook has the same shape: register a name, receive a call, do
pure work plus host calls, return.

## Are the five shipped providers extensions?

No. The five providers v0.0.1 ships — OpenCode subscription, ChatGPT/codex OAuth,
muse API key, OpenRouter, Databricks — are native Rust, compiled in, registering
through the provider seam exactly as an extension would. They are built-ins, not
scripts. This keeps them off the extension runtime entirely: their wire formats,
auth flows and streaming are Rust, and a session that never loads an extension
never creates a Lua VM (see next). Extensions exist to add a sixth provider, or
to replace one of the five by name, without rebuilding Fiber.

## Loading, and cost when nothing is loaded

Each extension gets its own Lua VM, created the first time the extension is
invoked, not at startup. A session that loads no extension — or loads one it
never calls — creates no VM and pays no idle CPU and no runtime memory for the
extension system at all. This was a hard requirement of the ticket and it is met
by lazy instantiation, not by making the runtime cheap.

One VM per extension (rather than one shared VM for all) costs about 120 KiB per
extension — measured, `research/extension-runtime/vm-isolation/` — and buys real
isolation: each extension has its own globals, its own garbage collector, an
optional per-extension memory cap, and a crash or runaway allocation contained to
that one VM. A shared VM with per-extension environments is leaner at large
extension counts and is the documented fallback if that ever matters; it is not
what v0.0.1 does.

## When an extension misbehaves

- **It errors.** A Lua error is caught at the call boundary. The extension's call
  fails; the session survives and the VM stays usable. Errors carry the
  extension's filename and line.
- **It loops or hangs.** Hooks answer under a timeout. Enforcement is a two-stage
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
- There is no `require` and no package ecosystem. An extension is one
  self-contained script plus what `host` and the stripped stdlib give it.
- JSON is `json.decode` / `json.encode`, provided by the host. Lua has none.
- Do not reach for `io`, `os`, `fetch`, sockets or environment variables — they
  are absent. Route every side effect through `host`.
