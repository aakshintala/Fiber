# Adversarial verification of deletion claims

Repo root: `/Users/aakshintala/work/fiber`. Read-only. Do not edit, create, or
commit anything. Do not run build or test commands.

A previous audit pass (a DIFFERENT model) produced deletion claims about this
Zig codebase. **Your job is to try to REFUTE each one.** Assume the claim is
wrong until the code shows otherwise. A claim that survives your attack is
worth acting on; one that does not must be killed now, before someone deletes
live code.

## How to attack a claim

For each claim you are given a `file:line`, a short description of what the
previous pass wanted deleted, and the declaration text at that line.

1. Read the actual code at that location and enough around it to understand it.
2. Find every reference to the symbol, field, variant, or parameter.
3. Decide whether deleting it would change production behavior.

Things that REFUTE a claim:

- a production caller exists anywhere (including via `@hasField`, `@hasDecl`,
  `comptime` reflection, or a function pointer assigned into a struct)
- the symbol is referenced from `tests/` (TypeScript e2e), `scripts/`, or `build.zig`
- an enum variant is produced by a `parse`/`from`/`init` function, even if no
  literal use exists
- a field is written through a struct literal that sets it positionally or via
  `.{ ... }` inference
- it is part of a public contract the CLI or JSON output exposes
- removing it would make `src/core` depend on `src/builtins` (this codebase
  keeps that arrow one-way: `core` defines contracts, `builtins` implements,
  and every production `core -> builtins` import is `if (builtin.is_test)`-guarded)

Things that do NOT refute a claim:

- the symbol's own definition
- references that appear only inside `test "..."` blocks — note these, they mean
  the code exists only to be tested, which is still deletable (with its test)

## Output — one line per claim, exactly this shape

```
<file:line> | <VERDICT> | <one line: the deciding evidence>
```

<VERDICT> is exactly one of these four words:

- `CONFIRMED` — you tried to refute it and could not; it is genuinely deletable
- `TESTED-ONLY` — deletable, but its only references are in `test` blocks
- `REFUTED` — it is live; name the caller that proves it
- `UNCLEAR` — you could not settle it; say what is missing

The evidence field must name a concrete location or an absence search you ran.
"Looks unused" is not evidence.

Emit one line for EVERY claim you are given, in the order given. Do not skip
any. No preamble, no summary, no grouping headers.

End with a trailing line exactly:

STATUS: DONE
