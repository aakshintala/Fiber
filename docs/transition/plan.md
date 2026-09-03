# Fiber transition plan

Authoritative product design: [`docs/ideas/fiber-product-transition.md`](../ideas/fiber-product-transition.md).

Plan only the active phase in detail. Do not recreate a complete ticket tree upfront. Before delegating implementation, split the active phase into independently reviewable slices of one subsystem or about 15 files.

## Phase 1: Demolition

Remove code, tests, fixtures, build wiring, workflows, configuration, and documentation that exist only for products or behavior Fiber will not retain.

Current step: execute the ordered slices in [`demolition-inventory.md`](demolition-inventory.md). That document classifies every design requirement as already removed, pending deletion, rename work, new implementation, final verification, or deferred, and holds the resolved ambiguities.

Interim completion gate for each slice is defined in `AGENTS.md`. Routine E2E and live-model verification are deferred. Preserve failures involving retained behavior as evidence for Phase 5.

Phase exit: every deletion required by the product design is either absent from the tree or explicitly reclassified into a later phase, with exact path and symbol evidence.

## Phase 2: Fiber identity cutover

Rename the retained executable, product text, state paths, environment variables, internal formats, credentials, artifacts, tests, fixtures, and developer tooling. Add no fx compatibility readers, aliases, imports, migrations, or fallbacks.

Phase exit: the repository builds `fiber`; exact searches find no unexplained product-level fx identity or compatibility reads.

## Phase 3: Contract implementation

Implement the chosen command, flag, session, authentication, permission, MCP, model-routing, usage, JSON-output, and ACP contracts from the product design.

Phase exit: every target contract exists behind its owning typed interface and has focused unit coverage.

## Phase 4: Simplification

Collapse seams, adapters, host profiles, target branches, and indirection left with one implementation after demolition and contract work. Preserve only seams that still express real variation or isolate a meaningful interface.

Phase exit: every known single-implementation abstraction is collapsed or justified with current callers and implementations.

## Phase 5: Repair and exhaustive verification

Build the final Fiber product, run deterministic E2E once, and group failures by retained product contract. Repair one subsystem at a time, add focused unit regressions where practical, and rerun affected E2E files. Finish with the full deterministic suite and real TUI, ACP editor, Codex, JSON automation, session, and subagent interactions.

Phase exit: the success criteria in the product design are directly exercised, with unavailable external checks recorded as unverified.

## Phase 6: Final documentation and release preparation

Rewrite `AGENTS.md`, `CONTRIBUTING.md`, README material, and related process guidance for the verified Fiber workflow. Remove the temporary transition process. Build the local fast and exhaustive gates required before preparing Fiber `0.0.1`.

Phase exit: documentation describes observed Fiber behavior and the supported platform and release process without inherited fx-era instructions.
