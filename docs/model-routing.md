# Model routing

What is true as of #286. Later chain tickets (#287+) extend this file; nothing
below describes behavior that does not exist yet.

* The release binary routes through the Codex-only `provider_bundle` in
  `src/builtins/gateway.zig`. The bundle carries no auth strategy:
  `Bundle.AuthStrategy` is deleted from `src/core/gateway/provider_set.zig`.
* Transport fixtures do not ship in the release binary. They live in two
  test-only modules, each guarded by a `comptime` `builtin.is_test`
  `@compileError`:
  * `src/builtins/gateway_fixture.zig` (request shaping the agent-loop tests
    assert on; moved out of `src/builtins/gateway.zig` in #285)
  * `src/gateway/agent_request_body.zig` (historical message-JSON shape the
    agent-loop tests assert on; carries no endpoint, auth, or header behavior)
* Test-only wiring imports those modules behind `builtin.is_test`:
  `src/core/tooling/tool_runtime.zig` and
  `src/core/agent/runtime/tests/support.zig` use `gateway_fixture`;
  `src/core/agent/runtime/assistant_stream.zig` uses `agent_request_body`.
  Release builds see an empty struct in each place.

## Connections and embedded presets (#286)

A `Connection` is data: credential kind (`oauth`, `api_key`, `env`, `none`),
default protocol (`responses`, `chat_completions`), default base URL, default
compat flags, billing kind (`metered`, `subscription`), and model entries
that may override protocol, base URL and compat. The type and its JSON parser
live in `src/protocols/presets/connection.zig`, outside `src/core/`.

The built-in `codex` preset is `src/protocols/presets/codex.json`, embedded
in the binary and parsed at startup by the same parser as user `connections`
in `~/.fiber/settings.json`: OAuth credential, Responses protocol, the
ChatGPT Responses endpoint, subscription billing.

* Unknown keys in a connection fail settings load with an error naming the
  connection and the key (`key=connections.<name>.<key>` on startup). The
  same rejection applies inside per-model overrides, scoped as
  `connections.<name>.models.<model>.<key>`.
* A user `connections.<name>` entry merges over the preset of the same name
  field by field: setting only `base_url` keeps every other preset field.
  Pointing `connections.codex.base_url` at a loopback server is how tests
  exercise the real preset.
* `connections` is profile-only: a project `.fiber.json` entry is dropped and
  reported as an ignored profile-owned key, like the other profile-owned
  keys. It never redirects prompts to a committed endpoint.
* Compat flag keys are not validated yet: the flag vocabulary belongs to the
  adapter tickets, so this layer only checks the shape (a flat object of
  string, boolean and integer values) and merges entries field by field.
* Routing still reaches Codex through today's Codex-only path. Connections
  exist and validate; later tickets route through them.
