"""Decide whether a commit's version warrants a release.

The decision lives here rather than inline in release.yml so it can be tested
without a live publication. A wrong answer here either publishes something that
should not exist or silently refuses to publish something that should, and
neither failure is visible until it has already happened.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
from collections.abc import Sequence


VERSION_PATTERN = re.compile(r'^pub const version = "([^"]*)";', re.MULTILINE)

# Strict SemVer. The major/minor/patch core is byte-for-byte the rule release.yml
# already enforced; the optional prerelease and build groups are the only
# addition, so a stable version is accepted exactly as before.
SEMVER_PATTERN = re.compile(
    r"^(?P<major>0|[1-9]\d*)"
    r"\.(?P<minor>0|[1-9]\d*)"
    r"\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>"
    r"(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*"
    r"))?"
    r"(?:\+(?P<build>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


class ReleaseDecisionError(RuntimeError):
    """A version could not be read or is not strict SemVer."""


def read_version(source: pathlib.Path) -> str:
    """Return the version string declared by a Zig source file."""
    match = VERSION_PATTERN.search(source.read_text(encoding="utf-8"))
    if match is None:
        raise ReleaseDecisionError(f"no 'pub const version' declaration in {source}")
    return match.group(1)


def is_prerelease(version: str) -> bool:
    """Return True when the version carries a SemVer prerelease identifier."""
    match = SEMVER_PATTERN.match(version)
    if match is None:
        raise ReleaseDecisionError(f"version is not strict SemVer: {version!r}")
    return match.group("prerelease") is not None


def decide(version: str, tag_exists: bool | None) -> tuple[bool, str, str]:
    """Return (release_needed, tag, reason) for a version.

    tag_exists may be None only for a prerelease, which is refused before the
    tag is ever consulted.
    """
    tag = f"v{version}"
    if is_prerelease(version):
        return False, tag, f"{version} is a prerelease; no release is published"
    if tag_exists is None:
        raise ReleaseDecisionError(
            f"tag existence for {tag} is required to decide a stable version"
        )
    if tag_exists:
        return False, tag, f"tag {tag} exists, no release needed"
    return True, tag, f"tag {tag} missing, release needed"


def tag_exists_in_git(tag: str) -> bool:
    """Return True when a tag resolves in the current repository."""
    result = subprocess.run(
        ["git", "rev-parse", "-q", "--verify", f"refs/tags/{tag}"],
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument(
        "--tag-exists",
        choices=("true", "false"),
        help="override the git tag lookup; intended for tests",
    )
    parser.add_argument("--github-output", type=pathlib.Path)
    args = parser.parse_args(argv)

    version = read_version(args.source)

    override = None if args.tag_exists is None else args.tag_exists == "true"
    if override is None and not is_prerelease(version):
        override = tag_exists_in_git(f"v{version}")

    needed, tag, reason = decide(version, override)

    print(reason)
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"version={tag}\n")
            handle.write(f"needed={'true' if needed else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
