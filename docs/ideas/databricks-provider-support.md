# Databricks provider support

Status: lower-priority idea under discussion

Last updated: September 1, 2026

## Decision summary

Add Databricks support after OpenCode Go support and the Fiber product transition.

Treat one Databricks workspace as a provider installation that may expose several protocols and routes. Do not make Databricks depend on a generic extension system. Start with native support and generalize only where another provider has the same need.

## User need

A user should be able to configure a Databricks workspace, authenticate with a supported method, discover usable model services, and select a model in Fiber.

Fiber should route each model through a compatible protocol. It should preserve streaming, tool calls, cancellation, usage, and errors through the normal agent runtime.

## Databricks exposes several model routes

Databricks Unity AI Gateway exposes several useful protocols from one workspace. A provider cannot be represented as one base URL and one stream function.

### MLflow Chat Completions

The base URL is:

```text
https://<workspace-url>/ai-gateway/mlflow/v1
```

The chat route uses an OpenAI-compatible Chat Completions shape. The model field contains a fully qualified model-service name, such as:

```text
system.ai.claude-sonnet-4-5
```

The documented API includes streaming, usage, tool definitions, tool calls, and `tool_choice`.

### Open Responses

Databricks documents an Open Responses-compatible route for coding agents:

```text
https://<workspace-url>/ai-gateway/codex/v1
```

Databricks also documents a provider-agnostic Supervisor API:

```text
https://<workspace-url>/ai-gateway/mlflow/v1/responses
```

The Supervisor API is in beta. Fiber should discover its availability instead of assuming every workspace supports it.

### OpenAI Responses

OpenAI-backed model services can use:

```text
https://<workspace-url>/ai-gateway/openai/v1/responses
```

This route is distinct from MLflow Chat Completions and the provider-agnostic Open Responses route.

### Provider-native APIs

Databricks can expose provider-native APIs, including Anthropic Messages for Claude-backed services. A native route may preserve features that a compatibility route omits.

Add provider-native routes only when Fiber needs a capability that the common routes cannot provide.

### Legacy serving endpoints

Existing Model Serving endpoints use:

```text
POST /serving-endpoints/{name}/invocations
```

Request shapes vary across foundation, external, custom, and agent models. Do not force custom scoring endpoints into the conversational model contract.

## Keep routing concepts separate

Databricks needs separate native values for:

- workspace or provider installation
- model service
- wire protocol
- base URL and route
- authentication strategy
- model capabilities

The first Databricks implementation should add only the contracts that current code cannot represent. Do not design a public provider extension API as part of this work.

An illustrative model description may include:

```zig
pub const ModelDescriptor = struct {
    id: []const u8,
    display_name: []const u8,
    protocol: ProtocolId,
    endpoint: Endpoint,
    capabilities: ModelCapabilities,
};
```

The final contract must define allocation ownership, secret handling, refresh behavior, and stable serialization.

## Normalize provider events

Protocol adapters should translate Databricks wire events into Fiber's native event model. The agent loop should not depend on Databricks event types.

Useful neutral events include:

```text
response.started
output_text.delta
reasoning.delta
tool_call.started
tool_call.arguments.delta
tool_call.completed
usage.updated
response.completed
response.failed
```

Preserve unknown provider data only when it has a bounded representation and a concrete use. Do not weaken common event types to retain speculative fields.

## Record model capabilities

Protocol support does not prove model support. Model metadata should state capabilities such as:

- text and image input
- reasoning output
- tool calls
- parallel tool calls
- structured output
- prompt caching
- streaming usage
- maximum context and output tokens

Fiber should record whether a capability came from Databricks discovery, built-in metadata, or a user override. It should not silently invent support.

## Support refreshable credentials

Databricks recommends unified authentication. Relevant methods include:

- personal access tokens for development
- OAuth machine-to-machine credentials
- OAuth user-to-machine credentials
- environment variables
- `.databrickscfg` profiles
- short-lived tokens from an external refresh command

Start with the authentication methods required by the first users. Add the rest when needed.

The credential contract should return a usable request credential and its expiry. Fiber should schedule refresh and keep secrets out of logs, transcripts, and extension-visible values.

A command-backed credential source may help other providers. If added, it should use an argument array rather than a shell. It also needs a strict timeout, a bounded output size, secret masking, and explicit permission.

## Suggested delivery sequence

1. Confirm the routes and authentication methods available in the target workspace.
2. Add workspace configuration and the minimum credential source.
3. Discover or configure model services and their capabilities.
4. Support MLflow Chat Completions first unless the target model requires another route.
5. Add Open Responses for workspaces and models that expose it.
6. Add native provider routes only for a demonstrated missing capability.
7. Test streaming, tools, cancellation, usage, expiry, and refresh.

## Success criteria

Databricks support is successful when:

- a user can configure one workspace without exposing its credentials
- Fiber can select and route at least one discovered model service
- streaming, tool calls, cancellation, usage, and errors use normal runtime behavior
- credential expiry and refresh do not leak secrets
- preview and beta routes are capability-gated
- the implementation does not require a generic extension runtime

## Open decisions

We still need to decide:

- which authentication method ships first
- whether the first version discovers models or uses explicit configuration
- how Fiber chooses among several protocols for one model
- how model discovery caches and invalidates results
- which Databricks route owns the first end-to-end test
- whether repeated provider needs justify a runtime provider registry

## Research sources

- [Govern model APIs](https://docs.databricks.com/aws/en/ai-gateway/model-services)
- [Query model APIs](https://docs.databricks.com/aws/en/ai-gateway/query-model-services)
- [Get started querying LLMs](https://docs.databricks.com/aws/en/large-language-models/llm-serving-intro)
- [Integrate with coding agents](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-integration-model-services)
- [Function calling](https://docs.databricks.com/aws/en/machine-learning/model-serving/function-calling)
- [Model Serving query API](https://docs.databricks.com/api/model-serving-query/v1/query)
- [Unified authentication](https://docs.databricks.com/aws/en/dev-tools/auth/unified-auth)
- [OAuth machine-to-machine authorization](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m)
