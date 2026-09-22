fiber.provider("acme", {
  chat = function(request)
    local key = host.secret("acme.api_key")
    local body = json.encode({
      model = request.model,
      max_tokens = request.max_tokens,
      messages = request.messages,
      stream = true,
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
      if event.type == "content_block_delta" then
        local delta = event.delta
        if delta and delta.type == "text_delta" and delta.text then
          host.emit(delta.text)
        end
      end
    end)
  end,
})
