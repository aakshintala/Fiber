# Providers

Status: shared shape decided, individual providers at different stages

Priority: after the Fiber product transition

Last updated: September 2, 2026

## Why this document exists

Three separate provider ideas turn out to share one unsolved problem. This document holds
the shape they have in common. Each provider keeps its own document for its own contract:

- [OpenCode Go](opencode-go-support.md) — decided, first to implement
- [Databricks](databricks-provider-support.md) — required for the work machine
- OpenRouter — sketched below, no separate document yet

## Deployment shape

Fiber runs with different provider sets on different machines, and more than one provider
is active at once. There is no single active provider.

| Machine | Providers | Notes |
| --- | --- | --- |
| personal | Codex, OpenCode Go, possibly OpenRouter | all authenticated and selectable at the same time |
| work | Databricks only | Fiber is unusable at work until this lands |

Two consequences for the cutover contracts:

- the configured provider set is per-machine state, not a compiled-in list. `fiber auth list`
  and `fiber auth status` report what this machine has configured.
- model selection alone determines the route for a main agent or subagent. The product
  transition already removes the profile-wide provider setting; this is why.

## The shared constraint

A provider is not a protocol. Each of these serves several wire shapes from one account:

| Provider | Credential | Wire shapes |
| --- | --- | --- |
| Codex | ChatGPT subscription | Responses |
| OpenCode Go | one static API key | Chat Completions, Anthropic Messages, Responses — chosen per model |
| Databricks | workspace credential, several methods | MLflow Chat Completions, Open Responses, OpenAI Responses, provider-native, legacy serving |
| OpenRouter | one API key | Chat Completions primarily; other surfaces unconfirmed |

So the routing key is the model, not the provider. A model identifier has to resolve to a
wire protocol, a route, and a credential. The inherited fx model — one provider means one
base URL, one stream function, one credential — cannot express any row below the first.

The Fiber cutover removes that inherited indirection rather than extending it. The
replacement is designed by whichever provider lands first, not during the cutover.

## Wire protocols Fiber will need

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages

Each needs a protocol adapter that translates wire events into Fiber's native event model.
The agent loop must not depend on any provider's event types.

## OpenRouter sketch

OpenRouter aggregates many vendors behind one account and one key, with vendor-namespaced
model identifiers. It is attractive because it widens the model pool without a new
subscription per vendor, and because its namespace convention matches what the model picker
already groups by.

Two things make it different from the others and neither is confirmed:

- the model list is large enough that ranking, filtering, and featured-family projection in
  the picker stop being optional
- which wire shapes it exposes beyond Chat Completions

Confirm both against current OpenRouter documentation before committing to it. Treat every
claim in this section as unverified.

## Sequence

1. Fiber product transition. Codex only, provider indirection removed.
2. OpenCode Go. The smallest instance of one provider serving several protocols, and the
   cheapest place to settle the routing shape.
3. Databricks. Unblocks the work machine. Uses the shape OpenCode Go settled rather than
   designing a second one. Brings discovery and refreshable credentials.
4. OpenRouter, if it still looks worthwhile once the first two are in.

Databricks is the blocking dependency for using Fiber at work, so this ordering is a bet
that settling the routing shape on the easier provider first is faster overall than
designing it against four routes and five authentication methods. Revisit if the work
machine becomes urgent.

## Shared open decisions

- how a model identifier resolves to protocol, route, and credential
- whether Codex moves onto that resolution path or stays separate until Databricks forces it
- whether the provider set is discovered, configured, or both, and how that differs per machine
- how the model picker groups and ranks once one account can serve many vendors
- whether repeated provider needs ever justify a runtime provider registry

## Related

- [Fiber product transition](fiber-product-transition.md) — the cutover that removes the
  inherited provider indirection
- [Builtin customization and extensions](builtin-customization-and-extensions.md) — none of
  these providers should require an extension runtime
