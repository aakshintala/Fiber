# Context and compaction: measured from real sessions

Date: 2026-09-24. Source: pi sessions under `~/.pi/agent/sessions` (685 files) and Claude Code sessions under `~/.claude/projects` (332 files). This feeds Fiber issue #24, "Compaction: when a session outgrows its context".

## Constants this script chose

These are not measured facts. They are choices made to produce the numbers below, listed so a reader can judge or replace them.

| Constant | Value | Why |
|---|---|---|
| `BYTES_PER_TOKEN` | 4 | rough bytes-per-token estimate, used only where pi does not record a token count directly (summary size, kept-tail size) |
| `TOOL_RESULT_CAP` | 16,384 bytes (16 KiB) | Fiber's default tool-result cap, from the brief |
| `NEXT_EVENT_WINDOW` | 10 entries | how far past an overflow error we look to classify what happened next |
| overflow error pattern | `context length\|context window\|too long\|prompt is too long\|maximum context` (case-insensitive) | what counts as a context-overflow error message |
| growth-per-turn / 0→70% scope | first episode of each session only (start to first compaction, or whole session if none) | pi does not record post-compaction context size, so a later episode's turn-1 baseline can't be estimated without inventing a number |
| "smallest"/"typical" context window (measure 6) | smallest = min matched model window seen in usage; typical = median matched model window seen in usage, one entry per assistant call | ties the reference windows to what these sessions actually used, not to a hand-picked model |

Model registry note: 89 model id(s) have different `contextWindow` values in different pi-ai provider files (e.g. the same model id offered through two gateways at different window sizes). 99%+ of assistant messages in these sessions carry a `provider` field (`opencode-go`, `openai-codex`, `anthropic`) that resolves straight to the matching provider file, so this ambiguity practically only affects the sessions using `cursor`, `pi-claude-cli` or `oc-sdk-go` as provider, where the code falls back to a single global table (first file alphabetically wins).

Models seen in pi sessions with no match in the pi-ai model registry (excluded from window-ratio calculations):

- `cursor-grok-4.5` (10 messages)
- `omen-alpha` (3 messages)

## 1. pi: sessions with compaction

- Sessions scanned: 685
- Sessions with at least one compaction: 12 (1.8%)
- Compactions per session that compacted: p50 1, p90 2, max 3
- Total compaction events: 15
- Manual vs automatic: not distinguishable. Every compaction record has `fromHook: false`, and in every case the entry immediately before the compaction is a tool result or an internal `pi-stamp` marker, never a user message issuing a slash command. That is consistent with all 15 observed compactions being triggered automatically by context pressure mid-turn, not by an explicit user command, but pi's log has no trigger field to confirm it either way.

## 2. pi: context at compaction

- `tokensBefore`: p50 255,794, p90 267,574, max 279,151
- `tokensBefore` / model context window: p50 94.0%, p90 98.4%, max 102.6% (n=15 compactions with a matched model)
  Some ratios exceed 100%: `tokensBefore` can be counted past the model's nominal `contextWindow` once reserved output tokens or cache accounting are included, so pi's own trigger threshold sits at or slightly past the window, not comfortably under it.

## 3. pi: summary size and kept tail

- Summary size, estimated tokens (bytes/4): p50 1,566, p90 2,693, max 2,804
- Kept tail (firstKeptEntry → compaction), estimated tokens as a fraction of the model's window: p50 4.6%, p90 6.9%, max 7.0% (n=15)

## 4. pi: peak context per session

- Peak (input+cacheRead+cacheWrite)/window per session: p50 9.5%, p90 32.6%, max 98.1% (n=685 sessions with a matched model)

| Threshold | Sessions crossing it | Share |
|---|---|---|
| 50% | 31 | 4.5% |
| 70% | 19 | 2.8% |
| 80% | 12 | 1.8% |
| 90% | 7 | 1.0% |

## 5. pi: context growth per turn (first episode only)

- Tokens added per turn: p50 21,240, p90 121,341 (n=1373 turns, 685 sessions)
- Turns to go from 0 to 70% of window: p50 1, p90 2, max 7 (n=17 sessions that reached 70% in their first episode)
- Sessions whose first episode never reached 70%: 666

## 6. pi: per-step tool result totals

- Raw bytes per step: p50 554, p99 48,164, max 525,652
- Bytes per step after cutting each result at 16,384 bytes: p50 554, p99 29,013, max 196,608
- Max step, as estimated tokens (bytes/4) over the smallest model window seen in use (200,000): 65.7%
- Max step, as estimated tokens over the typical (median) window seen in use (1,048,576): 12.5%
- Steps with more than one tool result (parallel calls): 4432 of 38752 (11.4%)

## 7. pi: context-overflow errors

- Count: 0

## 8. Claude Code: compactions and commands

- Compactions: 1 auto, 10 manual
- Auto `preTokens`: p50 969,230, p90 969,230, max 969,230
- Manual `preTokens`: p50 383,455, p90 809,203, max 809,203

| Command | Count |
|---|---|
| /compact | 11 |
| /clear | 117 |
| /handoff | 40 |
| /rewind | 0 |

- Sessions with a command name containing "handoff": 40 of 332

## 9. pi: what happens after a compaction

- Turns run after a compaction, until the next compaction or session end: p50 1, p90 13, max 14 (n=15 compactions)
- Sessions that compact again after their first compaction: 2 of 12 (16.7%)
