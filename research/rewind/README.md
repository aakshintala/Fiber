# Rewind: a line, not a tree

This note is the evidence behind
[Session traversal: is a session a line or a tree?](https://github.com/aakshintala/fiber/issues/32).
The decision it supports is `docs/events.md`, "Rewind": a session is a line,
a rewind is a new session that points into an old one, and a rewind never
touches files.

Every harness claim comes from a primary source: a shipped binary read with
`strings`, official documentation, or cloned source. Every timing names its
platform.

## How other harnesses rewind

| | Claude Code 2.1.281 | codex | pi 0.87.1 |
|---|---|---|---|
| How a person rewinds | `/rewind`, or Esc Esc | Esc Esc ("backtrack") | `/tree`, `/fork`, `/clone` |
| Shape | branches within the session file | reverts the thread before the chosen turn | `/tree` branches within the file; `/fork` and `/clone` start a new session |
| Summary of the abandoned path | "Summarize from here" | none | optional `branch_summary` on `/tree` |
| Restores files | edits by its own file tools, snapshotted once per turn | no | no; an example extension does |
| Shell changes restored | no | no | no |
| Model can rewind | no | no | no |

**Claude Code.** The rewind menu offers restoring code and conversation,
conversation only, code only, or a summary
([checkpointing docs](https://code.claude.com/docs/en/checkpointing)). It
snapshots files its own tools edit, "before each prompt you send that starts a
turn", keeps the 100 most recent checkpoints, and deletes them about 30 days
after the session last saved one. It does not track shell changes; the binary
carries the string "Rewinding does not affect files edited manually or via
bash." No tool in the binary lets the model rewind.

**codex.** The Esc Esc backtrack "reverts before the selected turn and
restores its prompt in the composer" (`codex-rs/tui/src/app_backtrack.rs`).
Its handler touches no git, file or snapshot store. codex used to snapshot the
whole working tree as git "ghost commits" for undo, and removed them in
[openai/codex#19481](https://github.com/openai/codex/pull/19481), "Remove
ghost snapshots". The issues filed while the feature was live show why:

- [#7395](https://github.com/openai/codex/issues/7395): one session log
  reached 3.9 GB from 2,476 snapshots listing every untracked file.
- [#6977](https://github.com/openai/codex/issues/6977): the "large untracked
  directories" warning, and a project where the scan blocked file access.
- The deleted `ghost_commits.rs` already skipped `node_modules`, virtual
  environments, build and cache directories by name, skipped untracked files
  over 10 MiB and directories of 200 files or more, and warned after 240
  seconds.

File undo is still an open request
([#11626](https://github.com/openai/codex/issues/11626)). `codex fork` starts
a new session from a conversation, with no file restore.

**pi.** pi 0.87.1 ships three actions (`docs/session-format.md`,
`docs/sessions.md`): `/tree` moves within the session file and can write a
`branch_summary`; `/fork` starts a new session from an earlier user message;
`/clone` copies the active branch into a new session. None restores files. The
shipped example `examples/extensions/git-checkpoint.ts` runs `git stash create`
at each turn and offers `git stash apply` on `/fork`; its checkpoints live in
memory and do not survive a restart.

pi's own redesign, Pico5 (`packages/durable/docs/pico-v5.md` in
[earendil-works/pi](https://github.com/earendil-works/pi)), drops the tree.
`fork(at)` makes a new conversation recording `parent: { conversationId, at }`,
with ownership recorded separately as `owner`. Context is shortened by
appending headed entries: a collapse summary, `reset(handoff)`, and context
edits. A tool result may request `control.handoff`, which writes a headed
handoff entry. Fiber's rewind is the same shape: a pointer to a parent and a
position, and a handoff as the model's way out of a dead end.

## How the owner rewinds

Measured on the owner's own sessions, on macOS, 2026-09-23.

pi, 660 sessions under `~/.pi/agent/sessions`
([`branches.py`](branches.py), [`forks.py`](forks.py)):

- In-file branches in 6 sessions, 7 branch points in all. A branch jumped back
  a median of 32 entries, at most 59.
- `branch_summary` never used.
- 503 sessions name a parent session. All are subagents: none shares its
  parent's first user message. So `/fork` and `/clone` were never used.

Claude Code, 198 sessions under `~/.claude/projects`
([`cc.py`](cc.py)): rewinds in 20 sessions, 26 rewind points.

Rewinding is occasional and never needed a summary in pi. A new session per
rewind costs nothing a person would notice, and a line keeps `seq` the only
position.

## Why a rewind does not touch files

File undo would need a snapshot per step. Own-write copies miss shell
changes, which every harness above leaves untracked. A whole-tree snapshot
catches them, at the cost of a `git status`-class scan of the working tree.

How many files the owner's pi sessions write, per session
([`writes.py`](writes.py)):

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| write and edit calls | 0 | 18 | 73 | 143 |
| distinct files written | 0 | 7 | 18 | 31 |
| steps with tool calls | 20 | 140 | 438 | 922 |

A whole-tree snapshot, measured on macOS arm64 (Apple M3 Pro, git 2.50.1), on
a copy of this repository with 20,000 untracked files added, using a
persistent index per session ([`snapshot.sh`](snapshot.sh)):

| Snapshot | Time |
|---|---|
| first | 9.9 s |
| no change since the last | 58 ms |
| after one change | 62–66 ms |

Without a persistent index the same tree took 746 ms per snapshot; with the
untracked files ignored, 20–25 ms. A separate object directory
(`GIT_OBJECT_DIRECTORY`, with the repository's objects as an alternate) left
the repository's `.git` untouched.

At 922 steps, 60 ms a step is about a minute of scanning on this machine and
this tree size. The scan grows with the working tree, so a large monorepo pays
more, and Linux file I/O timings differ from these. That scan per step is the cost Fiber does not pay,
so a rewind is conversation only and tells the person and the model which
files changed since the point.

## Scripts

Run from the repository root. Each reads the owner's local sessions.

```sh
python3 research/rewind/branches.py   # pi in-file branches and summaries
python3 research/rewind/forks.py      # pi sessions with a parent session
python3 research/rewind/writes.py     # pi writes and steps per session
python3 research/rewind/cc.py         # Claude Code rewind points
```

`snapshot.sh` times the whole-tree snapshot. Run it on a disposable copy of a
repository, as its header says, never on the repository itself.
