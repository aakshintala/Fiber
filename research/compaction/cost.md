# Handoff thresholds: how often and at what cost

Measured September 24, 2026, from the owner's pi sessions
(`~/.pi/agent/sessions`) and Claude Code sessions (`~/.claude/projects`). This
feeds [Handoff: when a session outgrows its context](https://github.com/aakshintala/fiber/issues/24)
and `docs/handoff.md`.

The figures are token counts and session counts, so they do not depend on the
platform they were measured on.

## What this shows

On token cost alone, an earlier handoff is always cheaper, down to a floor
where a fresh context is already close to the trigger. Cost cannot choose the
automatic trigger T; quality does. Fiber's default of 300,000 tokens sits
between the owner's observation that current 1 million token models decay
around 400,000 tokens and the cost curve below.

## Method

The scripts are [threshold_sim_pi.py](threshold_sim_pi.py),
[threshold_sim_cc.py](threshold_sim_cc.py) and [cost.py](cost.py).

- Each session is replayed request by request. Context size is input plus cache
  read plus cache write tokens. Growth is the positive difference between
  consecutive requests; a drop, where the real session compacted, is ignored.
- When the replayed context reaches T, a simulated handoff resets it to the
  session's first request size, plus a 2,000 token note, plus W re-read tokens.
- The note size is a choice: just above the median pi summary of 1,566 tokens
  ([usage.md](usage.md), section 3).
- W stands for what a handoff loses: tokens the next agent reads again to
  recover context. It is swept at 0, 30,000 and 60,000. The counts in table A
  use W of 0.
- Claude Code: main-thread sessions only, 171 of them. pi: the 674 sessions
  that record usage.

Prices, in units of the model's base input price:

| Model | Cache read | Cache write | Output | Long-context tier | Source |
|---|---|---|---|---|---|
| Opus 5.5 | 0.05 | 1.25 (5-minute) | 5 | none | platform.claude.com pricing |
| GPT-6 Sol | 0.10 | 1.00 | 5 | 2x input, 1.5x output above 272,000 tokens | developers.openai.com; tier from [thresholds.md](thresholds.md), section 1 |

The system prompt and tools stay cached across a handoff. Output other than the
note is the same with or without a handoff, so it is left out.

## Table A: how often each threshold hands off

Share of sessions whose context reaches T, and the number of simulated
handoffs across all sessions.

| T | pi sessions reaching T | pi handoffs | Claude Code sessions reaching T | Claude Code handoffs |
|---|---|---|---|---|
| 100,000 | 27.9% | 334 | 71.3% | 367 |
| 150,000 | 15.9% | 152 | 53.8% | 168 |
| 200,000 | 9.8% | 83 | 35.7% | 98 |
| 250,000 | 5.5% | 51 | 18.7% | 51 |
| 400,000 | 0.9% | 11 | 3.5% | 15 |

Peak context per session:

| | Median | 90th percentile | First request, median |
|---|---|---|---|
| pi | 62,000 | 196,000 | 19,000 |
| Claude Code | 152,000 | 340,000 | 40,000 |

At a T of 50,000, one Claude Code session hands off up to 231 times: a fresh
context starts close to the trigger. That is the floor.

## Table B: whole-session cost of handing off at T

Total cost with a handoff at T, divided by the cost of never handing off, with
W of 30,000. Lower than 1 means the handoff is cheaper.

| Sessions and model | 150,000 | 200,000 | 300,000 | 400,000 |
|---|---|---|---|---|
| pi, Opus 5.5 | 0.72 | 0.78 | 0.88 | 0.92 |
| pi, GPT-6 Sol | 0.52 | 0.58 | 0.72 | 0.84 |
| Claude Code, Opus 5.5 | 0.57 | 0.60 | 0.68 | 0.75 |
| Claude Code, GPT-6 Sol | 0.31 | 0.35 | 0.45 | 0.59 |

Every ratio is below 1, and every one grows with T. Below the floor this
reverses: at a T of 100,000 and W of 60,000, Claude Code sessions cost 4.5
times as much as never handing off.

## Table C: steps needed to repay a handoff

The number of steps after a handoff at context size C before the handoff has
paid for itself, with W of 30,000. Beside it, the median number of steps
sessions actually ran after first reaching C.

| C | Steps to repay, Opus 5.5 | Steps to repay, GPT-6 Sol | Steps actually run, pi | Steps actually run, Claude Code |
|---|---|---|---|---|
| 150,000 | 11.6 | 5.7 | 74 | 42 |
| 200,000 | 8.0 | 4.2 | 72 | 50 |
| 400,000 | 4.0 | 1.7 | 108 | 302 |

Sessions run far longer after reaching these sizes than a handoff needs to
repay itself.

## Limits

- The note size and W are choices, not measurements. `cost.py` prints the
  cost ratios for every W swept.
- The replay assumes a session after a handoff grows as the real session did.
  A handoff may change how the work goes, which this cannot show.
- The prices are list prices on the date measured.
