# Model routing

What is true as of #285. Later chain tickets (#286+) extend this file; nothing
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
