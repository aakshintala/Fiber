from __future__ import annotations

import pathlib
import tempfile
import unittest

from scripts.release_decision import (
    ReleaseDecisionError,
    decide,
    is_prerelease,
    main,
    read_version,
)


class ReleaseDecisionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp())

    def write_source(self, version: str) -> pathlib.Path:
        source = self.root / "main.zig"
        source.write_text(
            f'const std = @import("std");\n\npub const version = "{version}";\n',
            encoding="utf-8",
        )
        return source

    # The three cases the transition depends on.

    def test_prerelease_is_never_released(self) -> None:
        needed, tag, reason = decide("0.0.1-dev", tag_exists=None)
        self.assertFalse(needed)
        self.assertEqual("v0.0.1-dev", tag)
        self.assertIn("prerelease", reason)

    def test_existing_stable_tag_is_not_rereleased(self) -> None:
        needed, tag, _ = decide("1.2.3", tag_exists=True)
        self.assertFalse(needed)
        self.assertEqual("v1.2.3", tag)

    def test_missing_stable_tag_is_released(self) -> None:
        needed, tag, _ = decide("1.2.3", tag_exists=False)
        self.assertTrue(needed)
        self.assertEqual("v1.2.3", tag)

    # A prerelease must be refused without consulting the tag at all, so a
    # lookup failure can never turn into a publication.
    def test_prerelease_decision_needs_no_tag_lookup(self) -> None:
        self.assertFalse(decide("0.0.1-dev", tag_exists=True)[0])
        self.assertFalse(decide("0.0.1-dev", tag_exists=False)[0])

    def test_stable_version_requires_tag_knowledge(self) -> None:
        with self.assertRaises(ReleaseDecisionError):
            decide("1.2.3", tag_exists=None)

    def test_prerelease_detection(self) -> None:
        for version in ("0.0.1-dev", "1.0.0-rc.1", "1.0.0-0.3.7", "1.0.0-x.7.z.92"):
            self.assertTrue(is_prerelease(version), version)
        for version in ("0.0.1", "1.2.3", "10.20.30", "1.2.3+build.1"):
            self.assertFalse(is_prerelease(version), version)

    def test_malformed_versions_are_rejected(self) -> None:
        for version in ("", "1.2", "1.2.3.4", "01.2.3", "v1.2.3", "1.2.3-", "abc"):
            with self.assertRaises(ReleaseDecisionError, msg=version):
                is_prerelease(version)

    def test_read_version(self) -> None:
        self.assertEqual("0.0.1-dev", read_version(self.write_source("0.0.1-dev")))

    def test_read_version_rejects_a_source_without_a_declaration(self) -> None:
        source = self.root / "main.zig"
        source.write_text("pub fn main() void {}\n", encoding="utf-8")
        with self.assertRaises(ReleaseDecisionError):
            read_version(source)

    def test_cli_writes_github_output_for_a_prerelease(self) -> None:
        source = self.write_source("0.0.1-dev")
        output = self.root / "github-output"
        self.assertEqual(
            0,
            main(["--source", str(source), "--github-output", str(output)]),
        )
        self.assertEqual(
            "version=v0.0.1-dev\nneeded=false\n",
            output.read_text(encoding="utf-8"),
        )

    def test_cli_appends_rather_than_truncating(self) -> None:
        source = self.write_source("0.0.1-dev")
        output = self.root / "github-output"
        output.write_text("existing=1\n", encoding="utf-8")
        main(["--source", str(source), "--github-output", str(output)])
        self.assertTrue(
            output.read_text(encoding="utf-8").startswith("existing=1\n")
        )

    def test_cli_honours_the_tag_override_for_a_stable_version(self) -> None:
        source = self.write_source("1.2.3")
        output = self.root / "github-output"
        main(
            [
                "--source",
                str(source),
                "--tag-exists",
                "false",
                "--github-output",
                str(output),
            ]
        )
        self.assertIn("needed=true", output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
