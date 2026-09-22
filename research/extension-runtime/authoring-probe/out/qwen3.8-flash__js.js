```javascript
fiber.provider("acme", {
  chat: function (req) {
    const key = host.secret("acme.api_key");
    host.http_stream(
      {
        url: "https://api.acme.dev/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.max_tokens,
          messages: req.messages,
        }),
      },
      function (line) {
        if (!line.startsWith("data: ")) return;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch (e) {
          return;
        }
        if (
          evt.type === "content_block_delta" &&
          evt.delta &&
          evt.delta.type === "text_delta"
        ) {
          host.emit(evt.delta.text);
        }
      }
    );
  },
});
```
