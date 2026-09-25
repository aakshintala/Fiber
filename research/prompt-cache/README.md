# Prompt caching across Fiber's providers

Follow-up to [#33](https://github.com/aakshintala/fiber/issues/33) and its comment
[issuecomment-5802809634](https://github.com/aakshintala/fiber/issues/33#issuecomment-5802809634),
which already quotes the basic Anthropic and OpenAI rules (cache prefix order, what
invalidates which segment, the 5-minute default TTL, `tools`/`allowed_tools`, sticky
routing). This file does not repeat those; it answers the ten sharper questions the
basic rules leave open. Every claim below is a verbatim quote with its URL, or a file
path and line range for source code. Where a source is silent, it says "Not stated" or
"Not found" rather than filling the gap from memory. Anything worked out rather than
quoted is marked `INFERENCE`.

One correction to the brief: the model set given was "Opus 5.5, Sonnet 5, Fable 5.1,
Haiku 4.5, GPT-6 family". Anthropic's current pricing page does list Opus 5.5, Sonnet 5,
Fable 5.1 and Haiku 4.5 (see Q2). OpenAI's current docs have no "GPT-6" — the current
generation is GPT-5.6 (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`). All OpenAI
findings below are against GPT-5.6 and later, flagged wherever behaviour differs from
earlier models.

## Summary

The two findings most likely to force a design change: first, Anthropic's 20-block
lookback counts *positions*, not raw blocks — a run of consecutive `tool_use` blocks is
one position and a run of consecutive `tool_result` blocks is another, so a single
parallel-tool-call turn (15+15 blocks, each contiguous) collapses to about two
positions and stays inside the window; only genuinely non-contiguous insertions burn
through it. Second, GPT-5.6 changed OpenAI's caching model from the older
`prompt_cache_retention` (`in_memory` / `24h`) scheme to a new `prompt_cache_options`
family (`.mode`, `.ttl`, `.prewarm`) with only one TTL value (`30m`) and, unlike earlier
models, a nonzero cache-write cost (1.25x) — a Fiber client written against the old
in-memory/24h split will not compile against GPT-5.6's actual parameters. Third,
codex — the closest production reference for the ChatGPT OAuth backend — derives
`prompt_cache_key` from its own locally generated session id, never from anything
server-issued, and it never uses `previous_response_id`/server-side state at all,
resending the full input every turn. Fourth, pi (Fiber's other reference agent) places
three `cache_control` breakpoints per Anthropic request (system prompt, last tool
definition, last message), not one, and treats TTL choice as a single request-wide
setting rather than something varied per block.

---

## Q1 — Anthropic breakpoints and the 20-block lookback

**The mechanism**, quoted from the [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):

> "The lookback window is 20 blocks. The system checks at most 20 positions per
> breakpoint, counting the breakpoint itself as the first. If the system finds no
> matching entry in that window, checking stops (or resumes from the next explicit
> breakpoint, if any). On the Claude API, a run of consecutive `tool_use` blocks counts
> as one position, and so does a run of consecutive `tool_result` blocks, so a turn with
> many parallel tool calls doesn't push the previous request's entry out of the window
> on its own."

The docs' own worked example: "Turn 3: 35 blocks, breakpoint on block 35. The system
checks 20 positions (blocks 35 through 16) and finds nothing. The turn-2 entry at block
15 is one position outside the window, so there is no cache hit."

**The worked scenario** (N's only breakpoint at its last block; N+1 appends 30 blocks —
15 `tool_use` + 15 `tool_result` — and puts its only breakpoint at its new last block):

Treating "30 blocks" literally as 30 raw positions, N's write sits at lookback position
31 (30 > 20), so N+1 **does not** hit it. But the quoted rule collapses a contiguous run
of `tool_use` blocks to one position and a contiguous run of `tool_result` blocks to
another. For the concrete example given (15 parallel tool calls: all 15 `tool_use`
blocks emitted together, then all 15 `tool_result` blocks together), that is two
positions, not 30, and two is well inside the 20-position window: N+1 **does** hit the
cache N wrote. `INFERENCE`: the docs give no way to distinguish this from outside the
request; if the 30 blocks are interleaved rather than two contiguous runs, the
literal-position count applies and the answer flips to a miss.

**Recommended placement for multi-turn agents**, quoted:

> "Place `cache_control` on the last block whose prefix is identical across the
> requests you want to share a cache. In a growing conversation the final block works as
> long as each turn adds fewer than 20 blocks: earlier content never changes, so the
> next request's lookback finds the prior write. For a prompt with a varying suffix
> (timestamps, per-request context, the incoming message), place the breakpoint at the
> end of the static prefix, not on the varying block."

No "second-to-last breakpoint" wording exists anywhere on the page — not found.

**Automatic / top-level caching mode** — confirmed to exist. Quoted:

> "Add a single `cache_control` field at the top level of your request. The system
> automatically applies the cache breakpoint to the last cacheable block and moves it
> forward as conversations grow. Best for multi-turn conversations where the growing
> message history should be cached automatically."

Edge cases (same page): "If the last block already has an explicit `cache_control` with
the same TTL, automatic caching is a no-op. If the last block has an explicit
`cache_control` with a different TTL, the API returns a 400 error. If 4 explicit
block-level breakpoints already exist, the API returns a 400 error (no slots left for
automatic caching)." Anthropic's own pages do not scope automatic caching to particular
models or APIs — not stated. (OpenRouter, a secondary integrator rather than Anthropic
itself, separately documents in its own docs that it supports the top-level field "on
the Anthropic, Google Vertex AI, Azure, and Amazon Bedrock providers, as well as Claude
Platform on AWS" — see Q7 — but that is OpenRouter describing its own routing, not an
Anthropic statement.)

**Implication for Fiber**: a normal agentic step (one batch of parallel tool calls, each
kind contiguous) does not by itself burn the lookback window; only interleaving
`tool_use`/`tool_result` blocks with other content, or spanning many separate turns
before re-establishing a breakpoint, would.

---

## Q2 — Anthropic TTL mixing and pricing

**Ordering constraint**, quoted:

> "You can use both 1-hour and 5-minute cache controls in the same request, but with an
> important constraint: Cache entries with longer TTL must appear before shorter TTLs
> (that is, a 1-hour cache entry must appear before any 5-minute cache entries)."

**Billing mechanics**, quoted:

> "When mixing TTLs, the API determines three billing locations in your prompt:
> 1. Position `A`: The token count at the highest cache hit (or 0 if no hits).
> 2. Position `B`: The token count at the highest 1-hour `cache_control` block after `A`
>    (or equals `A` if none exist).
> 3. Position `C`: The token count at the last `cache_control` block."
>
> "You'll be charged for: 1. Cache read tokens for `A`. 2. 1-hour cache write tokens for
> `(B - A)`. 3. 5-minute cache write tokens for `(C - B)`."

**Scenario** (earlier content cached at 5m; a later request adds a single 1h breakpoint
at its end, nothing else changes): applying A/B/C, A = the old 5m-cached prefix (a cache
read, at the 5m read rate — Anthropic's read price does not vary by the TTL that wrote
the entry). The new breakpoint is itself the highest (and only) 1-hour block, so B sits
at the same position as C, the end of the prompt. Billed: a cache read for A, a 1-hour
write for `(B − A)` (the newly appended tail), and a 5-minute write for `(C − B) = 0`.
Going forward the newly written segment carries a 1-hour TTL. The docs give no explicit
worked example matching this exact scenario, so this is `INFERENCE` derived from the
quoted A/B/C rule, not a directly quoted answer; in particular, the docs do not state
whether the *earlier*, now-read segment's own TTL is retroactively extended to 1 hour —
only the newly written segment is documented as 1-hour.

**Does a read refresh the TTL?** Quoted: "By default, the cache has a 5-minute
lifetime. The cache is refreshed for no additional cost each time the cached content is
used." And: "The lifetime is measured from the start of the request that writes or
reads the cache entry, not from the end of its response." Together these state that a
read resets the countdown, timed from that read request's start, to the *same*
duration the entry was written with — a 5-minute entry stays a 5-minute entry after a
refresh; there is no stated upgrade to 1 hour from reading alone.

**Exact pricing**, from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing):

| Model | Base input | 5m cache write | 1h cache write | Cache read/refresh | Output |
|---|---|---|---|---|---|
| Claude Opus 5.5 | $4/MTok | $5/MTok | $8/MTok | $0.20/MTok (0.05x) | $20/MTok |
| Claude Sonnet 5 | $2/MTok | $2.50/MTok | $4/MTok | $0.20/MTok (0.1x) | $10/MTok |
| Claude Fable 5.1 | $10/MTok | $12.50/MTok | $20/MTok | $0.25/MTok (0.025x) | $50/MTok |
| Claude Haiku 4.5 | $1/MTok | $1.25/MTok | $2/MTok | $0.10/MTok (0.1x) | $5/MTok |

Quoted footnotes: "Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1
are priced at 0.025x the base input price." / "Cache hits and refreshes on Claude Opus
5.5 are priced at 0.05x the base input price." / "All other models use the standard
0.1x multiplier." Also: "The $2/$10 per million input/output token pricing for Claude
Sonnet 5, announced at launch as introductory pricing through August 31, 2026, is now
the standard price."

**Implication for Fiber**: cost accounting must read the split `cache_creation`
sub-fields (Q3) rather than assume every write is the 1.25x/5m rate — Fable 5.1 and
Opus 5.5 have different read multipliers from Sonnet 5/Haiku 4.5.

---

## Q3 — Anthropic usage fields and minimum cacheable length

Field names, quoted from the prompt caching guide (the raw `/api/messages` reference
page did not render its response schema through the tooling used for this research;
this is sourced from the caching guide, which documents the same fields — flagged as a
gap below):

> "`cache_creation_input_tokens`: Number of tokens written to the cache when creating a
> new entry."
> "`cache_read_input_tokens`: Number of tokens retrieved from the cache for this
> request."
> "`input_tokens`: Number of input tokens which were not read from or used to create a
> cache (that is, tokens after the last cache breakpoint)."

**Split by TTL: yes.** Verbatim example from the same page:

```json
{
  "usage": {
    "input_tokens": 2048,
    "cache_read_input_tokens": 1800,
    "cache_creation_input_tokens": 248,
    "output_tokens": 503,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 148,
      "ephemeral_1h_input_tokens": 100
    }
  }
}
```

`cache_creation_input_tokens` is the sum; `cache_creation.ephemeral_5m_input_tokens` /
`cache_creation.ephemeral_1h_input_tokens` split it by TTL. Corroborated on the
tool-use-with-caching page: "In the response `usage`, these writes appear under
`cache_creation.ephemeral_5m_input_tokens`, so you may see 5-minute cache writes even
when every `cache_control` you set uses a 1-hour TTL" — referring to the automatic
breakpoint the API places on server-tool results (see Q4).

**Minimum cacheable prompt length**, quoted table:

| Model(s) | Minimum tokens |
|---|---|
| Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude Opus 5, Claude Fable 5, Claude Mythos 5 | 512 |
| Claude Sonnet 5, Claude Opus 4.8, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Opus 4.1, Claude Opus 4, Claude Sonnet 4 | 1,024 |
| Claude Haiku 4.5 | 4,096 |

For Fiber's four target models: Opus 5.5 = 512, Sonnet 5 = 1,024, Fable 5.1 = 512,
Haiku 4.5 = 4,096.

Behaviour under the minimum, quoted: "Shorter prompts cannot be cached, even if marked
with `cache_control`. Any requests to cache fewer than this number of tokens will be
processed without caching, and no error is returned. To verify whether a prompt was
cached, check the response usage fields: if both `cache_creation_input_tokens` and
`cache_read_input_tokens` are 0, the prompt was not cached."

**Implication for Fiber**: Haiku 4.5's 4,096-token minimum is 4x-8x the other three
models' — a short system prompt plus a small tool set could clear the minimum on Opus
5.5/Sonnet 5/Fable 5.1 but silently fail to cache at all on Haiku 4.5, with no error
returned to detect it except reading the usage fields.

---

## Q4 — Anthropic invalidation edge cases

**Model switch**: not stated. The invalidation table below and every other passage
found says nothing about changing the model itself; the only model-adjacent rows concern
thinking-block portability across model generations, a different mechanism.
`INFERENCE`: since price and minimum-cacheable-length are model-specific, a cache entry
almost certainly can't be shared across models, but this is reasoning, not an Anthropic
statement.

Full current invalidation table, quoted from the prompt caching guide's "What
invalidates the cache" section:

| What changes | Tools cache | System cache | Messages cache |
|---|---|---|---|
| Tool definitions | invalidated | invalidated | invalidated |
| Web search / citations toggle | preserved | invalidated | invalidated |
| Speed setting (`speed: "fast"` vs standard) | preserved | invalidated | invalidated |
| `tool_choice` | preserved | preserved | invalidated |
| Images added/removed | preserved | preserved | invalidated |
| Thinking parameters | model-specific | model-specific | invalidated |
| `output_config.effort` | model-specific | model-specific | invalidated |

`tool_choice`, quoted precisely: "Changes to `tool_choice` parameter only affect
message blocks" — tools and system caches are explicitly preserved, only messages
invalidated. Also: "If you need to vary `tool_choice` mid-conversation, consider
placing cache breakpoints before the variation point."

**`defer_loading` / tool search**, quoted from
[tool-use-with-prompt-caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching):

> "Deferred tools are not included in the system-prompt prefix. When the model
> discovers a deferred tool through tool search, the definition is appended inline as a
> `tool_reference` block in the conversation history. The prefix is untouched, so prompt
> caching is preserved. ... This means adding tools dynamically through tool search does
> not break your cache. You can start a conversation with a small set of always-loaded
> tools (cached), let the model discover additional tools as needed, and keep the same
> cache hit across every turn."

Fiber's specific sub-question — a tool declared `defer_loading: true` from the start of
the session, discovered later, versus a *new* `defer_loading` tool inserted into the
`tools` array mid-session: the docs only describe the first case (discovery of an
already-declared deferred tool preserves the prefix, since the tool sits outside the
prefix until then). They do not address inserting a brand-new tool definition into the
`tools` array mid-session. `INFERENCE`: per the "Tool definitions | invalidated" row
above, adding *any* new entry to the `tools` array — deferred or not — changes tool
definitions and should invalidate the whole cache; the deferred-tool guarantee is about
discovery of a tool declared at session start, not about adding one later. Not
contradicted by the docs, but not stated either — worth verifying empirically via
`cache_read_input_tokens` before treating it as settled.

One further finding beyond the ticket's basic rules, quoted: "When your request has
prompt caching enabled and Claude uses a server tool such as web search, web fetch, or
code execution, the API automatically places a cache breakpoint on the server tool
result before running the next iteration of the agentic loop... This automatic
breakpoint always uses the default 5-minute TTL, independent of any TTL you set on your
own `cache_control` markers."

**Implication for Fiber**: `tool_choice` and tool-search discovery are both cache-safe
levers for varying model behaviour mid-session; adding a genuinely new tool definition
mid-session, even one marked deferred, is not verified safe and should be tested before
being relied on.

---

## Q5 — OpenAI Responses API

GPT-5.6 replaced/extended the older `prompt_cache_retention` scheme; both are described
below, but GPT-5.6-and-later — the model set actually current at this writing — uses the
second one.

**1. `prompt_cache_key` semantics.** Pre-GPT-5.6, quoted: "use a stable
`prompt_cache_key` for requests that share a reusable prefix to help route related
requests to the same cache." GPT-5.6+, quoted: "the key is not needed to optimize
caching. You can use separate keys to maintain separate cache accounting" (for
customers, users, or workspaces) — the key becomes optional accounting metadata, not a
routing input. Rate-limit guidance, quoted: "For busy groups, aim for about 15 requests
per minute in total across all prefixes using each key. Partition higher-volume traffic
across multiple keys using a stable, deterministic mapping." Source:
[prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

**2. `prompt_cache_retention` exact values.** For earlier models: `"in_memory"` —
"Entries typically remain active for around 5 to 10 minutes of inactivity, up to one
hour" — and `"24h"` — "Extended retention typically keeps entries available for around
30 minutes and can retain them for up to 24 hours." 24h is supported by, quoted: "`gpt-5.5`,
`gpt-5.5-pro`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1`, `gpt-5.1-codex`,
`gpt-5.1-codex-mini`, `gpt-5.1-chat-latest`, `gpt-5`, `gpt-5-codex`, and `gpt-4.1`" —
GPT-5.6 is not in that list. **GPT-5.6+ uses a different parameter**, quoted: "Use
`prompt_cache_options.ttl` to control the minimum cache lifetime. The only supported
value, `30m`, is also the default." GPT-5.6+ also has `prompt_cache_options.mode`
(`"implicit"`, default — a breakpoint auto-placed at the end of the latest eligible
message — or `"explicit"`, only developer-placed breakpoints count; "Only implicit
caching is supported" on earlier models) and `prompt_cache_breakpoint`, a per-block
marker ("Each request can create up to four cache writes"; "`additional_tools` input
items do not currently accept `prompt_cache_breakpoint`"; "Top-level `instructions`
cannot contain an explicit breakpoint").

**3. Does extended retention cost extra?** Not cleanly stated as a duration-specific
charge. Earlier models: "No additional cache-write charge." GPT-5.6+: "cache writes cost
1.25× the standard, uncached input-token rate" — but GPT-5.6+ has no in_memory/24h
choice at all (only `ttl: "30m"`), so the "does 24h cost extra" question doesn't apply
to it; the 1.25x write cost is unconditional on GPT-5.6+, not tied to a retention
choice. Not stated: any price difference between `"24h"` and `"in_memory"` on earlier
models. Prewarm requests (GPT-5.6+, `prompt_cache_options.prewarm: true`), quoted:
"Tokens written to the cache during a prewarm request are billed at the standard
cache-write rate."

**4. Usage fields.** Quoted: "Track `usage.input_tokens_details.cached_tokens`,
`usage.input_tokens_details.cache_write_tokens`, input-token counts, latency, and
realized cost." Confirmed on the diagnostics sub-page too.

**5. Minimum length.** GPT-5.6+, quoted: "The minimum cacheable prompt length is 1,024
tokens for GPT-5.6 and later." Earlier models: "Varies by request settings, including
tools, images, output schemas, reasoning effort, and verbosity" — no fixed number.

**6. `allowed_tools` and cache preservation.** Quoted: "Use [`allowed_tools`] to
restrict which tools are callable while keeping the supplied `tools` list stable." And,
for suppressing a tool entirely: "Set [`tool_choice`] to `"none"` instead of removing
the tool definitions." Both preserve the cached prefix; only `allowed_tools` was asked
about, but the doc pairs it with the `tool_choice: "none"` recommendation.

**7. Per-model?** Quoted: "A different model can use different weights and caching
behavior." This is presented to explain why a cached prefix doesn't carry across
models, but OpenAI does not state outright "switching models invalidates the cache" —
treat as strongly implied, not directly quoted.

**8. `previous_response_id` vs resending input.** `previous_response_id` lets the
server retain prior turns' state so the client needn't resend the full `input`. Quoted,
on billing (not caching): "Even when using `previous_response_id`, all previous input
tokens for responses in the chain are billed as input tokens in the API." Not stated:
any explicit comparison of cache-hit behaviour between `previous_response_id` and
manually resending the full `input` each turn — the conversation-state guide and the
prompt-caching guide do not cross-reference each other on this point. `INFERENCE`:
since caching is defined by whether "the entire rendered prefix" matches, and
`previous_response_id` changes what state the server treats as context rather than what
gets rendered, both approaches likely produce the same rendered prefix and the same
cache behaviour — but this is not stated by OpenAI.

**Implication for Fiber**: any OpenAI client code must branch on model generation —
`prompt_cache_retention` for pre-GPT-5.6, `prompt_cache_options` for GPT-5.6+ — they are
not interchangeable parameters, and GPT-5.6+ introduces a cache-write cost that did not
exist on earlier models.

---

## Q6 — ChatGPT/codex OAuth backend (from codex source)

Source: sparse checkout of `openai/codex`, `codex-rs/` (all paths below relative to
that directory).

**`prompt_cache_key` derivation**, `core/src/client.rs:585-597`:

```rust
fn prompt_cache_key(&self, responses_metadata: &CodexResponsesMetadata) -> String {
    if let Some(prompt_cache_key) = &self.prompt_cache_key_override {
        return prompt_cache_key.clone();
    }
    if let SessionSource::Internal(source) = &self.state.session_source
        && let Some(parent_thread_id) = responses_metadata.parent_thread_id {
        return format!("{source}:{parent_thread_id}");
    }
    responses_metadata.session_id.clone()
}
```

The value is codex's own locally generated session id, not anything derived from the
OpenAI/ChatGPT account or a server-issued conversation id. Internal sub-agents key off
`"{source}:{parent_thread_id}"` so a root session and its subagents share a key without
colliding with unrelated sessions. There is no branch on auth mode (API key vs ChatGPT
OAuth) in this function. Confirmed by test `core/tests/suite/prompt_cache_key.rs:39-160`
(`api_key_subagent_uses_session_id_as_prompt_cache_key`), which asserts a root request
and its spawned-subagent child both carry `promptCacheKey == expected_session_id` even
with different `thread-id` headers.

A separate, ChatGPT-specific mechanism exists alongside the JSON-body key —
`core/src/client.rs:599-601`:

```rust
// ChatGPT derives cache affinity from the Responses session-id header. Keep the
// actual session identity in turn metadata, hooks, and history/notes requests.
```

The `session-id` HTTP header (distinct from the body's `prompt_cache_key`) is what the
ChatGPT backend actually uses for cache-affinity routing.

**Other cache parameters**: a full-tree grep for `prompt_cache_retention` /
`cache_retention` returns zero matches, and the `ResponsesApiRequest` struct
(`codex-api/src/common.rs:278-303`) has no `prompt_cache_retention`,
`prompt_cache_options`, or `prompt_cache_breakpoint` field — codex relies entirely on
`prompt_cache_key` plus a stable rendered prefix. It also always sends `store: false`
(`client.rs:1007`), so it never uses `previous_response_id`/server-side state — every
turn resends the full input.

**Tool ordering**: `core/src/tools/registry.rs:294-298` uses an `IndexMap<ToolName,
RegisteredTool>` (deterministic insertion order), not a `HashMap`. `entries()`
(`registry.rs:428-430`) returns `self.tools.values()` in that order;
`spec_plan.rs:554-591` (`build_model_visible_specs`) iterates it, appends hosted/
built-in tools after, with no sort call anywhere. Serialization
(`tools/src/tool_spec.rs:145-149`, `create_tools_raw_json_for_responses_api`) uses
`serde_json::to_raw_value` on the slice, preserving that order byte-for-byte. Not fully
traced: the order MCP servers/tools are first inserted into the registry across process
restarts — flagged as an open gap by the researching agent, not asserted proven.

**ChatGPT vs API-key path**, `model-provider-info/src/lib.rs:599-609`:

```rust
pub fn supports_codex_backend_routes(&self) -> bool {
    self.is_openai()
        && self.base_url.as_deref().is_none_or(|base_url| {
            base_url.trim_end_matches('/').ends_with("/backend-api/codex")
        })
}
```

The only caching-adjacent thing gated by the ChatGPT-vs-API-key host check
(`core/src/client.rs:414-422`, `is_internal_metadata_destination`) is whether internal
tool metadata (encrypted function-call args, internal chat-message metadata) is
stripped from `input` items before sending to non-OpenAI-family destinations
(`client.rs:944-961`) — which changes the rendered prefix and therefore cache behaviour
indirectly. `prompt_cache_key` computation itself is identical regardless of auth mode.

**Implication for Fiber**: the ChatGPT OAuth path is only reachable by hitting a
`/backend-api/codex`-suffixed base URL with a `session-id` header carrying the
cache-affinity key; codex's design (locally generated session id, no server-side state)
is a directly copyable pattern for Fiber's own OAuth client.

---

## Q7 — OpenRouter

Source: [OpenRouter prompt caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
(the old `/docs/features/prompt-caching` URL now redirects here).

**`cache_control` pass-through for Anthropic**, quoted: "There are two ways to enable
prompt caching with Anthropic: Automatic caching: Add a single `cache_control` field at
the top level of your request... Explicit cache breakpoints: Place `cache_control`
directly on individual content blocks for fine-grained control... There is a limit of
four explicit breakpoints." It is caller-supplied pass-through — OpenRouter does not
inject breakpoints itself — but it does translate marker shape across providers when
routing, quoted: "The Responses API supports automatic caching via top-level
`cache_control`. Anthropic-style per-block `cache_control` inside input items is not
exposed through the Responses API — instead use OpenAI's per-block
`prompt_cache_breakpoint`, which OpenRouter converts to a default `cache_control`
breakpoint when the request is routed to Anthropic or Google. Note that
`prompt_cache_breakpoint` carries no ttl."

**Automatic caching for OpenAI and others**, quoted: "Prompt caching with OpenAI is
automated and does not require any additional configuration. There is a minimum prompt
size of 1024 tokens." Billing: "Cache writes: no cost on models before the GPT-5.6
family. GPT-5.6 and later charge cache writes at 1.25x the price of the original input
pricing... Cache reads: (depending on the model) charged at 0.25x or 0.50x." Others
documented as automatic: Grok, Moonshot AI (0.25x reads, no write cost), Groq (0.5x
reads, "Currently available on Kimi K2 models"). Alibaba Qwen is the exception —
explicit, quoted: "Alibaba prompt caching requires explicit cache breakpoints. Add
`cache_control: { "type": "ephemeral" }` to content blocks you want to cache, using the
same syntax as Anthropic explicit caching."

**Sticky routing, full rules**, quoted:

> "To maximize cache hit rates, OpenRouter uses provider sticky routing to route your
> subsequent requests to the same provider endpoint after a cached request. This works
> automatically with both implicit caching (e.g. OpenAI, DeepSeek, Gemini 2.5) and
> explicit caching (e.g. Anthropic `cache_control` breakpoints)."
> "Sticky routing only activates when the provider's cache read pricing is cheaper than
> regular prompt pricing."
> "If the sticky provider becomes unavailable, OpenRouter automatically falls back to
> the next-best provider." "If the sticky provider returns an error, the cache is not
> updated, allowing the next request to be re-routed."
> "Sticky routing is not used when you specify a manual provider order via
> `provider.order` — in that case, your explicit ordering takes priority."
> "Sticky sessions expire after 10 minutes of inactivity. Each successful request resets
> the timer."
> "Sticky routing is tracked at the account level, per model, and per conversation. By
> default, OpenRouter identifies conversations by hashing the first system (or
> developer) message and the first non-system message in each request."
> "For more explicit control over sticky routing, you can pass a `session_id` in your
> request. When a `session_id` is present, OpenRouter uses it directly as the sticky
> routing key instead of deriving one from message hashing... The `session_id` must be
> at most 256 characters. If neither is set, OpenRouter falls back to the OpenAI-style
> `prompt_cache_key` request field as the sticky routing key."
> "When `session_id` is set, sticky routing activates on any successful request — even
> before cache usage is observed... Without `session_id`, sticky routing only activates
> after a cache hit is detected."

**Usage fields**, quoted example:

```json
{
  "usage": {
    "prompt_tokens": 10339,
    "completion_tokens": 60,
    "total_tokens": 10399,
    "prompt_tokens_details": {
      "cached_tokens": 10318,
      "cache_write_tokens": 0
    }
  }
}
```

Field defs: "`cached_tokens`: Number of tokens read from the cache (cache hit)."
"`cache_write_tokens`: Number of tokens written to the cache. This appears on the first
request when establishing a new cache entry." A separate top-level field, quoted:
"The `cache_discount` field in the response body will tell you how much the response
saved on cache usage. Some providers, like Anthropic, will have a negative discount on
cache writes, but a positive discount... on cache reads." Marker translation is
reported through this same shape: "Cache activity is reported in
`usage.input_tokens_details` (Responses) and `usage.prompt_tokens_details` (Chat
Completions)."

**Implication for Fiber**: if Fiber ever sets `provider.order` on an OpenRouter request,
it loses sticky routing and therefore the cache; passing an explicit `session_id` (or
`prompt_cache_key`) is a stronger, immediate substitute for the default message-hash
derivation.

---

## Q8 — Databricks Model Serving (Claude)

**Is caching supported?** Yes, but scoped to one integration path. Quoted from
[Score foundation models](https://docs.databricks.com/aws/en/machine-learning/model-serving/score-foundation-models#prompt-cache):
"Prompt caching is supported for Databricks-hosted Claude models as part of Foundation
Model APIs." A separate fetch of the
[External Models](https://docs.databricks.com/aws/en/machine-learning/foundation-models/external-models/)
page (Databricks configured to proxy calls to Anthropic's own API with a customer API
key) found zero mentions of "cache"/"caching" anywhere on the page. Not stated / not
found: whether `cache_control` is honoured when Databricks is used purely as an
External-Models pass-through to Anthropic, rather than a Databricks-hosted endpoint.

**How it's requested**, quoted: "You can specify the `cache_control` parameter in your
query requests to cache the following: Text content messages in the messages.content
array. Thinking messages content in the messages.content array. Images content blocks
in the messages.content array. Tool use, results and definitions in the tools array."
Example (request-side only, verbatim):

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's the date today?",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    }
  ]
}
```

From the [API reference](https://docs.databricks.com/aws/en/machine-learning/foundation-model-apis/api-reference):
"`cache_control` — String — Enables caching for your request. This parameter is only
accepted by Databricks-hosted Claude models." Databricks uses Anthropic's native
`cache_control: {"type": "ephemeral"}` shape directly, not a renamed parameter.

**Usage fields**, quoted from the API reference: "`cache_read_input_tokens` — Integer —
Number of input tokens read from the prompt cache. Returned as a top-level usage field
for Databricks-hosted Claude endpoints when caching is active." and
"`cache_creation_input_tokens` — Integer — Number of input tokens written to the prompt
cache. Returned as a top-level usage field for Databricks-hosted Claude endpoints when
caching is active." — Anthropic's own field names, unmodified. Also present:
`prompt_cache_retention`, quoted: "The retention policy for the prompt cache. Set to
`"24h"` to enable extended prompt caching, which keeps cached prefixes active for
longer, up to a maximum of 24 hours" — a Databricks-specific parameter name for the
concept Anthropic itself calls a 1-hour `ttl`. Not found: a full example response body
with these fields populated.

**Implication for Fiber**: if Fiber reaches Claude through Databricks' Foundation Model
APIs (Databricks-hosted), the same `cache_control` rules as direct Anthropic apply; if
it reaches Claude through Databricks' External Models pass-through, caching support is
undocumented and needs a live test, not an assumption.

---

## Q9 — OpenCode Go

Sources: [opencode.ai/docs/go](https://opencode.ai/docs/go/) and
[opencode.ai/docs/providers](https://opencode.ai/docs/providers/).

**Wire protocol(s)**: not one protocol — a per-model table of three different shapes,
quoted (endpoint / SDK package / models):

- `https://opencode.ai/zen/go/v1/responses` with `@ai-sdk/openai` — Grok 4.7/4.6, GPT
  6 Luna, GPT 5.6 Luna, Muse Spark models (OpenAI Responses-API-shaped).
- `https://opencode.ai/zen/go/v1/chat/completions` with `@ai-sdk/openai-compatible` —
  GLM, Kimi, DeepSeek, MiMo, LongCat models (OpenAI Chat-Completions-shaped).
- `https://opencode.ai/zen/go/v1/messages` with `@ai-sdk/anthropic` — MiniMax
  M3/M2.7/M2.5, Qwen3.8 Max/Flash models (Anthropic-Messages-shaped).

No Claude/Anthropic-branded model is itself in the OpenCode Go catalog — the
`/v1/messages` endpoint serves non-Anthropic models (MiniMax, Qwen) in Anthropic's wire
shape, not real Claude.

**Prompt caching**: quoted, on client requirements: "Send a stable session ID in
`x-opencode-session` for each conversation so we can optimize routing and prompt
caching." The pricing table has explicit cache columns — header "Model | Input | Output
| Cached Read | Cached Write | Monthly limit" — with per-model rates, e.g. "GLM-5.3-Flash
$0.15 $0.50 $0.03 -" (cached write shown as "-", i.e. not charged, for that model). The
usage-estimate section models cache hits as a large share of tokens per request, e.g.
"GLM-5.3-Flash — 1,000 input, 55,000 cached, 200 output tokens per request." Not stated
/ not found: the exact response-usage JSON field name(s) OpenCode Go returns for cache
reads/writes — no equivalent of OpenRouter's `cached_tokens`/`cache_write_tokens` or
Anthropic's `cache_read_input_tokens` is documented on this page.

**Implication for Fiber**: caching is real and billed on OpenCode Go, and sending a
stable `x-opencode-session` header is the documented lever, but Fiber cannot read cache
hit/miss telemetry back from OpenCode Go responses without an undocumented field name —
this would need to be discovered empirically.

---

## Q10 — pi as a reference

Source: the installed npm package at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/` and its nested
`@earendil-works/pi-ai` dependency (unminified; the minified bundle chunk
`pi-coding-agent/dist/bundle/chunks/anthropic-messages-J5WXPPPC.js` was spot-checked and
confirmed to be the same logic, not a divergent path).

**Breakpoint placement**: pi places three `cache_control` breakpoints per Anthropic
Messages request — system prompt, the last tool definition, and the last block of the
last user/system message — not one. From
`pi-ai/dist/api/anthropic-messages.js`, `buildParams()` (system prompt, lines 790-843):

```js
if (initialSystemText) {
    params.system = [{ type: "text", text: sanitizeSurrogates(initialSystemText),
        ...(cacheControl ? { cache_control: cacheControl } : {}) }];
}
```

Last tool (line 851 / `convertTools()` lines 1153-1178):

```js
return tools.map((tool, index) => ({
    ...,
    input_schema: inputSchema,
    ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
}));
```

Last message (`convertMessages()`, lines 1107-1132):

```js
if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (lastMessage.role === "user" || lastMessage.role === "system") {
        // ...cache_control placed on the last block of that message
    }
}
```

The same three-breakpoint pattern is reused for OpenAI-compatible providers that speak
Anthropic-style `cache_control` (`openai-completions.js` lines 792-828,
`applyAnthropicCacheControl`).

**TTL**, from `anthropic-messages.js` lines 17-40:

```js
function getCacheControl(model, cacheRetention, env) {
    const retention = resolveCacheRetention(cacheRetention, env);
    if (retention === "none") return { retention };
    const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
    return { retention, cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}
```

pi's default (`resolveCacheRetention`, same file, lines 17-25) is `"short"`, which
emits `{ type: "ephemeral" }` with no `ttl` — Anthropic's implicit 5-minute default.
Setting `cacheRetention: "long"` (or environment variable `PI_CACHE_RETENTION=long`),
on a model whose compat flag `supportsLongCacheRetention` is true (default true),
switches all three breakpoints in that request to `{ type: "ephemeral", ttl: "1h" }`.
The choice is a single request-wide setting, not varied per block or per breakpoint.
pi's own compaction code explicitly forces `cacheRetention: "none"` for one-off
summarization calls (`pi-coding-agent/dist/core/compaction/compaction.js` lines
498-509) to avoid wasted cache writes.

**`prompt_cache_key` for OpenAI**: yes, for both Chat Completions and the Responses
API. `pi-ai/dist/api/openai-completions.js`, `buildParams()`, lines 565-580:

```js
prompt_cache_key: (model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
    (cacheRetention === "long" && compat.supportsLongCacheRetention)
    ? clampOpenAIPromptCacheKey(options?.sessionId)
    : undefined,
```

`pi-ai/dist/api/openai-responses.js`, lines 208-229, same pattern:
`prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId)`.
The value is pi's own agent session id (`pi-coding-agent/dist/core/session-manager.js`
line 695: `this.sessionId = options?.id ?? createSessionId();`), clamped to 64
characters by `openai-prompt-cache.js`'s `clampOpenAIPromptCacheKey` (`OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
= 64`). The same session-id-as-cache-key pattern is reused for Azure OpenAI Responses,
OpenAI-Codex Responses, and even Mistral's conversations API.

**Implication for Fiber**: pi's three-breakpoint layout (system, last tool, last
message) rather than a single trailing breakpoint, plus its request-wide (not
per-block) TTL choice and session-id-derived `prompt_cache_key`, is a directly
comparable, working reference design for Fiber's own client.

---

## Not stated anywhere

- Anthropic: that switching models mid-conversation invalidates the cache (only
  strongly implied by model-specific pricing/minimums, never stated outright).
- Anthropic: "second-to-last breakpoint" as a named recommended placement — this phrase
  does not appear in the docs.
- Anthropic: which models/APIs the automatic/top-level caching mode is scoped to (only
  OpenRouter, a third party, states a provider list).
- Anthropic: a worked example matching "5m-cached prefix + a single new 1h breakpoint
  appended" exactly (Q2's answer is derived from the general A/B/C rule, not quoted).
- Anthropic: whether an already-read, older segment's TTL is retroactively extended to
  1 hour when a later 1h breakpoint is appended past it.
- Anthropic: whether inserting a brand-new `defer_loading` tool mid-session (as opposed
  to discovering one already declared at session start) preserves the cache.
- OpenAI: an explicit sentence stating that switching models loses the cache (only
  "a different model can use different weights and caching behavior").
- OpenAI: any comparison of cache-hit behaviour between `previous_response_id` and
  manually resending the full `input` each turn.
- OpenAI: a price difference between `"24h"` and `"in_memory"` retention on
  pre-GPT-5.6 models.
- Databricks: whether `cache_control` is honoured when Databricks is used as an
  External-Models pass-through to Anthropic's own API (only documented for
  Databricks-hosted Foundation Model APIs).
- Databricks: a full example response body with `cache_read_input_tokens` /
  `cache_creation_input_tokens` populated.
- OpenCode Go: the exact response-usage JSON field name(s) for cached tokens.
- codex: whether MCP tool registration order is itself deterministic across process
  restarts (the registry's iteration order is deterministic once populated; the
  population order from MCP discovery was not traced).
