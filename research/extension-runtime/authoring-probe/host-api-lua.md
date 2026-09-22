# Writing a Fiber extension — Lua 5.4

The runtime is Lua 5.4 with a stripped standard library: `table`, `string`, `math`, `utf8` and `coroutine` only. There is no `io`, `os`, `package`/`require`, or `debug`. JSON is provided by the host as `json.decode` / `json.encode`.

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
host.http_stream(opts, on_line)
  -- opts: { url = "...", method = "POST", headers = {...}, body = "..." }
  -- on_line: function(line)  -- called once per received line; blocking
  -- returns after the stream ends
host.emit(text)          -- append text to the assistant's turn output
host.log(msg)            -- write a debug line
```

## JSON

```
json.decode(str)  -- host-provided; returns a Lua table
```

## Registering a tool (reference example)

A complete, working tool. Study the shape; your task is a different extension.

```lua
fiber.tool("wordinfo", {
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
})
```

## Registering a provider

```
fiber.provider(name, { chat = handler })
```

`handler` receives a request object shaped like:

```
{
  model      = "acme-large",
  max_tokens = 1024,
  messages   = { { role = "user", content = "hello" } },
}
```

The handler builds the vendor's HTTP request, streams the response, and calls
`host.emit(text)` for each piece of assistant text as it arrives.
