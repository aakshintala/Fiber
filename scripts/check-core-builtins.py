#!/usr/bin/env python3
"""Fail when production code in src/core/ imports from src/builtins/.

src/core/ must not depend on src/builtins/ in production code; the
composition root (src/main.zig) injects builtin behavior through typed
contracts instead. Test-only imports stay allowed in three shapes:

  1. `is_test`-gated imports: `@import` on the same line as `is_test`,
     or within the two lines after it (the `= if (builtin.is_test)`
     ternary pattern).
  2. Imports inside `test "..." {}` blocks, inside functions whose name
     contains `test`/`Test` (e.g. `testPromptRunDeps`, `testConfig`),
     or inside `Test*` fixture structs (e.g. `TestApp`).
  3. Any file under a `tests/` directory.
  4. The entries in TEST_HELPER_ALLOWLIST: test-only helpers whose names
     match neither convention above.

Any other `@import` whose path contains `builtins/` is a violation.
"""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_ROOT = REPO_ROOT / "src" / "core"

IMPORT_RE = re.compile(r'@import\s*\(\s*"[^"]*builtins/')
FN_RE = re.compile(r"fn\s+([A-Za-z_][A-Za-z0-9_]*)")
DECL_RE = re.compile(r"(const|var)\s+([A-Za-z_][A-Za-z0-9_]*)")

# Test-only helpers whose names match neither the test/Test convention
# below. Do not add production names here.
TEST_HELPER_ALLOWLIST = {
    "checkPreparationAllocationFailures",
    "checkAskJsonCaptureAllocationFailures",
}


def enclosing_decl(lines: list[str], index: int) -> str:
    """Return the nearest column-0 declaration above (and including) index."""
    for j in range(index, -1, -1):
        line = lines[j]
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        if line[0] in (" ", "\t"):
            continue
        return stripped
    return ""


def is_allowed(path: Path, lines: list[str], index: int) -> bool:
    if "tests" in path.parts:
        return True
    window = lines[max(0, index - 2) : index + 1]
    if any("is_test" in line for line in window):
        return True
    decl = enclosing_decl(lines, index)
    if decl.startswith("pub "):
        decl = decl[4:]
    if decl.startswith("test"):
        return True
    fn = FN_RE.match(decl)
    if fn:
        name = fn.group(1)
        if "test" in name or "Test" in name:
            return True
        return name in TEST_HELPER_ALLOWLIST
    var = DECL_RE.match(decl)
    if var and "Test" in var.group(2):
        return True
    return False


def main() -> int:
    violations: list[str] = []
    scanned = 0
    for path in sorted(CORE_ROOT.rglob("*.zig")):
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        for i, line in enumerate(lines, start=1):
            if not IMPORT_RE.search(line):
                continue
            scanned += 1
            if not is_allowed(path, lines, i - 1):
                violations.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()}")
    if violations:
        print("Production src/core/ imports of src/builtins/ found:", file=sys.stderr)
        for violation in violations:
            print(f"  {violation}", file=sys.stderr)
        print(
            "Thread builtin behavior through the composition root instead, "
            "or scope the import to is_test gating, a test block, or a tests/ file.",
            file=sys.stderr,
        )
        return 1
    print(f"ok: {scanned} src/core/ builtins imports, all test-only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
