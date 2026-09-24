# Compaction thresholds: what the evidence supports

Date: September 24, 2026

This note answers two questions for ticket 24: how early to tell a model how
full its context window is (the nudge), and at what point to compact
automatically. It draws only on vendor pricing pages, vendor docs, papers and
benchmark sites, and Fiber's own local sources (the pi agent's code and docs,
and the opencode-go model catalog). Every number below has a source.

## What the evidence supports

Degradation on hard tasks (multi-needle retrieval, multi-hop reasoning,
conversational memory) shows up as an absolute token count, not as a fixed
fraction of a model's advertised window. A model with a 1 million token
window does not stay healthy until close to 1 million tokens. NoLiMa found
most models' effective context length sits at 2,000 to 16,000 tokens, far
below their claimed windows of 128,000 to 10 million. RULER found the same:
some models advertised at 1 million tokens fall under its quality bar before
4,000 tokens, while others hold past 128,000. OpenAI's own Graphwalks
benchmark, which OpenAI compares to "jumping between multiple files when
writing code", shows GPT-4.1 fall from 61.7% to 19.0% once input crosses
128,000 tokens, despite a 1,047,576 token window.

This means Fiber should not set either number as a percentage of context
window. An absolute token count, picked from where the benchmarks show
multi-hop and agentic tasks start to degrade, is what the evidence supports.

For the automatic compaction threshold, a range of 150,000 to 250,000 tokens
is well supported:

- Anthropic's own server-side compaction defaults to 150,000 tokens,
  regardless of the model's window size (200,000 tokens or 1 million). This
  is Anthropic choosing an absolute trigger, not a fraction of window, for
  the same problem Fiber is solving.
- GPT-5.2's 8-needle MRCR score is 85.6% at 64,000 to 128,000 tokens and
  77.0% at 128,000 to 256,000 tokens, down from 98.2% at 4,000 to 8,000
  tokens.
- Anthropic's Opus 4.6 system card shows 91.9% at its 256,000 token bin and
  78.3% at its 1 million token bin on the same benchmark.

For the nudge, "much earlier" than compaction is supported by NoLiMa's
finding that many models' effective context is 2,000 to 16,000 tokens, and by
Chroma's finding that a 113,000 token prompt scores much worse than a 300
token prompt on the same conversational memory task. A nudge somewhere in the
tens of thousands of tokens, well before the 150,000 to 250,000 token
compaction point, sits inside the range where these benchmarks already show
measurable drops on hard tasks.

One caution on the nudge itself: Anthropic and Cognition both document
"context anxiety", where a model that is told or senses its context is
filling up wraps up a task early, takes shortcuts, or declares work finished
when it is not, even with room left in the window. Anthropic's fix is not a
blunter warning. It is telling the model that work will continue after
compaction, so it has no reason to rush. Anthropic's task budget feature
(a running token countdown) states explicitly that under-reporting the
remaining budget causes earlier wrap-up than the real budget allows, and
recommends against setting any budget at all for open-ended, quality-first
work. If Fiber's nudge states a raw percentage or token count without also
telling the model that compaction will hand off cleanly and the task will
continue, the evidence says this risks the same premature wrap-up problem
research question 3 was trying to avoid.

## 1. Price cliffs by context size

Some providers charge a higher per-token rate once a request's input passes
a threshold. This does not, by itself, argue for compacting sooner (Fiber
should compact for quality, not to save money), but it confirms that large
prompts carry a real cost penalty on several providers Fiber routes to.

