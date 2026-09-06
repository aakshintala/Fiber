# Fiber Phase 4 simplification audit shard brief

Status: historical input. Do not reuse. Its blanket layering premise and
`deleted-product` versus `always-was` phase boundary were disproved after the
audit. Use [`CORRECTIONS.md`](CORRECTIONS.md) for current decisions.

Repo root: `.`. All paths below are relative to it.

You are auditing ONE SHARD of a Zig codebase for code that can be **deleted**.
Read-only. Do not edit, create, or commit anything. Do not run build or test commands.

## Context: what this codebase just went through

Fiber is a hard fork. A demolition phase deleted six products that used to live
in this tree:

- an SDK
- a WebAssembly target
- ACP (Agent Client Protocol — an editor/GUI integration that was a second agent host)
- a Gateway product
- the Grok model provider
- alternate embedding hosts (JavaScript hosts, etc.)

Deleting them left **false variation** behind: interfaces whose second
implementation is gone, capability booleans that can only be one value now,
enums with one variant, optional fields nothing ever fills, parameters every
caller passes the same constant for. That residue is what you are hunting.

## THE LAYERING RULE — read this before reporting any interface

`src/core/**` defines contracts. `src/builtins/**` implements them.
`src/main.zig` wires them together. Every production `core -> builtins` import
in this tree is wrapped in `if (builtin.is_test)`. Verify this yourself if you
like: `rg -n '@import\(".*builtins/' src/core` — every hit is test-guarded.

**Therefore: a vtable/`Provider` struct in `src/core` with exactly one
implementation in `src/builtins` is CORRECT and must NOT be reported.** It is
the mechanism that keeps the dependency arrow pointing one way. Collapsing it
would make `src/core` import `src/builtins` in production.

Report an interface only when it has **no** production implementation anywhere,
or when caller and implementation sit on the same side of that boundary.

This rule is the single biggest source of false positives. Apply it hard.

## What counts as a finding

Deletions only. Every one of these qualifies:

- a struct, function, constant, or module with zero production callers
- an optional field (`?T = null`) that no production code ever assigns
- a boolean/capability flag that is one value on every production path
- an enum with one variant, or whose other variants are unreachable
- a function parameter every call site passes the same literal for
- a wrapper struct with one field that callers immediately unwrap
- a branch that cannot be taken because its condition is a compile-time constant
- inert strings, symbols, or test names naming a deleted product

## What is NOT a finding — do not report these

- anything inside a `test "..."` block (this tree is ~58% inline tests)
- refactors, extractions, renames, "consider splitting this file"
- performance, style, naming, formatting, missing docs
- anything that adds code or changes behavior
- new abstractions of any kind
- a seam that crosses the core/builtins boundary (see THE LAYERING RULE)
- test doubles and fixtures — a seam with one production impl plus one test impl
  is a legitimate seam, not residue

If a finding is not a deletion, it is not a finding. Say nothing about it.

## Already known — do not re-report

These are already scheduled for removal. Reporting them again is noise:

1. `src/core/hosts/runtime_profile.zig` — the whole 13-boolean host `Profile`,
   `allows()`, and every `if (comptime ...allows(...))` guard
2. `DeferredToolCompletion`, `ToolExecutionResult.deferred_tool_completion`,
   `AgentRuntimeDeps.publish_deferred_tool_completion`, `unavailableHostToolResult`
3. `src/core/tooling/tool_dispatch.zig` `HostToolProvider` / `HostToolProviderFn`
   and the `host_tool_provider` fields threading it
4. `gateway_provider.Provider` — the one-field wrapper around `oauth_transport`
5. `provider_set.Bundle.fiber_search` and `Capabilities.fiber_search`, plus the
   whole `src/core/tooling/web_search_provider.zig` module
6. `AgentRuntimeDeps.flush_assistant_stream_per_content_chunk` and its
   `StreamChunkContext` twin
7. `parseTitledChoices(..., allow_description)` in `src/core/mcp/elicitation.zig`
8. `TransitionRoute` in `src/core/app/input_full_transcript_runtime.zig`
9. `ShellKind` in `src/tools/shell/shell.zig`
10. `prompt_history_provider.Provider` (already under review)

## Explicitly retained — do not report

These express real variation and are staying:

- `oauth_transport.Provider` (native, unavailable, and test adapters)
- `stream_provider.Provider` (Codex plus deterministic test streams)
- `auto_classifier.Provider` (production and test reviewers)
- `process_provider.Provider` (has an `unavailable_provider` adapter)
- clipboard, URL-opener, and terminal-title effects and their unavailable adapters
- MCP stdio and HTTP transports, protocol negotiation, auth, and the tool /
  prompt / resource / subscription features
- `ProviderId` and all provider-shaped command and JSON output contracts —
  more model providers are planned, this shape is deliberate
- committed-file secondary publication (root agents publish, subagents skip)

## Scope

Your shard's file list is given in the dispatch message. **Report only findings
whose primary site is a file in your list.**

You MAY grep the whole repo for evidence — you must, in fact, to prove something
has no other caller. Other shards cover the other files; repo-wide reading is
expected, shard-limited *reporting* is required.

## Output format — exactly this, one line per finding

```
<file>:<line> | <what to delete> | <deleted-product|always-was> | <proof command>
```

- `<what to delete>` — the symbol or field, plus 8 words at most. No prose.
- `<deleted-product>` if it exists because one of the six deleted products
  existed; `<always-was>` if it is ordinary dead code unrelated to them. Guess
  if unsure and say which.
- `<proof command>` — a single runnable `rg`/`grep` whose output settles the
  claim, usually an absence search showing there is no other implementation or
  caller. A finding without a runnable proof will be discarded unread, so do not
  bother writing one.

No preamble. No summary. No grouping headers. No quoted source code. Just the
finding lines. Every line of prose you write costs a finding you could have
reported.

## Limits

Report at most **40** findings. If your shard genuinely has more, report the 40
strongest and add a final line:

```
TRUNCATED: <your rough estimate of the true total>
```

## Finish

End your message with a trailing line, exactly one of:

```
STATUS: DONE
STATUS: BLOCKED
STATUS: NEEDS_CONTEXT
```

Use `NEEDS_CONTEXT` only if something blocks a correct audit; put the question
in the message body. Do not guess through a blocker.
