fiber.provider("acme", {
  chat = function(req)
    local key = host.secret("acme.api_key")
    local body = json.encode({
      model = req.model,
      max_tokens = req.max_tokens,
      messages = req.messages,
    })
    host.http_stream({
      url = "https://api.acme.dev/v1/messages",
      method = "POST",
      headers = {
        authorization = "Bearer " .. key,
        ["content-type"] = "application/json",
      },
      body = body,
    }, function(line)
      if line:sub(1, 6) ~= "data: " then
        return
      end
      local payload = line:sub(7)
      if payload == "[DONE]" then
        return
      end
      local event = json.decode(payload)
      if event.type == "content_block_delta" and event.delta and event.delta.type == "text_delta" then
        host.emit(event.delta.text)
      end
    end)
  end,
})
