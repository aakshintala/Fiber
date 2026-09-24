# The session log is the only state of record

Fiber's predecessor kept an append-only event log and, beside it, four files
derived from that log: a session manifest with token totals and a checkpoint
hash, a usage ledger, a commit manifest and an authority marker. They could and
did disagree — 63 sessions ended up flagged `projection_invalid` from stale
manifests, and `ask` could exit with an indeterminate commit status. The same
failure was found independently in another harness: of 78 official Pi extensions
audited, 17 held state and 2 did it correctly, the rest keeping it in closures,
live maps or a rescan on restore, which is why rewind and resume lie there.

So: **the log is the only authority**. Anything the loop, the TUI or an
extension needs after a resume is an event or a fold of events; runtime objects
may cache and index but never become a second truth. The log is append-only for
the life of the session, so a handoff appends new events rather than rewriting
it, and a session directory holds no file that can contradict it. The contract
is `docs/events.md`; the rationale and the rejected alternatives are on
[issue #6](https://github.com/aakshintala/fiber/issues/6).

## Consequences

- Every fact a consumer needs must be an event. When the TUI or an extension
  wants state the contract does not carry, the fix is a new event kind, never a
  side channel — and a new kind is additive, so this is cheap on purpose.
- Opening a session folds the log. That cost is bounded by indexing line offsets
  and parsing only the window a consumer asks for, not by caching the fold to
  disk. If folding ever becomes too slow, the answer is a rebuildable derived
  index that is explicitly not the truth, never a sidecar of record.
- Totals that used to be stored — tokens, cost, attempt counts, history length —
  are computed, so a late correction is a new event that the fold absorbs
  rather than a reconciliation pass over two stores.
