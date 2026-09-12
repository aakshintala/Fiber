# Slice 1: routing seam, presets, Responses and Chat Completions

Status: accepted, not implemented. Part of
[#37](https://github.com/aakshintala/Fiber/issues/37). Vocabulary and decisions
are in [README.md](README.md); decision numbers below refer to it.

## Outcome

Fiber reaches a model by name alone, across more than one connection, with no
vendor named under `src/core/`. The concrete test is running Fiber on OpenCode
Go against these three models, which together exercise both adapters:

| Model | Protocol | Compat |
| --- | --- | --- |
| `opencode-go/glm-5.3-flash` | Chat Completions | `supportsStore: false`, `supportsDeveloperRole: false`, `maxTokensField: "max_tokens"` |
| `opencode-go/deepseek-v4.1-flash` | Chat Completions | the same three, plus `thinkingFormat: "deepseek"` and `requiresReasoningContentOnAssistantMessages` |
| `opencode-go/muse-spark-1.3-contributor` | Responses | `sessionAffinityFormat: "openai-nosession"` |

Codex keeps working throughout, as a preset over the same adapters.

## Work

### 1. Routing seam

* `ModelRef`, `Connection`, `Route` in `src/core/routing/`
* delete `ProviderId`, `CredentialSource` and `Bundle.AuthStrategy`, and the
  roughly 45 files that switch on them, size arrays by them, default to
  `.codex`, or render them by name
* aliases and picker prefix matching (decision 3), resolution only at input
  (decision 4)
* `ModelInfo` replacing `Capabilities`, `GatewayMetadata` and
  `ModelCatalogEntry`, with the three-layer merge (decision 15)
* one `CatalogSource` interface with two implementations, static and
  OpenAI-style `/models`; the CLI projects IDs from entries

### 2. Presets

Embedded with `@embedFile`, parsed by the same parser as user configuration,
rejecting unknown keys (decision 8).

`codex`: Responses at `https://chatgpt.com/backend-api/codex/responses`;
`oauth-pkce` auth with OpenAI's client ID, issuer and token URL; the
`chatgpt-account-id` header mapped from the JWT claim
`https://api.openai.com/auth`; `extra_headers` for `originator: fiber` and
`OpenAI-Beta: responses=experimental`; session affinity headers; compat for no
`max_output_tokens`, `service_tier: priority` as fast mode, and reasoning
`minimal` sent as `low`; `billing: subscription`; `reviewer_model:
codex-auto-review`; a static model list.

`opencode-go`: Chat Completions at `https://opencode.ai/zen/go/v1` with
Responses per-model overrides; API key auth, stored or from
`OPENCODE_API_KEY`; `billing: subscription`; a static model list carrying the
flags above. `deepseek-v4.1-flash` comes from OpenCode's catalog, not from pi's
snapshot, which predates it.

### 3. Credential store

File-backed on every platform (decision 11), with the three kinds from decision
12, per-connection login and logout (decision 13), and a non-secret index so
`fiber auth list` never unlocks anything.

### 4. Protocol adapters

* **Responses**, generic, with Codex folded in. Transport (HTTP connect, cancel
  watcher, SSE line reader) moves out of the Codex file into
  `src/protocols/http.zig` and `sse.zig`, since Chat Completions needs it too.
* **Chat Completions**, reimplemented from upstream fx `5c98b992` with
  attribution, behavior checked against pi. Only the compat flags above.
* Both carry a typed compat struct; neither branches on connection ID or URL
  (decision 7).

### 5. History across routes

Provider state tagged by origin, pi's transform applied on a mismatch
(decisions 19 and 20). This is what makes switching models mid-session safe,
which is the point of dogfooding.

### 6. Sessions, permissions, usage

* fingerprint and the `ConnectionChanged` and `ConnectionMissing` paths
  (decisions 21 and 22)
* `reviewer_model` (decision 23)
* usage keyed by full reference, declared billing kind, split totals
  (decisions 24 to 26)
* `vision_model` replacing vision fallback, and generic fast mode
  (decisions 28 and 29)

## Out of scope

Anthropic Messages (slice 2), the extension system and every Lua adapter,
overage attribution, remote preset refresh, and the mechanical `gateway_*`
rename.

## Tests

The `FIBER_E2E_OPENAI_CODEX_RESPONSES_URL` override is deleted. A test
connection with a loopback `base_url` replaces it, which exercises the real
configuration path instead of a test-only hook; `isLoopbackHttpUrl` still gates
plain HTTP.

New files under `tests/e2e/`, each classified in `scripts/pgso/corpus.json`:

| File | Classification |
| --- | --- |
| `model-routing.test.ts` | Training |
| `chat-completions-protocol.test.ts` | Training |
| `cross-model-history.test.ts` | Verification-only |
| `connection-change-resume.test.ts` | Verification-only |
| `credential-store.test.ts` | Verification-only |
| `reviewer-model.test.ts` | Verification-only |

Reconsider the classification of `auth-refresh.test.ts`,
`tui-auth-source-selection.test.ts` and the `fiber models` cases in
`cli.test.ts`, whose product role changes.

Zig unit tests: reference parsing and aliases, preset parsing with unknown-key
rejection, compat application per protocol, the history transform, fingerprint
comparison.

## Documentation

* `docs/model-routing.md`, new: connections and preset schema, compat flags,
  the capability merge order, history transform rules, fingerprint semantics.
  `README.md` links to it and stays short.
* `--help` in `command_specs.zig`: `auth` subcommands per connection, `models`
  grouped by connection, `--model` taking a full reference, `reviewer_model`
  and `vision_model`.
* `CONTRIBUTING.md`: OpenCode Go as an alternative to a ChatGPT subscription
  for contributors, and the fake-connection test change.
* `CLAUDE.md`: the governing rule and its grep test, connections being
  profile-only, the credential store path.
* Delete this file when the slice merges.

## Risks

* **Size.** Removing three enums touches around 45 files. The slice is large by
  necessity: adding OpenCode Go through the old switches is the pattern this
  work exists to remove.
* **Test harness rewrite.** Fixture code that currently ships in the binary has
  to move, and the E2E fakes change shape at the same time.
* **Codex regressions.** Codex becomes a preset over a generic adapter. Its
  headers, service tier, reasoning remap and subscription billing each need a
  test that would fail if the preset were wrong.