| Provider | Model or model class | Threshold | Multiplier | Source |
|---|---|---|---|---|
| Anthropic | Opus 4.7, Opus 4.8, current 1 million context models | None | Flat rate across the full window | Claude API skill, `shared/model-migration.md` lines 79 and 654: "1M context window at standard API pricing (no long-context premium)" |
| OpenAI | GPT-5.x codex family (`gpt-5.3-codex` and earlier) | None found | Flat rate | `https://developers.openai.com/api/docs/models/gpt-5.3-codex` and sibling model pages |
| OpenAI | GPT-5.4, GPT-5.6 Sol, GPT-6 Sol, GPT-6 Luna (1.05 million context models) | 272,000 input tokens | 2x input, 1.5x output, for the whole request | `https://developers.openai.com/api/docs/models/gpt-5.4`, `https://developers.openai.com/api/docs/models/gpt-6-sol` |
| OpenCode Go | All models sampled (Kimi, GLM, DeepSeek, Qwen, minimax, and others) | None | Flat `cost.input` / `cost.output` rate per model, no tiering field in the schema | Local file: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json` |
| OpenRouter | `google/gemini-2.5-pro`, `google/gemini-3.1-pro-preview`, `anthropic/claude-sonnet-4` | 200,000 input tokens | 2x input, 1.5x output | `https://openrouter.ai/docs/guides/overview/models`; live model API, for example `https://openrouter.ai/api/v1/model/anthropic/claude-sonnet-4` |
| OpenRouter | `openai/gpt-5.6` family | 272,000 input tokens | 2x input, 1.5x output | `https://openrouter.ai/api/v1/model/openai/gpt-5.6` |
| OpenRouter | `anthropic/claude-sonnet-4.6` (1 million context) and sampled open-weight models (Kimi K2/K3, GLM 4.6/5.3, Qwen3, DeepSeek v3.2) | None | Flat rate | Live model API, for example `https://openrouter.ai/api/v1/model/anthropic/claude-sonnet-4.6` |
| Databricks | Open-weight pay-per-token models (Llama, Kimi K3, GLM, and others) | None | Flat DBU rate per model | `https://www.databricks.com/product/pricing/foundation-model-serving` |
| Databricks | Proprietary GPT models (GPT-5.4 and later, GPT-6 family), Gemini 3.0/3.1 Pro, Gemini 2.5 Pro | Not stated in English page; Italian locale of the same page states 200,000 for Gemini | 2x input, 1.5x output | `https://www.databricks.com/product/pricing/proprietary-foundation-model-serving`; threshold from `https://www.databricks.com/it/product/pricing/proprietary-foundation-model-serving` |
| Databricks | Claude models, Grok 4.6 | None found on this table | Flat rate | `https://www.databricks.com/product/pricing/proprietary-foundation-model-serving` |

Pattern across providers: the 200,000 to 272,000 token price cliff is common
on models whose window is around 1 million tokens (Gemini, GPT-5.4 and
later, Claude Sonnet 4 on OpenRouter), but not on Anthropic's own current
API pricing, not on the smaller 400,000 token GPT-5.x codex models, and not
on any open-weight model sampled on OpenCode Go, OpenRouter or Databricks.

## 2. Quality versus context fill

| Study | What it measured | Absolute token finding | Scales with window? |
|---|---|---|---|
| Chroma, "Context Rot" (2025) | 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3 families) on semantic needle-in-haystack, conversational memory (LongMemEval), and exact-replication tasks | Conversational memory: a 300 token focused prompt scores much better than a 113,000 token full prompt on the same question, across every model family. Word-replication tasks degrade steadily from 2,500 words onward | No. Tested up to each model's own maximum window, including 1 million token models, and found gradual degradation throughout, not only near the cap. `https://research.trychroma.com/context-rot` |
| NoLiMa (arXiv:2502.05167) | 13-plus models, "effective context length" defined as the longest length still scoring at least 85% of the model's short-context score | Most models' effective length is 2,000 to 16,000 tokens. At 32,000 tokens, 11 of 13 models score below half their short-context baseline. GPT-4.1's effective length is about 16,000 tokens against a claimed 1 million token window | No. Effective length does not track the claimed window at all; a 2 million or 10 million token window does not push the effective length out |
| RULER (NVIDIA, arXiv:2404.06654) | "Effective context length": longest tested length (4,000 to 128,000 tokens) where a 13-task average still beats a fixed baseline score | About half of models claiming 32,000 tokens or more fail the bar by 32,000 tokens. Some models advertised at 1 million tokens are effective below 4,000 tokens; others hold past 128,000 | No. Effective length is uncorrelated with the advertised window |
| Fiction.LiveBench | Story comprehension and inference, not pure retrieval | Official example: a model passes a 1,000 token version of a task and fails the 8,000 token version | Described as absolute story length, not a fraction of window. Exact current per-model scores could not be read from the site's image-based results table |
| OpenAI MRCR and Graphwalks | Multi-needle retrieval (MRCR) and multi-hop graph search (Graphwalks, OpenAI's own analogy is "jumping between multiple files when writing code") | GPT-4.1 Graphwalks: 61.7% below 128,000 tokens, 19.0% above 128,000 tokens. GPT-5.2 8-needle MRCR: 98.2% at 4,000 to 8,000 tokens, 85.6% at 64,000 to 128,000 tokens, 77.0% at 128,000 to 256,000 tokens. Anthropic's Opus 4.6 system card: 91.9% at its 256,000 token bin, 78.3% at its 1 million token bin, on the same benchmark family | No. Both vendors report these as absolute token bins. Needle retrieval alone stays flat close to 1 million tokens; multi-hop and multi-needle tasks fall well before that, at the same absolute token counts regardless of the model's window |

Across every study that gives absolute numbers, hard tasks (multi-hop
reasoning, multi-needle retrieval, conversational memory over history) show
measurable drops somewhere between a few thousand and a few hundred thousand
tokens, and that onset does not move out as the window gets bigger. Simple
single-needle retrieval is the exception: it stays close to 100% out to each
model's full advertised window on most benchmarks.

## 3. What reference agents expose to the model

| Agent | Tells the model how full its context is? | Automatic compaction trigger | Source |
|---|---|---|---|
| pi (github.com/earendil-works/pi) | No built-in nudge or fullness message to the model | `contextTokens > contextWindow - reserveTokens`. Default `reserveTokens` is 16,384 tokens, default `keepRecentTokens` is 20,000 tokens. Pi's own docs give a worked example for a 1 million token model: setting `reserveTokens` to 400,000 triggers compaction at 600,000 tokens, 60% of the window | Local: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md`, and `dist/core/compaction/compaction.js` |
| Anthropic API (Sonnet 5, Sonnet 4.6, Sonnet 4.5, Haiku 4.5 only) | Yes. The API injects the total context window size into the system prompt and updates remaining capacity after each tool call, without the client asking for it. Opus 4.7 and later, and Fable and Mythos 5.x, do not get this; Anthropic's substitute for those models is the separate task budget feature | Not applicable at the API level; this is a standing awareness mechanism, separate from compaction | `https://platform.claude.com/docs/en/build-with-claude/context-windows` |
| Claude Code | The user interface shows fullness (a status line, and a "context left until auto-compact" warning at 80%, up from 60% in an earlier version). No Claude-Code-owned message injects fullness into the model beyond what the Anthropic API already does for the models listed above | Compacts near the model's context limit. Sonnet 5 on a 1 million token window compacts at about 967,000 tokens (96.7% of window). Sonnet 4.6 and Opus 4.6 without extended context default to a 200,000 token boundary. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` lets an operator set an absolute value from 100,000 to 1 million tokens | `https://code.claude.com/docs/en/context-window`, `https://code.claude.com/docs/en/model-config.md`, `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md` |
| OpenAI Codex CLI | Not by default. An in-development feature flag (`token_budget`, off by default) can inject a remaining-token sentence and threshold reminders at 25%, 50% and 75% of the window, plus a `get_context_remaining` tool | 90% of the model's context window by default (`auto_compact_token_limit = resolved_context_window * 9 / 10`), configurable per model | `https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs`, `https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs`, `https://developers.openai.com/codex/config-reference` |

Fiber's own two named reference points (200,000 smallest window, 1.05
million median window) both show up directly in these agents' defaults.
Claude Code's 200,000 token boundary for non-extended models matches
Fiber's smallest window. Pi's worked example of reserving 400,000 tokens out
of a 1 million token window (compacting at 60% of window) is the closest
existing precedent for treating the threshold as a large, deliberate margin
rather than running close to the limit.

