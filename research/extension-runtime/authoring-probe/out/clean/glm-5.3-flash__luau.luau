-- Acme provider: streams chat completions in Anthropic SSE wire format.

fiber.provider("acme", {
  chat = function(req)
    local key = host.secret("acme.api_key")

    local body = json.encode({
      model = req.model,
      max_tokens = req.max_tokens,
      messages = req.messages,
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
      if string.sub(line, 1, 6) ~= "data: " then
        return
      end

      local payload = string.sub(line, 7)
      if payload == "[DONE]" then
        return
      end

      local ok, event = pcall(json.decode, payload)
      if not ok or type(event) ~= "table" then
        return
      end

      if event.type == "content_block_delta"
        and event.delta
        and event.delta.type == "text_delta"
        and event.delta.text
      then
        host.emit(event.delta.text)
      end
    end)

    return { ok = true }
  end,
})
