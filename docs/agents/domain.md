# Domain docs

How the engineering skills consume this repo's domain documentation. The layout is single-context.

## Before exploring, read these

- `CONTEXT.md` at the repo root, the glossary.
- `docs/adr/`, for decisions that touch the area you are about to work in.
- `docs/<area>.md` for the area, which describes what is true now.
- The spec issue for the workstream, when the task came from a ticket that links one.

If any of these do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. `/domain-modeling` creates `CONTEXT.md` and ADRs lazily, when a term or decision is actually resolved.

## Where things live

| What | Where |
| --- | --- |
| Vocabulary | `CONTEXT.md` |
| A decision that is hard to reverse, surprising, and a real trade-off | `docs/adr/NNNN-<slug>.md` |
| Decisions still being made | A wayfinder map and its tickets on GitHub |
| A spec for a workstream | A GitHub issue, written by `to-spec` |
| Agent-ready work | GitHub issues from `to-tickets`, labelled `agent-ready` |
| What is true now | `docs/<area>.md`, updated in the pull request that changes it |

No spec, proposal, plan, or backlog file is checked into the repo. There is no `docs/proposals/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept you need is not in the glossary yet, either you are inventing language the project does not use (reconsider) or there is a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, `docs/<area>.md`, or an accepted spec issue, say so explicitly rather than silently overriding it:

> Contradicts ADR-0007 (event-sourced orders), but worth reopening because…
