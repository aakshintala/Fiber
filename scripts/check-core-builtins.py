#!/usr/bin/env python3
"""Fail when production code in src/core/ imports from src/builtins/.

src/core/ must not depend on src/builtins/ in production code; the
composition root (src/main.zig) injects builtin behavior through typed
contracts instead. A builtins import is test-only exactly when it sits in
one of these scopes:

  1. Inside a `test "..." {}` block, tracked by brace depth to the
     block's closing brace.
  2. Inside an `if (... is_test ...)` region, tracked by brace depth to
     the region's closing brace (a braceless single-statement `if`
     covers just its statement).
  3. In the same declaration statement as an `is_test` condition (the
     multiline-aware `= if (builtin.is_test) @import(...) else ...`
     ternary pattern).
  4. In a file under a `tests/` directory.
  5. Inside a helper function or struct whose every code reference is
     itself test-scoped (rules 1-4, or inside another such helper,
     closed to a fixpoint). Test-only-ness is proven from the reference
     graph, never guessed from names: a `latest` or `contest` function
     in production scope fails even though the names contain "test".

`@import("builtins/...")` expressions are matched across line breaks and
only in code (comments and string literals are ignored). Anything else is
a violation: thread builtin behavior through the composition root
instead.
"""

import bisect
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_ROOT = REPO_ROOT / "src" / "core"
SRC_ROOT = REPO_ROOT / "src"

IMPORT_RE = re.compile(r'@import\s*\(\s*"[^"]*builtins/[^"]*"', re.DOTALL)
TEST_DECL_RE = re.compile(r"^\s*test(?:\s|\")", re.DOTALL)
IF_IS_TEST_RE = re.compile(r"\bif\s*\(.*\bis_test\b", re.DOTALL)
FN_RE = re.compile(r"\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\b")
TYPE_RE = re.compile(
    r"\b(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:struct|union|enum)\b"
)
BRACE_RE = re.compile(r"[{}]")
SIG_BRACE_RE = re.compile(r"\b(struct|union|enum|error)\s*$")
IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")


def _scan_spans(text: str, blank_strings: bool) -> bytearray:
    """Blank comments (and strings/chars when asked); 1 keeps the char."""
    mask = bytearray(b"\x01" * len(text))

    def blank_string(quote: str, i: int, n: int) -> int:
        if blank_strings:
            mask[i] = 0
        i += 1
        while i < n and text[i] != "\n":
            if blank_strings:
                mask[i] = 0
            if text[i] == "\\" and i + 1 < n:
                if blank_strings:
                    mask[i + 1] = 0
                i += 2
                continue
            if text[i] == quote:
                if blank_strings:
                    mask[i] = 0
                i += 1
                break
            i += 1
        return i

    i, n = 0, len(text)
    while i < n:
        c = text[i]
        d = text[i + 1] if i + 1 < n else ""
        if c == "/" and d == "/":
            while i < n and text[i] != "\n":
                mask[i] = 0
                i += 1
        elif c == "/" and d == "*":
            depth = 0
            while i < n:
                if text[i] == "/" and i + 1 < n and text[i + 1] == "*":
                    depth += 1
                    mask[i] = mask[i + 1] = 0
                    i += 2
                elif text[i] == "*" and i + 1 < n and text[i + 1] == "/":
                    depth -= 1
                    mask[i] = mask[i + 1] = 0
                    i += 2
                    if depth == 0:
                        break
                else:
                    mask[i] = 0
                    i += 1
        elif c == "\\" and d == "\\":
            while i < n and text[i] != "\n":
                if blank_strings:
                    mask[i] = 0
                i += 1
        elif c == '"':
            i = blank_string('"', i, n)
        elif c == "'":
            i = blank_string("'", i, n)
        else:
            i += 1
    return mask


def compute_code_mask(text: str) -> bytearray:
    """Mark code characters 1; comments, strings, chars get 0."""
    return _scan_spans(text, True)


def compute_nocomment_mask(text: str) -> bytearray:
    """Mark non-comment characters 1; strings stay readable."""
    return _scan_spans(text, False)


