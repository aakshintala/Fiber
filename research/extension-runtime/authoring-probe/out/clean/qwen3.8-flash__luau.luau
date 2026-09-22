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
        accept = "text/event-stream",
      },
      body = body,
    }, function(line)
      if typeof(line) ~= "string" then
        return
      end
      if not string.find(line, "^data: ", 1, true) then
        return
      end
      local payload = string.sub(line, 7)
      if payload == "[DONE]" then
        return
      end
      local ok, event = pcall(json.decode, payload)
      if not ok or event == nil then
        host.log("acme: bad json line: " .. payload)
        return
      end
      if event.type == "content_block_delta" then
        local delta = event.delta
        if delta ~= nil and delta.type == "text_delta" then
          host.emit(delta.text)
        end
      end
    end)
  end,
})
