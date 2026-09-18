# Model routing

What is true as of #219. Later chain tickets (#287+) extend this file; nothing
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

## OpenCode presets (#219)

Two connections share one OpenCode key, stored once per connection: the
`opencode-go` preset (`src/protocols/presets/opencode-go.json`, subscription
billing, `https://opencode.ai/zen/go/v1`) and the `opencode-zen` preset
(`src/protocols/presets/opencode-zen.json`, metered billing,
`https://opencode.ai/zen/v1`). Both default to a stored `api_key`
credential; an environment reference to `OPENCODE_API_KEY` stays available
as the `env` credential kind, not the default. Per-connection login lands in
#291, Go's 403/429 errors in #392 (blocked by #293, #294), and preset loopback
turns with `model-routing.test.ts` coverage in #393 (blocked by #38, #283,
#289, #293, #294, #295); connections still
exist and validate while routing reaches Codex through today's Codex-only
path.

## Regenerating presets (#304)

The `opencode-go` and `opencode-zen` presets' model entries are generated
from models.dev at
development time by `scripts/generate_models_dev.py`, which reads
`https://models.dev/catalog.json` (or a local snapshot via `--catalog`) and
rewrites only the `models` object of `src/protocols/presets/opencode-go.json`
and `src/protocols/presets/opencode-zen.json`.
Each entry carries the id, protocol, per-model base-URL override, context and
output limits, input modalities, reasoning, and prices. Rerunning against the
same catalog is a fixpoint: run it twice and expect no diff.

Protocol comes from the model's `[provider].npm`, falling back to the
provider's: `@ai-sdk/openai` becomes Responses, `@ai-sdk/anthropic` Anthropic
Messages, `@ai-sdk/google` Google Generative AI, and anything else Chat
Completions. A model whose protocol has no adapter in the binary yet is left
out and printed as skipped; its adapter ticket reruns the script to regain it.

The connection shell (credential, default protocol, base URL, billing) and
every per-model `compat` object are hand-set and survive reruns: the script
replaces only its own generated keys. `codex.json` stays hand-written:
models.dev does not describe the ChatGPT subscription, so the script never
touches it. Each preset has its own row in the script's `PRESETS` table with
its models.dev provider id (`opencode-go`, `opencode`); regenerate one
preset with `python3 scripts/generate_models_dev.py --preset <name>`.
`scripts/tests/test_generate_models_dev.py` covers the mapping over a
checked-in catalog excerpt.

As of this run, 28 Zen models (20 Anthropic Messages, 8 Google Generative
AI) and 4 Go models (Anthropic Messages) are skipped: their adapters have
not landed (#38, #283), so the script leaves them out and prints each id.
Their adapter tickets rerun the script to regain them; loopback and
`model-routing.test.ts` coverage for the regained models lands in #393.

## Session-only model choice (#14)

* `/model` Enter and `/model <name>` apply the model, effort and fast mode
  to the running session only; `settings.json` is untouched and a new
  session starts on the previous default.
* Ctrl+S at any picker step (model, effort, fast) behaves like Enter there
  and marks the choice to be saved; finishing writes the session and the
  profile default together. Escape at any step cancels and writes nothing.
* The `/settings` effort row and `fiber models use` are unchanged: the
  first writes the session and the default, the second sets the profile
  default new sessions start from. `fiber ask --model` and `FIBER_MODEL`
  are request and process overrides for one run only; they never change
  the profile default.
## Local servers: Ollama and llama.cpp (#45)

A local OpenAI-compatible server is a user connection with
`"credential": "none"`. `connections` is profile-only, so this lives in
`~/.fiber/settings.json`, never in a project `.fiber.json`:

```json
{
  "connections": {
    "local": {
      "credential": "none",
      "protocol": "chat_completions",
      "base_url": "http://127.0.0.1:11434/v1",
      "billing": "metered",
      "models": {
        "qwen2.5:7b": { "context_window": 32768 },
        "llama3.1:8b": { "context_window": 131072 }
      }
    }
  }
}
```

llama.cpp's server speaks the same protocol at its own port; only
`base_url` changes (for example `http://127.0.0.1:8080/v1`). A model entry
needs a `context_window` when the server is the only source of truth;
compaction runs against it. A per-model `base_url` override wins over the
connection default for that model only.

What exists today: connections parse, validate, and merge over presets;
`fiber auth login <connection>` on a keyless connection reports that no
credential is needed; and request time refuses, before any network I/O,
to send a keyed credential over plain HTTP to a host other than loopback.
Routing a turn through these connections arrives with the Chat
Completions adapter (#295) and the Route redesign (#289).

### Keyless means keyless

A `none` connection carries no secret: by contract its requests send no
`Authorization` header, wired up when routing reaches user connections
(#289). `fiber auth login` on it succeeds at once today:
`fiber auth login: connection 'local' needs no credential.` A connection
that omits `credential` is not affirmatively keyless and keeps the usage
error.

### Credentials never cross plain HTTP off loopback

Remote endpoints require HTTPS while loopback HTTP is allowed. A route
whose resolved base URL is `http://` on a host other than `localhost`,
`127.0.0.0/8` or `::1` fails before connecting with an error naming the
connection; `https://` and loopback HTTP are unaffected. The check runs on
the resolved per-model base URL, so a model-entry override cannot bypass
it. Keyless connections may use `http://` anywhere, so a LAN Ollama box
works without a key while a stored key to the same box is refused.

### Strict-standard compat defaults

A connection that sets no compat flags starts from the strict standard:
the Chat Completions defaults pi applies to an endpoint it does not
recognize (`openai-completions.js` `detectCompat` with no vendor matched).
Fiber never sniffs the URL to guess quirks. Concretely, a flagless
connection assumes the standard `max_completion_tokens` field, store and
developer-role support, strict tool schemas, the `openai` thinking format,
and long cache retention — with every quirk flag off. Declared `compat`
entries layer over these once the adapter honors them (#295).

When a server rejects a standard field, the flags to try are the pi names
for that behavior: `max_tokens_field` (`"max_tokens"` for servers that
predate `max_completion_tokens`), `supports_store` (false for servers
without persistent responses), and `supports_strict_mode` (false for
servers that reject the `strict` tool-schema marker).