class FileScope:
    """Brace-depth scope map for one Zig file (code characters only)."""

    def __init__(self, path: Path, text: str):
        self.path = path
        self.text = text
        self.mask = compute_code_mask(text)
        self.code = "".join(ch if m else " " for ch, m in zip(text, self.mask))
        nc = compute_nocomment_mask(text)
        self.nocomments = "".join(ch if m else " " for ch, m in zip(text, nc))
        self.lines = text.splitlines()
        starts = []
        off = 0
        for line in self.lines:
            starts.append(off)
            off += len(line) + 1
        self.starts = starts
        self.stripped = [
            self.code[base : base + len(line)]
            for base, line in zip(starts, self.lines)
        ]
        # events[idx] = (col, action) list; action is ("push", frame) or
        # ("pop",). snapshot[idx] = frames enclosing the start of line idx.
        self.events: List[List[tuple]] = [[] for _ in self.lines]
        self.snapshot: List[List[dict]] = [[] for _ in self.lines]
        self.named_frames: List[dict] = []
        self._scan()
        # Code-only identifier index: name -> 0-based lines.
        self.idents: Dict[str, List[int]] = {}
        for m in IDENT_RE.finditer(text):
            if not self.mask[m.start()]:
                continue
            self.idents.setdefault(m.group(), []).append(
                bisect.bisect_right(starts, m.start()) - 1
            )

    def header_text(self, idx: int, upto_col: int) -> Tuple[str, int]:
        """Join wrapped header lines above idx plus line idx before col."""
        parts = [self.stripped[idx][:upto_col]]
        start = idx
        j = idx - 1
        while j >= 0:
            prev = self.stripped[j]
            if not prev.strip() or ";" in prev or "{" in prev or "}" in prev:
                break
            parts.append(prev)
            start = j
            j -= 1
        parts.reverse()
        return "\n".join(parts), start

    @staticmethod
    def _classify(header: str) -> Tuple[str, Optional[str], bool]:
        if TEST_DECL_RE.search(header):
            return ("test", None, False)
        if IF_IS_TEST_RE.search(header):
            return ("istest", None, False)
        fn = FN_RE.search(header)
        if fn:
            return ("fn", fn.group(1), header[: fn.start()].find("pub") >= 0)
        typ = TYPE_RE.search(header)
        if typ:
            return ("type", typ.group(1), header[: typ.start()].find("pub") >= 0)
        return ("other", None, False)

    @staticmethod
    def _closes_inline(line: str, pos: int) -> bool:
        depth = 0
        for ch in line[pos:]:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return True
        return False

    def _scan(self) -> None:
        stack: List[dict] = []
        depth = 0
        pending_fn: Optional[Tuple[str, bool, int]] = None
        for idx, line in enumerate(self.stripped):
            self.snapshot[idx] = list(stack)
            if ";" in line:
                pending_fn = None
            first = True
            seg_start = 0
            for m in BRACE_RE.finditer(line):
                if m.group() == "{":
                    if first:
                        header, hstart = self.header_text(idx, m.start())
                    else:
                        header, hstart = line[seg_start : m.start()], idx
                    kind, name, is_pub = self._classify(header)
                    inline = self._closes_inline(line, m.start())
                    later = "{" in line[m.start() + 1 :]
                    group = line[m.start() + 1 :]
                    group = group[: group.find("}")] if "}" in group else group
                    if (
                        kind == "fn"
                        and inline
                        and later
                        and (
                            SIG_BRACE_RE.search(header)
                            or ":" in group
                            or "," in group
                        )
                    ):
                        # Signature brace (`!struct {...}`, `error{...}`):
                        # not the body; the body `{` follows on this line.
                        pending_fn = (name or "", is_pub, hstart)
                        kind, name = ("other", None)
                    elif kind == "other" and pending_fn and not inline:
                        name_pending, pub_pending, hs_pending = pending_fn
                        kind, name, is_pub = ("fn", name_pending, pub_pending)
                        hstart = min(hstart, hs_pending)
                        pending_fn = None
                    elif not inline:
                        pending_fn = None
                    frame = {
                        "kind": kind,
                        "name": name,
                        "depth": depth,
                        "is_pub": is_pub,
                        "path": self.path,
                        "start": idx,
                        "header_start": hstart,
                        "end": len(self.lines) - 1,
                    }
                    stack.append(frame)
                    if name is not None:
                        self.named_frames.append(frame)
                    self.events[idx].append((m.start(), ("push", frame)))
                    depth += 1
                    first = False
                else:
                    depth = max(0, depth - 1)
                    while stack and stack[-1]["depth"] >= depth:
                        stack[-1]["end"] = idx
                        stack.pop()
                        self.events[idx].append((m.start(), ("pop",)))
                seg_start = m.start() + 1

    def frames_at(self, idx: int, col: int) -> List[dict]:
        frames = list(self.snapshot[idx])
        for col_no, action in self.events[idx]:
            if col_no >= col:
                break
            if action[0] == "push":
                frames.append(action[1])
            elif frames:
                frames.pop()
        return frames

    @staticmethod
    def is_test_scope(frames: List[dict]) -> bool:
        return any(f["kind"] in ("test", "istest") for f in frames)

    def line_is_test_scoped(self, idx: int) -> bool:
        if "tests" in self.path.parts:
            return True
        return self.is_test_scope(
            self.frames_at(idx, len(self.stripped[idx]) + 1)
        )

    def braceless_spans(self) -> List[Tuple[int, int, int, int]]:
        """(start line, start col, end line, end col) of each braceless
        `if (... is_test ...)` statement (terminating `;` inclusive)."""
        spans: List[Tuple[int, int, int, int]] = []
        for idx, line in enumerate(self.stripped):
            m = IF_IS_TEST_RE.search(line)
            if not m or "{" in line:
                continue
            j = idx
            while j < len(self.lines):
                semi = self.stripped[j].find(";")
                if semi >= 0:
                    spans.append((idx, m.start(), j, semi + 1))
                    break
                j += 1
            else:
                spans.append(
                    (idx, m.start(), len(self.lines) - 1,
                     len(self.stripped[-1]) + 1)
                )
        return spans

    def braceless_if_lines(self) -> Set[int]:
        """Lines covered by a braceless `if (... is_test ...)` statement."""
        return {
            ln
            for sl, _, el, _ in self.braceless_spans()
            for ln in range(sl, el + 1)
        }

    def in_braceless_if(self, idx: int, col: int) -> bool:
        """Position-exact braceless coverage: (idx, col) must start after
        the `if` opener on its line (or on a later line of the span)."""
        return any(
            (sl, sc) < (idx, col) <= (el, ec)
            for sl, sc, el, ec in self.braceless_spans()
        )

    def is_test_scoped_at(self, idx: int, col: int) -> bool:
        """Position-exact test scope for an import starting at idx/col."""
        if "tests" in self.path.parts:
            return True
        return self.is_test_scope(
            self.frames_at(idx, col)
        ) or self.in_braceless_if(idx, col)

    def statement_has_is_test(self, start_off: int, end_off: int) -> bool:
        code = self.code
        prev = max(
            code.rfind(";", 0, start_off),
            code.rfind("{", 0, start_off),
            code.rfind("}", 0, start_off),
        )
        stop = code.find(";", end_off)
        stmt = code[prev + 1 : len(code) if stop < 0 else stop]
        return "is_test" in stmt


