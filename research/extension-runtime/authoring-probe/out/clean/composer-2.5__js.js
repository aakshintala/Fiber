fiber.provider("acme", {
  chat: function (request) {
    const key = host.secret("acme.api_key");
    const body = JSON.stringify({
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages,
      stream: true,
    });
    host.http_stream(
      {
        url: "https://api.acme.dev/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
        },
        body: body,
      },
      function (line) {
        if (line.indexOf("data: ") !== 0) {
          return;
        }
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          return;
        }
        const event = JSON.parse(payload);
        if (
          event.type === "content_block_delta" &&
          event.delta &&
          event.delta.type === "text_delta"
        ) {
          host.emit(event.delta.text);
        }
      }
    );
  },
});
