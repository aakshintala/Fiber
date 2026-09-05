# Phase 4 simplification audit

Read-only audit of the Fiber tree, run 2026-09-05 to give Phase 4 a measured
surface instead of a hunt. A transition document: deleted in Phase 6 with the
rest, after its rationale is harvested.

| File | What |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | Start here if you are picking this up cold |
| [`REPORT.md`](REPORT.md) | The findings, bucketed by verdict and origin |
| [`audit-brief.md`](audit-brief.md) | Instructions the 16 shard agents were given |
| [`verify/verify-brief.md`](verify/verify-brief.md) | Instructions the 12 adversarial verifiers were given |
| [`corpus-raw.txt`](corpus-raw.txt) | 360 raw findings, deduplicated, shard-tagged |
| [`corpus-scored.tsv`](corpus-scored.tsv) | Each finding with its reference count, kind, symbol, and origin |
| [`verify/verdicts.tsv`](verify/verdicts.tsv) | 210 adversarial verdicts with evidence |
| [`verify/out-NN.txt`](verify/) | Raw verifier batch output |
| [`shards/`](shards/) | Per-shard file lists and raw findings, including the 08 re-run |
| [`production-lines.txt`](production-lines.txt) | Per-file production line counts used to balance the shards |

## Method, briefly

16 shards of ~15k production lines each, `composer-2.5`, read-only, in parallel.
Shard 08 hit the 40-finding cap **silently** — no `TRUNCATED` line — and its
re-run split in two returned 82 findings against the capped 40; the split output
supersedes it. Treat shard size, not the cap instruction, as the real control.

Every claim was gated twice: mechanically, against a mirror of the tree with all
`test` blocks stripped, and — for the 210 the counter could not settle —
adversarially, by `gemini-3.5-flash` verifiers with `requireNonClaude: true`,
told to refute rather than confirm. 31% of those were refuted.
