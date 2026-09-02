# Session traversal

Status: follow-on idea under discussion

Priority: after the Fiber product transition

Last updated: September 1, 2026

## Decision summary

Design coherent session-history traversal instead of retaining isolated `/undo` and `/copy` commands.

The intended capability space includes branching, rewinding, tree navigation, and forking. Exact terms and semantics remain open and must be designed together because each operation changes how users and automated workers identify conversation state.

## Product need

Fiber should support both direct human use and software-factory automation. A user or worker should be able to identify a point in session history, derive new work from it, and understand the resulting lineage without relying on mutable UI-only state.

## Initial constraints

- durable operations need stable identifiers and structured output
- automation must not depend on an interactive picker
- history changes must not silently discard existing branches
- provider and model identity must remain visible across derived session state
- subagent lineage and main-session lineage must not be conflated
- session persistence, recovery, and compaction need explicit interactions with traversal

## Open decisions

- the canonical terms for branch, rewind, fork, and tree nodes
- whether rewind moves a cursor, creates a branch, or performs another operation
- whether a fork creates a new session identity or another branch in one session
- how commands address history points and branches
- how the TUI visualizes lineage
- how automated workers consume and create branches through JSON contracts
- how compaction affects addressable history
- how subagent sessions relate to parent-session branches