## 4. Vendor guidance on when to compact, and on early warnings

Anthropic's engineering blog describes context as a finite, decaying
resource: "as the number of tokens in the context window increases, the
model's ability to accurately recall information from that context
decreases", calling this a performance gradient rather than a hard cliff,
with no single token threshold given
(`https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`).
A later post warns that compaction on its own is not enough for long-running
coding agents: agents still run out of context mid-feature, or a later
session wrongly declares the work finished
(`https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents`).

Anthropic names "context anxiety" directly: models, particularly Sonnet 4.5,
wrap up prematurely as they approach what they believe is the context limit,
even with room left. The documented fix is not an earlier or blunter
warning. It is telling the model that compaction, or a context reset with a
handoff summary, will let the work continue, so there is no reason to rush
(`https://www.anthropic.com/engineering/harness-design-long-running-apps`).
Anthropic's own prompting guidance for harnesses that compact says the same
thing directly: tell the model the harness will compact, or it may wrap up
as it nears the limit
(`https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`).
Cognition (maker of Devin, built on Sonnet 4.5) independently describes the
same behavior and found their model underestimates its own remaining tokens,
precisely, and takes shortcuts near the believed limit even with real room
to spare (`https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges`).
An academic study (arXiv:2607.21616) found models expressing this kind of
anxiety misjudge their own token usage by about 24%, and that this predicts
15% lower accuracy and 54% more tokens used when they do succeed.

OpenAI's guidance is compact-and-continue rather than warn-and-stop. Its
Responses API compaction endpoint takes a `compact_threshold` (its own
documented example uses 200,000 tokens) and replaces old history with an
opaque summary item when crossed
(`https://developers.openai.com/api/docs/guides/compaction`). An OpenAI
engineer states on the Codex repository that Codex's default auto-compact
trigger is 90% of the available context window
(`https://github.com/openai/codex/issues/10365`). No primary OpenAI source
uses the term "context anxiety" or discusses early wrap-up from a fullness
warning.

## Gaps

Fiction.LiveBench's current per-model scores are shown as an image on its
results page and could not be read as text; only the site's own worked
example (1,000 versus 8,000 tokens) is cited above. No vendor publishes a
tool-calling-accuracy-versus-token-count curve specific to agentic coding
sessions; the closest primary evidence is OpenAI's Graphwalks benchmark,
which OpenAI itself compares to multi-file code navigation.
