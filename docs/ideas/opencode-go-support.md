# OpenCode Go support

Status: decided, ready to implement

Priority: after the Fiber product transition

Last updated: September 1, 2026

## Decision summary

Add OpenCode Go support after the Fiber product transition and before Databricks support or a generic extension system.

The immediate goal is to let Fiber use both Codex and OpenCode-backed models. Subagents are the main use case. Access to both model pools will help us use the best available model for later repository work.

Build the smallest native integration that meets this goal. It starts from the completed Fiber cutover, so it needs no rename work of its own, and it must not depend on a generic provider registry or an embedded extension language.

## User need

A user should be able to:

- configure access to OpenCode-backed models
- select an OpenCode-backed model for a main agent or subagent
- continue using existing Codex-backed models
- see which provider and model a subagent uses
- get a clear error when authentication, model selection, or a request fails

The integration should work in the native CLI and agent runtime. It should not require Node.js, an npm package, or an in-process JavaScript SDK.

## Initial boundary

The first version should use the existing native provider and model seams where they fit. Add only the OpenCode-specific transport, authentication, and response handling that the external contract requires.

Keep these concerns separate:

- provider authentication
- model identifiers and display names
- request and streaming protocol
- model selection for the main agent
- model selection for subagents
- usage and error reporting

Do not introduce a runtime provider registry unless the current closed provider model blocks the integration. If it does, make the smallest change that supports Codex and OpenCode. Databricks can later test whether that contract needs to become more general.

## Subagent model routing

Subagent use is the reason to prioritize this work. The model selection path must therefore reach every subagent creation route, not only the main conversation.

The first useful version should support:

1. A caller selects an OpenCode-backed model through the existing model option or subagent model override.
2. Fiber resolves that model to the OpenCode integration.
3. The subagent records the selected provider and model in its session state.
4. Requests, cancellation, usage, and failures flow through the normal subagent lifecycle.
5. Existing Codex model selection continues to work.

Automatic model routing is not required. Explicit model selection is enough until we have evidence that policy-based routing would save work.

## External contract (confirmed against https://opencode.ai/docs/go/, Sep 1 2026)

OpenCode Go is a $10/month OpenCode Zen subscription for open coding models.

- Base URL: `https://opencode.ai/zen/go/v1/`
- Authentication: static API key from the OpenCode Zen console. Bearer-style, no expiry or refresh flow.
- Model identifiers use OpenCode's own convention: `opencode-go/<model-id>` (for example `opencode-go/glm-5.3-flash`).
- One provider serves three wire protocols, chosen per model:
  - `POST /chat/completions` (OpenAI-compatible): GLM-*, kimi-*, deepseek-*, mimo-*, longcat-*, hy-*
  - `POST /messages` (Anthropic protocol): minimax-*, qwen3.*
  - `POST /responses` (OpenAI Responses API): grok-4.6, gpt-5.6-luna
- `GET /models` returns the full model list. Not used in v1; the catalog is hardcoded.
- Requests must identify themselves with a distinctive User-Agent; broad user agents get the account flagged.
- Usage limits are dollar-based ($12 per 5 hours, $30 weekly, $60 monthly), so over-limit and auth failures surface as HTTP errors and must flow through the existing error path.

## Authentication and configuration

Store the credential in `~/.fiber/opencode-go-auth.json`, following the existing per-provider pattern (a sibling of the Codex auth file) and reusing existing credential loading and secret masking. The key is pasted once from the Zen console.

Do not copy secrets into transcripts, logs, subagent metadata, or tool results.

## Compatibility

This work follows the Fiber product transition, so it builds on the post-cutover Fiber namespace: the `fiber` executable, `FIBER_*` environment variables, and `~/.fiber/` state. It introduces no fx-named paths or identifiers and requires no fx-to-Fiber migration.

The integration lives in the native provider and agent layers. The JavaScript SDK, WebAssembly surface, and Node-API addon are removed by the transition and are not available to it.

## Settled decisions

- v1 covers only the `/chat/completions` protocol family (GLM, Kimi, DeepSeek, MiMo, LongCat, Hy). `/messages` and `/responses` are deferred; the catalog carries a per-model protocol field so adding them later is additive.
- The model catalog is hardcoded, matching the Codex pattern in `src/gateway/openai_codex_models.zig`. Model discovery is deferred; the area is expected to be reworked soon, so discovery would be wasted work. The Grok adapter is not a reference: the cutover removes it.
- The first end-to-end test owner is `glm-5.3-flash`.
- Structure: add a `ProviderId.opencode_go` enum member and a provider bundle in `src/core/gateway/provider_set.zig`, plus a new per-provider SSE transport in `src/gateway/` modeled on the retained Codex adapter. No runtime registry, no extension runtime, no rename coupling.

## Suggested delivery sequence

1. Trace main-agent and subagent model selection through the current runtime.
2. Add the smallest native provider integration (catalog, auth file, chat/completions transport).
3. Wire explicit OpenCode model selection into subagent creation.
4. Add focused tests for routing, streaming, usage, cancellation, and errors.
5. Build Fiber and run a real subagent with `glm-5.3-flash`.
6. Run the same path with a Codex-backed model to catch regressions.

## Success criteria

This idea is successful when:

- one built Fiber binary can use Codex and OpenCode-backed models
- a subagent can explicitly select either model source
- model and provider identity remain visible in session state and output
- cancellation, tool calls, usage, and errors follow existing runtime behavior
- no generic extension runtime is required
- no fx-to-Fiber migration is required

## Deferred

- Anthropic `/messages` and OpenAI `/responses` protocol support.
- Model discovery via `GET /models`.
- Databricks provider support (tests whether the closed provider contract needs to generalize).
