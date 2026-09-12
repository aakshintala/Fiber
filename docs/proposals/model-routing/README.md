# Model routing and multiple providers

Status: accepted, not implemented. Decided 2026-09-11.

Tracking: [#37](https://github.com/aakshintala/Fiber/issues/37) under epic
[#31](https://github.com/aakshintala/Fiber/issues/31). The decision record, with
rationale and rejected alternatives, is on #37. This directory is the current
contract while the work is in flight.

Slices:

* [01-slice-1.md](01-slice-1.md) routing seam, presets, credential store,
  Responses and Chat Completions, OpenCode Go

Later slices get their own file when they start. See **Sequencing** below.

## Problem

Fiber reaches models through one provider. `ProviderId` has a single variant,
and provider identity leaks into roughly 45 files through three closed enums:

* `ProviderId { codex }` in `src/core/config/model_provider.zig`
* `CredentialSource { chatgpt_subscription }` in `src/core/shared/types.zig`
* `Bundle.AuthStrategy { chatgpt }` in `src/core/gateway/provider_set.zig`

Those enums are switched on, sized into arrays, defaulted to `.codex`, and
rendered by name. Adding a provider today means editing every one of those
sites, which is what the deleted Grok provider cost.

A provider is not a protocol. One account can serve several wire formats, chosen
per model, so the model identifier is the routing key.

## Reference implementation

pi (`@earendil-works/pi-ai`) is the reference for this workstream. The rule is
"what does pi do" unless there is a stated reason to diverge. Deliberate
divergences are marked **Divergence** below.

## Vocabulary

| Term | Meaning |
| --- | --- |
| `Connection` | A configured endpoint: credential, default protocol, default base URL, default compat flags, model entries |
| `ModelRef` | A parsed `connection/model` reference, split on the first slash |
| `Route` | Connection plus model plus protocol, resolved and ready to send |
| `ProtocolAdapter` | One wire format, translating to Fiber's event model |
| `AuthScheme` | Login, refresh, logout for one credential kind |
| `CatalogSource` | Where a connection's model list comes from |
| `ModelInfo` | One model's identity, capabilities, limits, prices and compat flags |

`Provider` is retired from this subsystem. It currently means six different
things. The repo-wide context-plus-function-pointer idiom keeps the name
elsewhere.

## Layout

`src/gateway/` becomes `src/protocols/`: `responses.zig`,
`chat_completions.zig`, `http.zig`, `sse.zig`.

`src/core/gateway/` becomes `src/core/routing/`: `connection.zig`, `route.zig`,
`catalog.zig`, `model_info.zig`.

`model_provider.zig`, `gateway_provider.zig` and `provider_set.zig` are deleted.

Renaming the remaining `gateway_*` identifiers (about 797 occurrences, including
`gateway_retry_count`, `gateway_system_prompt`, `gateway_messages`) is a
separate mechanical PR after slice 1, to avoid colliding with in-flight
branches.

## What is code, what is data, what is Lua

The core ships only generic mechanisms. Zig under `src/core/` never names a
vendor; the check is a grep for `codex`, `chatgpt` or `openai` identifiers
there.

**Code (Zig):**

* protocol adapters: Responses, Chat Completions, Anthropic Messages. Each
  implements a public wire format and owns a typed compat struct
* auth schemes: none, API key, environment reference, OAuth PKCE and device flow
* catalog sources: a static list, and an OpenAI-style `/models` fetch
* the routing seam, credential store, history transform, usage accounting

**Data (JSON):**

* connections, including built-in presets, which use the same schema and parser
  as user configuration and are embedded with `@embedFile`
* model entries: protocol, base URL, compat flags, capabilities, limits, prices
* `extra_headers` and `extra_body`, the generic escape hatches. `extra_body` is
  merged into the request and covers vendor routing knobs (pi's
  `openRouterRouting`, `vercelGatewayRouting`, `chatTemplateKwargs`) without a
  flag for each

**Lua (after the extension system, [#25](https://github.com/aakshintala/Fiber/issues/25)):**

* catalog adapters for vendor-specific discovery, such as Databricks Unity
  Catalog and the Codex catalog
* quota adapters, which read credit and window signals
* nonstandard login flows that the generic auth schemes cannot express

Bundled Lua adapters travel with the binary, so built-in and user-installed
differ only in origin.

This puts a firm requirement on #25: catalog and quota adapters need outbound
HTTP and access to their connection's credential. The security contract must be
designed against that, not a toy case.

## Decisions

Numbers are stable; #37 carries the rationale for each.

### Routing

1. **Qualified references.** A model is always written `connection/model`, split
   on the first slash: `codex/gpt-5.5`, `openrouter/anthropic/claude-sonnet-5`,
   `local/qwen2.5:7b`. Two levels, never three: the protocol is an
   implementation fact, not user intent, and must not end up stored in sessions
   and settings.
2. **No bare-name resolution.** There is no default connection and no catalog
   search. Both make a stored name route somewhere else later.
3. **Aliases.** `"aliases": { "sonnet": "openrouter/anthropic/claude-sonnet-5" }`
   in settings. The `/model` picker also does prefix matching, because it shows
   the match before you confirm.
4. **Resolution happens only at input.** Sessions, settings written by Fiber and
   subagent records always store the full reference. Editing an alias never
   changes what an existing session runs.
5. **Routing never waits on the network.** Resolving a reference is a lookup
   against connection records and known model entries.

### Connections

6. **Per-model overrides inside a connection.** A model entry may override
   protocol, base URL and compat flags; otherwise the connection's defaults
   apply. Databricks needs three protocols behind one credential and namespace,
   and OpenRouter serves both Chat Completions and Anthropic Messages.
7. **Declared compat flags, no sniffing.** Adapters never branch on connection
   ID or match on the URL. **Divergence:** pi's `detectCompat` sniffs about a
   dozen vendors from `provider` and `baseUrl`. Fiber users cannot patch Zig, so
   every quirk must be a field they can set; a preset carries the known values
   and custom connections start from a strict-standard default.
8. **Strict validation.** Unknown keys in a connection are rejected, consistent
   with [#26](https://github.com/aakshintala/Fiber/issues/26). A wrong flag
   fails at request time naming the connection.
9. **Connections are profile-only.** They live in `~/.fiber/settings.json`,
   never in project `.fiber.json`. A committed repo file must not be able to
   redirect prompts to its own endpoint.
10. **`FIBER_MODEL` and the `model` setting take a full reference.** There is no
    `FIBER_PROVIDER`.

### Credentials

11. **One file-backed credential store on every platform**, reusing the private
    directory, lock and durable replace that the ChatGPT store has today.
    ChatGPT tokens become its first entry. The macOS keychain is not used: Fiber
    reaches it through `/usr/bin/osascript`, so the item trusts `osascript`
    rather than Fiber, and any process running as the user can read it. Fiber
    also has no OS sandbox (removed upstream in `98be58b6`).
12. **Three credential kinds:** OAuth owned by a scheme, a stored API key, and
    an environment reference that stores the variable name and never the secret.
13. **Login is per connection.** `fiber auth login opencode-go`. Logout is
    honest when a vendor has no revocation endpoint.
14. **Protecting the store from the agent is the permission layer's job**, via a
    built-in deny on tool reads of the credential path. Tracked separately; it
    applies to `chatgpt-auth.json` today.

### Capabilities and catalogs

15. **Three layers, later overriding earlier:** preset metadata, live catalog,
    user `model_metadata`. A model none of them describes still runs, with no
    vision and an unknown context window, which disables automatic compaction
    and says so once.
16. **No runtime third-party registry.** Fiber does not fetch models.dev or
    similar at startup. **Divergence:** pi refreshes from its own service
    (`https://pi.dev/api/models/providers/<id>`, etag, at most every four
    hours). Fiber has no such service, and adding a third-party network
    dependency at startup is not worth the freshness.
17. **Static presets in slice 1.** `openai_codex_models.zig` and its
    vendor-specific parsing are deleted, which also closes
    [#28](https://github.com/aakshintala/Fiber/issues/28). Vendor catalogs
    return as Lua adapters rather than being written twice.
18. **Per-connection catalog state and freshness.** Each connection keeps its
    own catalog, refresh time and error; one refresh in flight each; last-good
    served during failures; invalidated when credentials change. The `/model`
    picker groups by connection and marks stale or failed ones while still
    listing their last-good models.
    [#66](https://github.com/aakshintala/Fiber/issues/66) is rescoped to this.

### History across routes

19. **Tag provider state with its origin** (connection, protocol, model) and
    replay it only to an exact match. Encrypted reasoning is opaque to everyone
    but the issuing vendor.
20. **Apply pi's transform on a mismatch** (`api/transform-messages.js`): drop
    redacted or encrypted reasoning, convert plaintext reasoning to a text
    block, normalize tool call IDs (Responses IDs reach 450+ characters with
    `|`; Anthropic requires `^[a-zA-Z0-9_-]+$` up to 64), strip Gemini
    `thoughtSignature`, replace images with a placeholder for non-vision models,
    synthesize results for orphaned tool calls, and skip errored or aborted
    assistant turns. One transcript note per switch.

### Sessions

21. **Sessions store the full reference plus a non-secret fingerprint** of
    endpoint and auth kind (including an environment variable's name, never the
    secret). Rotating a key does not trip it; repointing a base URL does.
22. **A changed or missing connection stops the resume before any network I/O.**
    Non-interactive runs exit 1 with `error_code` `ConnectionChanged` or
    `ConnectionMissing`, matching the existing `NonInteractivePermissionRequired`
    pattern. Passing `--model` explicitly is consent and re-pins the
    fingerprint; no dedicated flag. Subagent children check their own route and
    surface a tool error rather than a prompt.

### Permissions

23. **`reviewer_model` is its own setting**, a full reference. Its default comes
    from the connection preset (Codex names `codex-auto-review`), otherwise the
    session's own model on its own connection. Reviewer failure holds the
    action, with no fallback to another connection and no downgrade to `ask`.
    `fiber auth status` shows the resolved reviewer.

### Usage and billing

24. **Usage is keyed by full reference**, and cost uses pi's `calculateCost`
    including price tiers. An unknown price records unknown, never zero
    ([#30](https://github.com/aakshintala/Fiber/issues/30)).
25. **Billing kind is declared on the connection** (`metered` or
    `subscription`), replacing pi's inference from OAuth plus its hardcoded Kimi
    exception. OpenCode Go is subscription behind an API key.
26. **Mixed sessions show both figures**, for example `$0.42 · $3.10 (sub)`.
    **Divergence:** pi shows one total marked by the current provider, which
    misreads once routing by model name makes mixed sessions routine.
    `fiber usage --json` reports each model with its billing kind.
27. **Overage is tagged only on positive evidence.** Each generation records
    `included`, `overage` with measured cost, `metered`, or `unknown`. Signals
    come from Lua quota adapters (Codex exposes `x-codex-credits-balance` and
    used-percent windows; OpenCode Go exposes dollar windows at
    `/zen/go/v1/usage`). Ships after slice 1; the interface is not designed
    until there is an adapter to design it against.

### Features that assumed Codex

28. **Fast mode becomes generic.** `supports_fast_mode` comes from metadata, and
    the Responses adapter sends `service_tier` from a compat field set by the
    Codex preset. The `-fast` suffix check in `model_capabilities.zig` is
    removed: it infers capability from a model name.
29. **Vision fallback becomes a `vision_model` setting**, a full reference,
    unset by default. When unset the `vision` tool is not advertised and images
    become pi's placeholder text. The hardcoded `google/gemini-2.5-flash` in
    `image_provider.zig` (a Vercel AI Gateway ID that the ChatGPT endpoint
    cannot serve) and the `vision_fallback` bundle flag are both removed.

## Debt paid in slice 1

* **Two catalog interfaces for the same data.** `model_catalog.Provider` returns
  entries, `CliModelCatalogProvider` returns ID strings for the CLI. One
  `CatalogSource` returning entries; the CLI projects IDs.
* **Four shapes for model metadata**: `Capabilities`, `GatewayMetadata`,
  `ModelCatalogEntry` and the conversions between them, collapsed into
  `ModelInfo`.
* **Fixture-only code in the binary**: `agent_request_body.zig` (1,073 lines,
  "fiber-internal transport fixtures") and the Codex-only bundle in
  `builtins/gateway.zig` move to the test tree or are deleted.

## Sequencing

| Slice | Contents | Unblocks |
| --- | --- | --- |
| 1 | Routing seam, presets, credential store, Responses (Codex folded in), Chat Completions, history transform, `reviewer_model` | OpenCode Go: glm-5.3-flash, deepseek-v4.1-flash, muse-spark-1.3-contributor. #39 becomes a preset over the Responses adapter |
| 2 | Anthropic Messages adapter | #38, and `opencode-go/qwen3.8-flash` and `minimax-m3` |
| 3 | Remaining providers as presets | #41, #42, #44, #45 |
| Later | Extension system, then Lua catalog and quota adapters | #43 Databricks discovery, overage attribution, the Codex catalog |

Codex folds onto the generic Responses adapter in slice 1 rather than keeping a
second Responses path. **Divergence:** pi keeps `openai-codex-responses.js`
separate at 1,299 lines, but about 600 of those are a WebSocket transport Fiber
does not have; the rest is retry, zstd compression and service-tier pricing.
Fiber's Codex adapter already delegates input, tools and stream reduction to
`responses_protocol.zig`, and its remaining differences are headers, three
compat flags, subscription billing and a reviewer alias.

## Process

Proposal files here are scaffolding. When a slice merges, its file is deleted in
the same PR and whatever must stay true moves to `docs/model-routing.md`. The
rationale stays on #37.
