# Writing a Fiber extension — JavaScript (QuickJS)

The runtime is QuickJS: ES2023 syntax, but a bare embedding. There is NO `fetch`, NO `require`/`import` of modules, NO `process`, NO `Buffer`, NO Node or browser globals, and NO event loop (`async`/`await` and Promises are not available to you). `JSON` is built in. All I/O goes through the host object described below.

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
  // opts: { url: "...", method: "POST", headers: {...}, body: "..." }
  // on_line: function(line)  // called once per received line; blocking
  // returns after the stream ends
host.emit(text)          -- append text to the assistant's turn output
host.log(msg)            -- write a debug line
```

## JSON

```
JSON.parse(str)  // built in; returns an object
```

## Registering a tool (reference example)

A complete, working tool. Study the shape; your task is a different extension.

```javascript
fiber.tool("wordinfo", {
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
});
```

## Registering a provider

```
fiber.provider(name, { chat: handler });
```

`handler` receives a request object shaped like:

```
{
  model: "acme-large",
  max_tokens: 1024,
  messages: [ { role: "user", content: "hello" } ],
}
```

The handler builds the vendor's HTTP request, streams the response, and calls
`host.emit(text)` for each piece of assistant text as it arrives.
