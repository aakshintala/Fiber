# Coding standards

Rules a reviewer applies to every diff. `/code-review` reads this file. Implementation rules an agent needs while writing code, such as the Zig 0.16 API changes, stay in [AGENTS.md](AGENTS.md).

## Style

* Zig source is `zig fmt` clean. CI checks `zig fmt --check src/`.

* Zig identifiers are `snake_case`; types are `PascalCase`.

* A declaration is `pub` only when something outside its file uses it. CI audits this with `scripts/check-public-surface.sh`.

* CLI flags are kebab-case, such as `--no-save` and `--json`.

* Code, output, and documentation contain no emojis. Unicode symbols such as a checkmark or an arrow are fine.

* Documentation uses an emdash (—) sparingly as a dash, or is rewritten to need none. A double hyphen (`--`) is never a dash.

## Memory

* Allocators are passed explicitly. There is no global allocator.

* Allocations are freed, with `defer` cleanup at the call site.

* Request-scoped work that can be freed in bulk uses an `ArenaAllocator`.

* A function that returns allocated memory documents who owns it: caller or callee.

## Error handling

* Runtime conditions return errors. `@panic` is reserved for programmer bugs.

* Partial state is cleaned up on error paths with `errdefer`.

* A bounded error set is named specifically rather than widened to `anyerror`.
