#!/usr/bin/env python3
# Generates the three per-language authoring docs from ONE source, so they stay
# at parity. Each candidate model sees ONLY its language's doc + the shared task.
# Parity is the whole ballgame: unequal docs measure doc quality, not the
# training-data familiarity we are after.
import pathlib

REF_LUA = '''fiber.tool("wordinfo", {
  description = "Look up the length of a word",
  input_schema = { word = "string" },
  run = function(input)
    local key = host.secret("acme.api_key")
    local res = host.http({
      url = "https://api.acme.dev/word/" .. input.word,
      method = "GET",
      headers = { authorization = "Bearer " .. key },
    })
    if res.status ~= 200 then
      return { error = "lookup failed: " .. tostring(res.status) }
    end
    local data = json.decode(res.body)
    return { length = data.length }
  end,
})'''

REF_JS = '''fiber.tool("wordinfo", {
  description: "Look up the length of a word",
  input_schema: { word: "string" },
  run: function (input) {
    const key = host.secret("acme.api_key");
    const res = host.http({
      url: "https://api.acme.dev/word/" + input.word,
      method: "GET",
      headers: { authorization: "Bearer " + key },
    });
    if (res.status !== 200) {
      return { error: "lookup failed: " + res.status };
    }
    const data = JSON.parse(res.body);
    return { length: data.length };
  },
});'''

REQ_LUA = '''{
  model      = "acme-large",
  max_tokens = 1024,
  messages   = { { role = "user", content = "hello" } },
}'''

REQ_JS = '''{
  model: "acme-large",
  max_tokens: 1024,
  messages: [ { role: "user", content: "hello" } ],
}'''

HTTP_STREAM_LUA = '''host.http_stream(opts, on_line)
  -- opts: { url = "...", method = "POST", headers = {...}, body = "..." }
  -- on_line: function(line)  -- called once per received line; blocking
  -- returns after the stream ends'''

HTTP_STREAM_JS = '''host.http_stream(opts, on_line)
  // opts: { url: "...", method: "POST", headers: {...}, body: "..." }
  // on_line: function(line)  // called once per received line; blocking
  // returns after the stream ends'''

LANGS = {
  "lua": {
    "title": "Lua 5.4",
    "note": "The runtime is Lua 5.4 with a stripped standard library: `table`, "
            "`string`, `math`, `utf8` and `coroutine` only. There is no `io`, "
            "`os`, `package`/`require`, or `debug`. JSON is provided by the host "
            "as `json.decode` / `json.encode`.",
    "fence": "lua", "ref": REF_LUA, "req": REQ_LUA, "http_stream": HTTP_STREAM_LUA,
    "json": "json.decode(str)  -- host-provided; returns a Lua table",
    "provider_reg": "fiber.provider(name, { chat = handler })",
  },
  "luau": {
    "title": "Luau",
    "note": "The runtime is Luau (Roblox's Lua dialect) with a stripped standard "
            "library and `sandbox` mode on: globals are read-only. There is no "
            "`io`, `os`, or `debug`. JSON is provided by the host as "
            "`json.decode` / `json.encode`. Luau supports optional type "
            "annotations; you may use them.",
    "fence": "lua", "ref": REF_LUA, "req": REQ_LUA, "http_stream": HTTP_STREAM_LUA,
    "json": "json.decode(str)  -- host-provided; returns a table",
    "provider_reg": "fiber.provider(name, { chat = handler })",
  },
  "js": {
    "title": "JavaScript (QuickJS)",
    "note": "The runtime is QuickJS: ES2023 syntax, but a bare embedding. There "
            "is NO `fetch`, NO `require`/`import` of modules, NO `process`, NO "
            "`Buffer`, NO Node or browser globals, and NO event loop "
            "(`async`/`await` and Promises are not available to you). `JSON` is "
            "built in. All I/O goes through the host object described below.",
    "fence": "javascript", "ref": REF_JS, "req": REQ_JS, "http_stream": HTTP_STREAM_JS,
    "json": "JSON.parse(str)  // built in; returns an object",
    "provider_reg": "fiber.provider(name, { chat: handler });",
  },
}

TEMPLATE = """# Writing a Fiber extension — @@title@@

@@note@@

## What an extension is

A Fiber extension is a single script the host loads at startup. It registers
capabilities by calling `fiber.tool(...)` and `fiber.provider(...)`. Your script
runs with the account's full rights; the host owns all I/O and hands it to you
through a global `host` object. Your code is called synchronously — you do the
work and return; there is no background execution.

## The `host` object

```
host.secret(name)        -- returns the configured secret string for `name`
host.http(opts)          -- one blocking HTTP request; returns { status, body }
@@http_stream@@
host.emit(text)          -- append text to the assistant's turn output
host.log(msg)            -- write a debug line
```

## JSON

```
@@json@@
```

## Registering a tool (reference example)

A complete, working tool. Study the shape; your task is a different extension.

```@@fence@@
@@ref@@
```

## Registering a provider

```
@@provider_reg@@
```

`handler` receives a request object shaped like:

```
@@req@@
```

The handler builds the vendor's HTTP request, streams the response, and calls
`host.emit(text)` for each piece of assistant text as it arrives.
"""

KEYS = ("title", "note", "http_stream", "json", "fence", "ref", "provider_reg", "req")
for lang, d in LANGS.items():
    out = TEMPLATE
    for k in KEYS:
        out = out.replace("@@" + k + "@@", d[k])
    pathlib.Path(f"host-api-{lang}.md").write_text(out)
    print(f"wrote host-api-{lang}.md ({len(out)} bytes)")
