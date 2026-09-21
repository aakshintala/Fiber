# Module boundaries are crate boundaries

The archived Zig predecessor had this same rule written down — core was not
to know built-in tool names — and an audit on 2026-09-13 found about 211
string literals naming built-in tools inside `src/core/` production code,
including a core enum listing every built-in by name
([Core reasons about tool kinds, not builtin names](https://github.com/aakshintala/fiber-zig/issues/138)).
A later ticket had to add a CI grep for vendor identifiers after the fact.
The rule was documented, agreed, and broken 211 times, because nothing
could stop it. That same tree's `src/core/` reached 436,110 lines across
26 subdirectories, because the only boundary anyone enforced was
"core must not import builtins", so everything else went into core.

Measured on macOS arm64 before deciding: a cargo workspace scopes
compilation from the dependency graph. `cargo test -p <crate>` compiled
exactly one crate where the single-crate equivalent
`cargo test --lib <module>::` compiled the whole library — that filters
which tests run, not which code is type-checked. The workspace was also
faster on every scenario measured, including clean builds (10.987s against
17.195s in debug). The mechanism: a single crate parallelises its backend
codegen but not its type-checking frontend, so independent crates in a
workspace overlap in a way one crate cannot. Full evidence is on
[issue #7](https://github.com/aakshintala/fiber/issues/7#issuecomment-5756970986).
The cost is eight extra manifest files and 129 lines, no disk cost, and the
weak case — touching a crate everything depends on rebuilds every dependent,
which shrank the win to 1.801s against 3.165s rather than erasing it.
`contract` is depended on by all nine other crates and holds the event
types, so it is both the crate that makes the split possible and the one
whose churn pays least.

So: **module boundaries are crate boundaries.** Fiber is a cargo workspace
with one crate per module, ten crates, so that every call rule in
`docs/architecture.md` is a compile error rather than a lint finding.

## Consequences

- A forbidden call does not compile. `tui` cannot reach `loop` because
  `loop` is not in its manifest, so the rules on `docs/architecture.md`
  need no lint and no reviewer to hold.
- A circular dependency becomes a build failure rather than a design smell,
  which is why `contract` depends on nothing and everything depends on it.
- CI job scoping comes from the dependency graph rather than a maintained
  path classifier. `cargo test -p` and `cargo check -p` are real
  compile-scope knobs. A path classifier is still needed for anything finer
  than a crate or not about compilation at all.
- Moving code between crates is a manifest change, so a boundary that turns
  out wrong costs more to move than one inside a single crate. That is the
  intended friction; it is also a real cost when a boundary is wrong.
- Adding a module means adding a crate: a manifest, a workspace member
  entry and a `[workspace.dependencies]` path.
