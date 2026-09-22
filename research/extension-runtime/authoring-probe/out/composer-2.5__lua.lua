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
      local trimmed = line:match("^%s*(.*)$")
      if not trimmed then
        return
      end
      local payload = trimmed:match("^data: (.*)$")
      if not payload then
        return
      end
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
STATUS: DONE