def main() -> int:
    scopes: Dict[Path, FileScope] = {}
    for path in sorted(SRC_ROOT.rglob("*.zig")):
        scopes[path] = FileScope(path, path.read_text(encoding="utf-8"))
    core = {p: s for p, s in scopes.items() if CORE_ROOT in p.parents}

    allowed_lines: Dict[Path, Set[int]] = {}
    for path, scope in scopes.items():
        if "tests" in path.parts:
            allowed_lines[path] = set(range(len(scope.lines)))
            continue
        ok = {
            i for i in range(len(scope.lines)) if scope.line_is_test_scoped(i)
        }
        ok |= scope.braceless_if_lines()
        allowed_lines[path] = ok

    # Every named function/struct in src/core/ is a justification
    # candidate, so test-only-ness flows through import-free helpers too.
    candidates: List[dict] = []
    for path, scope in core.items():
        candidates.extend(
            f for f in scope.named_frames if f["kind"] in ("fn", "type")
        )

    # Global code-only reference index for pub symbols (file-private
    # symbols resolve within their own file, matching Zig visibility).
    global_refs: Dict[str, List[Tuple[Path, int]]] = {}
    for path, scope in scopes.items():
        for name, lines in scope.idents.items():
            global_refs.setdefault(name, []).extend((path, ln) for ln in lines)

    cand_refs: Dict[int, List[Tuple[Path, int]]] = {}
    for cid, cand in enumerate(candidates):
        name = cand["name"]
        if cand["is_pub"]:
            refs = global_refs.get(name, [])
        else:
            refs = [
                (cand["path"], ln)
                for ln in scopes[cand["path"]].idents.get(name, [])
            ]
        cand_refs[cid] = [
            r
            for r in refs
            if not (
                r[0] == cand["path"]
                and cand["header_start"] <= r[1] <= cand["start"]
            )
        ]

    by_file: Dict[Path, List[int]] = {}
    for cid, cand in enumerate(candidates):
        by_file.setdefault(cand["path"], []).append(cid)

    justified: Dict[int, bool] = {
        cid: bool(refs) for cid, refs in cand_refs.items()
    }

    def ref_ok(ref: Tuple[Path, int], self_cid: int) -> bool:
        rpath, rline = ref
        if rpath in scopes and rline in allowed_lines.get(rpath, set()):
            return True
        for cid in by_file.get(rpath, []):
            if not justified[cid] and cid != self_cid:
                continue
            f = candidates[cid]
            if f["header_start"] <= rline <= f["end"]:
                return True
        return False

    changed = True
    while changed:
        changed = False
        for cid, refs in cand_refs.items():
            if not justified[cid]:
                continue
            if all(ref_ok(r, cid) for r in refs):
                continue
            justified[cid] = False
            changed = True

    def first_bad(cid: int) -> Optional[Tuple[Path, int]]:
        self_cand = candidates[cid]
        for r in cand_refs[cid]:
            rpath, rline = r
            if rpath in scopes and rline in allowed_lines.get(rpath, set()):
                continue
            inside = False
            for other in by_file.get(rpath, []):
                if not justified[other] and other != cid:
                    continue
                f = candidates[other]
                if f["header_start"] <= rline <= f["end"]:
                    inside = True
                    break
            if not inside:
                return r
        return None

    # All builtins imports in src/core/ (multiline-aware; the `@import`
    # keyword itself must sit in code).
    violations: List[Tuple[str, int, str]] = []
    scanned = 0
    pending: List[Tuple[Path, int, int]] = []
    for path, scope in core.items():
        for m in IMPORT_RE.finditer(scope.nocomments):
            if not scope.mask[m.start()]:
                continue
            scanned += 1
            line = bisect.bisect_right(scope.starts, m.start()) - 1
            col = m.start() - (scope.text.rfind("\n", 0, m.start()) + 1)
            if scope.is_test_scoped_at(line, col):
                continue
            start_off = scope.starts[line] + col
            if scope.statement_has_is_test(start_off, m.end()):
                continue
            pending.append((path, line, col))

    for path, line, col in pending:
        scope = scopes[path]
        frames = scope.frames_at(line, col)
        target = next(
            (f for f in reversed(frames) if f["kind"] == "type"), None
        )
        if target is None:
            target = next(
                (f for f in reversed(frames) if f["kind"] == "fn"), None
            )
        excerpt = scope.lines[line].strip()
        loc = f"{path.relative_to(REPO_ROOT)}:{line + 1}: {excerpt}"
        if target is None or target["name"] is None:
            violations.append((str(path.relative_to(REPO_ROOT)), line, loc))
            continue
        cid = next(
            (
                i
                for i in by_file.get(path, [])
                if candidates[i]["name"] == target["name"]
                and candidates[i]["start"] == target["start"]
            ),
            None,
        )
        if cid is not None and justified[cid]:
            continue
        bad = first_bad(cid) if cid is not None else None
        where = (
            f" (helper `{target['name']}` referenced from production scope at "
            f"{bad[0].relative_to(REPO_ROOT)}:{bad[1] + 1})" if bad else ""
        )
        violations.append(
            (str(path.relative_to(REPO_ROOT)), line, loc + where)
        )
    violations.sort()
    if violations:
        print(
            "Production src/core/ imports of src/builtins/ found:",
            file=sys.stderr,
        )
        for _, _, text in violations:
            print(f"  {text}", file=sys.stderr)
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
