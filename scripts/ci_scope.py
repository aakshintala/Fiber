"""Select CI jobs from a pull request diff, and fail-close the aggregate check.

The scope job classifies each changed path and exposes the union as workflow
outputs. The aggregate job reads that selection plus ``toJSON(needs)`` and
accepts a run only when every selected job succeeded and every unselected job
was skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from collections.abc import Callable, Mapping, Sequence


ALWAYS_JOBS = ("scope", "shellcheck", "static")
SELECTABLE_JOBS = (
    "native",
    "pgso-driver",
    "conformance",
    "e2e",
    "bench",
    "binary-size",
)
ALL_JOBS = ALWAYS_JOBS + SELECTABLE_JOBS

PLATFORM_LINUX_X86_64 = {
    "name": "linux-x86_64",
    "runner": "ubuntu-24.04",
    "zig_tarball": "zig-x86_64-linux",
}
PLATFORM_LINUX_AARCH64 = {
    "name": "linux-aarch64",
    "runner": "ubuntu-24.04-arm",
    "zig_tarball": "zig-aarch64-linux",
}
PLATFORM_MACOS_AARCH64 = {
    "name": "macos-aarch64",
    "runner": "macos-15",
    "zig_tarball": "zig-aarch64-macos",
}
ALL_PLATFORMS = (
    PLATFORM_LINUX_X86_64,
    PLATFORM_LINUX_AARCH64,
    PLATFORM_MACOS_AARCH64,
)

SCAN_ROOTS = (".github", "tests", "benchmarks", "scripts")
SCAN_FILES = ("build.zig",)
SKIP_DIR_NAMES = {".git", "node_modules", ".zig-cache", "zig-out"}
TUI_PERFORMANCE = "tui-performance.test.ts"
_E2E_ROOT_TEST = re.compile(r"^tests/e2e/([^/]+\.test\.ts)$")


class Selection:
    """Selected jobs, E2E matrix inputs, and the reasons printed to the log."""

    def __init__(
        self,
        jobs: Sequence[str],
        e2e_platforms: Sequence[Mapping[str, str]],
        e2e_files: str,
        e2e_shards: Sequence[Mapping[str, object]],
        path_classes: Sequence[tuple[str, str]],
        reasons: Mapping[str, str],
    ) -> None:
        self.jobs = list(jobs)
        self.e2e_platforms = [dict(platform) for platform in e2e_platforms]
        self.e2e_files = e2e_files
        self.e2e_shards = [dict(shard) for shard in e2e_shards]
        self.path_classes = list(path_classes)
        self.reasons = dict(reasons)


def select_jobs(
    changed_paths: Sequence[str],
    event: str,
    head_root: pathlib.Path,
) -> Selection:
    """Return the job selection for ``changed_paths`` against ``head_root``."""

    head_root = pathlib.Path(head_root)
    paths = [path.strip() for path in changed_paths if path.strip()]
    corpus: list[tuple[str, str]] | None = None

    def references() -> list[tuple[str, str]]:
        nonlocal corpus
        if corpus is None:
            corpus = _scan_reference_corpus(head_root)
        return corpus

    path_classes = [
        (path, classify_path(path, head_root, references)) for path in paths
    ]
    wanted, e2e_all, e2e_names, selectors = _jobs_from_classes(path_classes)
    skip_reasons: dict[str, str] = {}

    if event == "workflow_dispatch":
        jobs = set(ALWAYS_JOBS + SELECTABLE_JOBS)
        jobs.discard("binary-size")
        skip_reasons["binary-size"] = "manual dispatch excludes binary-size"
        e2e_files = "all"
        platforms = [dict(platform) for platform in ALL_PLATFORMS]
    else:
        jobs = set(wanted)
        e2e_files = "all" if e2e_all else " ".join(sorted(e2e_names))
        platforms = [dict(platform) for platform in ALL_PLATFORMS]

    jobs.update(ALWAYS_JOBS)

    file_count = _e2e_file_count(head_root, e2e_files)
    if "e2e" not in jobs or file_count == 0 or not platforms:
        jobs.discard("e2e")
        e2e_files = ""
        platforms = []
        shards: list[dict[str, object]] = []
    else:
        shards = _e2e_shard_matrix(file_count)

    reasons = _job_reasons(
        event=event,
        jobs=jobs,
        skip_reasons=skip_reasons,
        selectors=selectors,
    )
    return Selection(
        jobs=sorted(jobs),
        e2e_platforms=platforms,
        e2e_files=e2e_files,
        e2e_shards=shards,
        path_classes=path_classes,
        reasons=reasons,
    )


def classify_path(
    path: str,
    head_root: pathlib.Path,
    references: Callable[[], Sequence[tuple[str, str]]],
) -> str:
    """Return the class string for a repo-relative path. First rule wins."""

    if path == "src" or path.startswith("src/"):
        return "FULL"
    if path.endswith(".md") and not _under(path, "tests/e2e"):
        return "STATIC"
    if _under(path, "docs"):
        return "STATIC"
    e2e_file = _E2E_ROOT_TEST.match(path)
    if e2e_file is not None:
        if (head_root / path).is_file():
            return "E2E_FILE({})".format(e2e_file.group(1))
        return "E2E_SHARED"
    if _under(path, "tests/e2e"):
        return "E2E_SHARED"
    if _is_script_path(path):
        if _is_referenced(path, references()):
            return "FULL"
        return "STATIC"
    return "FULL"


def aggregate_errors(
    selected: Sequence[str] | None,
    needs: Mapping[str, object],
) -> list[str]:
    """Return error strings for a selected job list and a ``needs`` object."""

    if selected is None:
        return ["scope jobs output is missing or unparseable"]

    selected_set = set(selected)
    errors: list[str] = []
    for job in selected:
        if job not in needs:
            errors.append("selected job {} is missing from needs".format(job))
    for job in needs:
        payload = needs[job]
        result = payload.get("result") if isinstance(payload, dict) else None
        if job in selected_set:
            if result != "success":
                errors.append("selected job {} reported {}".format(job, result))
        elif result != "skipped":
            errors.append("unselected job {} reported {}".format(job, result))
    return errors


def parse_selected(raw: str | None) -> list[str] | None:
    """Parse the scope ``jobs`` output. Missing or unparseable input is None."""

    if raw is None or raw.strip() == "":
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return value


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def _is_script_path(path: str) -> bool:
    if not (path.endswith(".sh") or path.endswith(".py")):
        return False
    basename = path.rsplit("/", 1)[-1]
    if basename == "__init__.py":
        return False
    if "/" not in path:
        return True
    return path.startswith("scripts/")


def _scan_reference_corpus(head_root: pathlib.Path) -> list[tuple[str, str]]:
    corpus: list[tuple[str, str]] = []
    for rel_root in SCAN_ROOTS:
        root = head_root / rel_root
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in SKIP_DIR_NAMES]
            for filename in filenames:
                path = pathlib.Path(dirpath) / filename
                corpus.append((_relative_posix(head_root, path), _read_text(path)))
    for rel_file in SCAN_FILES:
        path = head_root / rel_file
        if path.is_file():
            corpus.append((rel_file, _read_text(path)))
    return corpus


def _relative_posix(head_root: pathlib.Path, path: pathlib.Path) -> str:
    return path.relative_to(head_root).as_posix()


def _read_text(path: pathlib.Path) -> str:
    return path.read_bytes().decode("utf-8", errors="ignore")


def _is_referenced(script_path: str, corpus: Sequence[tuple[str, str]]) -> bool:
    basename = pathlib.PurePosixPath(script_path).name
    stem = pathlib.PurePosixPath(script_path).stem
    stem_re = re.compile(r"(?<![\w-])" + re.escape(stem) + r"(?![\w-])")
    for rel_path, text in corpus:
        if rel_path == script_path:
            continue
        if basename in text or stem_re.search(text):
            return True
    return False


def _jobs_from_classes(
    path_classes: Sequence[tuple[str, str]],
) -> tuple[set[str], bool, set[str], dict[str, list[str]]]:
    selectors = {job: [] for job in SELECTABLE_JOBS}  # type: dict[str, list[str]]
    e2e_all = False
    e2e_names: set[str] = set()

    def mark(job: str, path: str, cls: str) -> None:
        selectors[job].append("{} ({})".format(path, cls))

    for path, cls in path_classes:
        if cls == "STATIC":
            continue
        if cls.startswith("E2E_FILE(") and cls.endswith(")"):
            name = cls[len("E2E_FILE(") : -1]
            e2e_names.add(name)
            mark("e2e", path, cls)
            mark("pgso-driver", path, cls)
            if name == TUI_PERFORMANCE:
                mark("bench", path, cls)
            continue
        if cls == "E2E_SHARED":
            e2e_all = True
            for job in ("e2e", "conformance", "pgso-driver", "bench"):
                mark(job, path, cls)
            continue
        e2e_all = True
        mark("native", path, cls)
        for job in ("pgso-driver", "conformance", "e2e", "bench", "binary-size"):
            mark(job, path, cls)

    wanted = {job for job, marked in selectors.items() if marked}
    return wanted, e2e_all, e2e_names, selectors


def _e2e_test_files(head_root: pathlib.Path) -> list[str]:
    directory = head_root / "tests" / "e2e"
    if not directory.is_dir():
        return []
    names = [
        entry.name
        for entry in directory.iterdir()
        if entry.is_file() and entry.name.endswith(".test.ts")
    ]
    names.sort()
    return names


def _e2e_file_count(head_root: pathlib.Path, e2e_files: str) -> int:
    if e2e_files == "all":
        return len(_e2e_test_files(head_root))
    if not e2e_files:
        return 0
    return len(e2e_files.split())


def _e2e_shard_matrix(file_count: int) -> list[dict[str, object]]:
    shard_count = min(3, file_count)
    if shard_count <= 0:
        return []
    return [
        {
            "index": index,
            "shard_count": shard_count,
            "label": "{}/{}".format(index + 1, shard_count),
        }
        for index in range(shard_count)
    ]


def _job_reasons(
    event: str,
    jobs: set[str],
    skip_reasons: Mapping[str, str],
    selectors: Mapping[str, Sequence[str]],
) -> dict[str, str]:
    reasons: dict[str, str] = {}
    for job in ALL_JOBS:
        if job in skip_reasons:
            reasons[job] = skip_reasons[job]
            continue
        if job in ALWAYS_JOBS:
            reasons[job] = "always selected"
            continue
        if job not in jobs:
            reasons[job] = "no changed path selects it"
            continue
        if event == "workflow_dispatch":
            reasons[job] = "manual dispatch selects every job except binary-size"
            continue
        marked = list(selectors.get(job, ()))
        if marked:
            reasons[job] = "selected by " + ", ".join(marked)
        else:
            reasons[job] = "selected"
    return reasons


def _compact_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def _write_outputs(selection: Selection) -> None:
    lines = [
        "jobs={}".format(_compact_json(selection.jobs)),
        "e2e_platforms={}".format(_compact_json(selection.e2e_platforms)),
        "e2e_files={}".format(selection.e2e_files),
        "e2e_shards={}".format(_compact_json(selection.e2e_shards)),
    ]
    text = "\n".join(lines) + "\n"
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(text)
        return
    sys.stdout.write(text)


def _log_selection(selection: Selection) -> None:
    for path, cls in selection.path_classes:
        sys.stderr.write("{}: {}\n".format(path, cls))
    for job in ALL_JOBS:
        status = "selected" if job in selection.jobs else "skipped"
        sys.stderr.write("{} {}: {}\n".format(job, status, selection.reasons[job]))


def _cmd_select(args: argparse.Namespace) -> int:
    paths = [line.strip() for line in sys.stdin if line.strip()]
    selection = select_jobs(
        paths,
        event=args.event,
        head_root=args.head_root,
    )
    _write_outputs(selection)
    _log_selection(selection)
    return 0


def _cmd_aggregate() -> int:
    selected = parse_selected(os.environ.get("SELECTED"))
    needs_raw = os.environ.get("NEEDS")
    try:
        needs = json.loads(needs_raw) if needs_raw else None
    except json.JSONDecodeError:
        needs = None
    if selected is None:
        errors = ["scope jobs output is missing or unparseable"]
    elif not isinstance(needs, dict):
        errors = ["needs is missing or unparseable"]
    else:
        errors = aggregate_errors(selected, needs)
    if errors:
        for error in errors:
            sys.stdout.write("::error::{}\n".format(error))
        return 1
    sys.stdout.write("Selected jobs succeeded; unselected jobs were skipped.\n")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    select_parser = subparsers.add_parser(
        "select", help="classify a changed-path list and emit job outputs"
    )
    select_parser.add_argument(
        "--event",
        choices=("pull_request", "workflow_dispatch"),
        required=True,
    )
    select_parser.add_argument("--head-root", type=pathlib.Path, required=True)
    subparsers.add_parser("aggregate", help="fail-close the CI aggregate check")
    args = parser.parse_args(argv)
    if args.command == "select":
        return _cmd_select(args)
    return _cmd_aggregate()


if __name__ == "__main__":
    raise SystemExit(main())
