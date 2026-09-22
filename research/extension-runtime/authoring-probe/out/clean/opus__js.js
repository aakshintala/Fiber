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
        body: JSON.stringify(req),
      },
      function (line) {
        if (line.slice(0, 6) !== "data: ") return;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
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
