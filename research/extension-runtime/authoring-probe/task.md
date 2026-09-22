# Task (identical for every model and language)

Write a Fiber **provider** extension named `acme`.

Acme's chat API streams responses as server-sent events in the Anthropic wire
format. Each streamed line the host hands you looks like one of:

    data: {"type":"message_start", ...}
    data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}
    data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}
    data: {"type":"content_block_stop","index":0}
    data: {"type":"message_stop"}
    data: [DONE]

Requirements:

1. Register a provider named `acme` with a `chat` handler.
2. In the handler, read the API key with `host.secret("acme.api_key")`, build the
   request body from the request object, and POST it to
   `https://api.acme.dev/v1/messages` via `host.http_stream`, with an
   `authorization: Bearer <key>` header.
3. For every streamed line: skip anything that is not a `data: ` line, skip
   `data: [DONE]`, parse the JSON, and when the event is a `content_block_delta`
   whose `delta.type` is `text_delta`, pass `delta.text` to `host.emit`.
4. Emit nothing for any other event type.

Return only the extension source, nothing else. Do not explain it.
