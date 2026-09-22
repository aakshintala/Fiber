fiber.provider("acme", {
  chat: function (req) {
    var key = host.secret("acme.api_key");
    var body = JSON.stringify({ model: req.model, max_tokens: req.max_tokens, messages: req.messages });
    host.http_stream({
      url: "https://api.acme.dev/v1/messages",
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: body
    }, function (line) {
      if (line.slice(0, 6) !== "data: ") return;
      var payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      var evt = JSON.parse(payload);
      if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
        host.emit(evt.delta.text);
      }
    });
  }
});

