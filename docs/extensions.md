# Extensions

What is true now about Fiber's extension system. Vocabulary is `CONTEXT.md`.
The seams are `docs/architecture.md`; the runtime choice and its reasoning are
[ADR 0006](adr/0006-extension-runtime-lua.md); the trust model is
`docs/permissions.md`. The measurements behind all of it are in
`research/extension-runtime/`.

## What an extension is

An extension is a package Fiber installs and loads: data, plus a Lua script
where it needs code. Its code runs with the account's full rights. It registers capabilities through the same three seams a built-in uses —
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
host.log(msg)                  -- write a debug line
json.decode(str) / json.encode(value)   -- JSON, host-provided (Lua has none built in)
```

```
fiber.tool(name, { description, input_schema, run })
fiber.provider(name, { models })
fiber.hook(event, handler)
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
pure work plus host calls, return.

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
