from __future__ import annotations

import pathlib
import shutil
import tempfile
import unittest

from scripts.ci_scope import aggregate_errors, select_jobs


ALWAYS = ["scope", "shellcheck", "static"]
FULL_EXTRA = [
    "bench",
    "binary-size",
    "build",
    "conformance",
    "e2e",
    "native",
    "pgso-driver",
]
LINUX_X86 = {
    "name": "linux-x86_64",
    "runner": "ubuntu-24.04",
    "target": "x86_64-linux",
}
LINUX_ARM = {
    "name": "linux-aarch64",
    "runner": "ubuntu-24.04-arm",
    "target": "aarch64-linux",
}
MACOS_ARM = {
    "name": "macos-aarch64",
    "runner": "macos-15",
    "target": "aarch64-macos",
}


def _entry(
    platform: dict[str, str], index: int, shard_count: int, lanes: int
) -> dict[str, object]:
    return {
        "name": platform["name"],
        "runner": platform["runner"],
        "target": platform["target"],
        "index": index,
        "shard_count": shard_count,
        "label": "{}/{}".format(index + 1, shard_count),
        "lanes": lanes,
    }


def _e2e_matrix(*, linux_shards: int, macos_shards: int) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for platform in (LINUX_X86, LINUX_ARM):
        for index in range(linux_shards):
            entries.append(_entry(platform, index, linux_shards, 3))
    for index in range(macos_shards):
        entries.append(_entry(MACOS_ARM, index, macos_shards, 6))
    return entries


FULL_MATRIX = _e2e_matrix(linux_shards=3, macos_shards=1)
SINGLE_FILE_MATRIX = _e2e_matrix(linux_shards=1, macos_shards=1)
TWO_FILE_MATRIX = _e2e_matrix(linux_shards=2, macos_shards=1)


class SelectJobsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self._write(
            {
                "tests/e2e/alpha.test.ts": "export {}\n",
                "tests/e2e/beta.test.ts": "export {}\n",
                "tests/e2e/gamma.test.ts": "export {}\n",
            }
        )

    def _write(self, files: dict[str, str]) -> None:
        for relative, content in files.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def _select(self, paths: list[str], *, event: str = "pull_request"):
        return select_jobs(paths, event=event, head_root=self.root)

    def _assert_jobs(self, selection, extra: list[str]) -> None:
        self.assertEqual(sorted(ALWAYS + extra), selection.jobs)
        self.assertEqual("e2e" in selection.jobs, "build" in selection.jobs)

    def _class_for(self, selection, path: str) -> str:
        return dict(selection.path_classes)[path]

    def test_docs_only_selects_static_gates(self) -> None:
        selection = self._select(["README.md", "docs/guide.md"])
        self._assert_jobs(selection, [])
        self.assertEqual("", selection.e2e_files)
        self.assertEqual([], selection.e2e_matrix)
        self.assertEqual("STATIC", self._class_for(selection, "README.md"))
        self.assertEqual("STATIC", self._class_for(selection, "docs/guide.md"))
        self.assertEqual("always selected", selection.reasons["static"])
        self.assertEqual("no changed path selects it", selection.reasons["native"])
        self.assertEqual(
            "no changed path selects it", selection.reasons["pgso-driver"]
        )
        self.assertEqual("no changed path selects it", selection.reasons["build"])

    def test_unreferenced_script_is_static(self) -> None:
        self._write({"scripts/orphan_ci_scope.sh": "#!/bin/sh\n"})
        selection = self._select(["scripts/orphan_ci_scope.sh"])
        self._assert_jobs(selection, [])
        self.assertEqual("STATIC", self._class_for(selection, "scripts/orphan_ci_scope.sh"))

    def test_script_referenced_by_a_workflow_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                ".github/workflows/ci.yml": "run: ./scripts/used.sh\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_script_referenced_by_build_zig_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "build.zig": "exe.addCSourceFile(.{ .file = \"used.sh\" });\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_script_referenced_by_a_test_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "tests/e2e/alpha.test.ts": "spawn('used.sh');\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_script_referenced_by_a_benchmark_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "benchmarks/startup.sh": "hyperfine used.sh\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_script_referenced_by_python_module_stem_is_full(self) -> None:
        self._write(
            {
                "scripts/helper_mod.py": "VALUE = 1\n",
                "scripts/other.py": "from .helper_mod import VALUE\n",
            }
        )
        selection = self._select(["scripts/helper_mod.py"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/helper_mod.py"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_markdown_under_src_is_full(self) -> None:
        self._write({"src/system_prompt.md": "# prompt\n"})
        selection = self._select(["src/system_prompt.md"])
        self.assertEqual("FULL", self._class_for(selection, "src/system_prompt.md"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_root_e2e_file_only(self) -> None:
        selection = self._select(["tests/e2e/alpha.test.ts"])
        self.assertEqual(
            "E2E_FILE(alpha.test.ts)",
            self._class_for(selection, "tests/e2e/alpha.test.ts"),
        )
        self._assert_jobs(selection, ["build", "e2e", "pgso-driver"])
        self.assertEqual("alpha.test.ts", selection.e2e_files)
        self.assertEqual(SINGLE_FILE_MATRIX, selection.e2e_matrix)
        self.assertEqual("no changed path selects it", selection.reasons["native"])
        self.assertEqual("no changed path selects it", selection.reasons["bench"])
        self.assertEqual(
            "no changed path selects it", selection.reasons["conformance"]
        )
        self.assertEqual(
            "no changed path selects it", selection.reasons["binary-size"]
        )
        self.assertEqual(
            "selected whenever e2e is selected", selection.reasons["build"]
        )

    def test_tui_performance_selects_bench(self) -> None:
        self._write({"tests/e2e/tui-performance.test.ts": "export {}\n"})
        selection = self._select(["tests/e2e/tui-performance.test.ts"])
        self._assert_jobs(selection, ["bench", "build", "e2e", "pgso-driver"])
        self.assertEqual("tui-performance.test.ts", selection.e2e_files)
        self.assertEqual(SINGLE_FILE_MATRIX, selection.e2e_matrix)
        self.assertIn("tui-performance.test.ts", selection.reasons["bench"])

    def test_shared_e2e_inputs(self) -> None:
        shared = (
            "tests/e2e/helpers.ts",
            "tests/e2e/fixtures/x",
            "tests/e2e/ci-shard-weights.json",
            "tests/e2e/package.json",
            "tests/e2e/tsconfig.json",
            "tests/e2e/conformance/x",
        )
        for path in shared:
            with self.subTest(path=path):
                self._write({path: "x\n"})
                selection = self._select([path])
                self.assertEqual("E2E_SHARED", self._class_for(selection, path))
                self._assert_jobs(
                    selection, ["bench", "build", "conformance", "e2e", "pgso-driver"]
                )
                self.assertEqual("all", selection.e2e_files)
                self.assertEqual(FULL_MATRIX, selection.e2e_matrix)

    def test_e2e_file_mixed_with_source_is_full(self) -> None:
        self._write({"src/main.zig": "pub fn main() void {}\n"})
        selection = self._select(["tests/e2e/alpha.test.ts", "src/main.zig"])
        self.assertEqual("FULL", self._class_for(selection, "src/main.zig"))
        self._assert_jobs(selection, FULL_EXTRA)
        self.assertEqual("all", selection.e2e_files)
        self.assertEqual(FULL_MATRIX, selection.e2e_matrix)

    def test_source_is_full(self) -> None:
        self._write({"src/main.zig": "pub fn main() void {}\n"})
        selection = self._select(["src/main.zig"])
        self.assertEqual("FULL", self._class_for(selection, "src/main.zig"))
        self._assert_jobs(selection, FULL_EXTRA)
        self.assertEqual(FULL_MATRIX, selection.e2e_matrix)
        self.assertIn("native", selection.jobs)

    def test_build_zig_is_full(self) -> None:
        self._write({"build.zig": "pub fn build() void {}\n"})
        selection = self._select(["build.zig"])
        self.assertEqual("FULL", self._class_for(selection, "build.zig"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_workflow_is_full(self) -> None:
        self._write({".github/workflows/ci.yml": "name: CI\n"})
        selection = self._select([".github/workflows/ci.yml"])
        self.assertEqual("FULL", self._class_for(selection, ".github/workflows/ci.yml"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_composite_action_is_full(self) -> None:
        self._write({".github/actions/setup-pgso/action.yml": "name: setup\n"})
        selection = self._select([".github/actions/setup-pgso/action.yml"])
        self.assertEqual(
            "FULL",
            self._class_for(selection, ".github/actions/setup-pgso/action.yml"),
        )
        self._assert_jobs(selection, FULL_EXTRA)

    def test_unknown_path_is_full(self) -> None:
        selection = self._select(["vendor/mystery.bin"])
        self.assertEqual("FULL", self._class_for(selection, "vendor/mystery.bin"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_deleted_unreferenced_script_is_static(self) -> None:
        selection = self._select(["scripts/gone.sh"])
        self.assertEqual("STATIC", self._class_for(selection, "scripts/gone.sh"))
        self._assert_jobs(selection, [])

    def test_deleted_root_e2e_file_is_shared(self) -> None:
        selection = self._select(["tests/e2e/gone.test.ts"])
        self.assertEqual("E2E_SHARED", self._class_for(selection, "tests/e2e/gone.test.ts"))
        self._assert_jobs(
            selection, ["bench", "build", "conformance", "e2e", "pgso-driver"]
        )
        self.assertEqual("all", selection.e2e_files)

    def test_rename_static_to_full_selects_full(self) -> None:
        self._write({"src/moved.md": "# moved\n"})
        selection = self._select(["README.md", "src/moved.md"])
        self.assertEqual("STATIC", self._class_for(selection, "README.md"))
        self.assertEqual("FULL", self._class_for(selection, "src/moved.md"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_rename_full_to_static_selects_full(self) -> None:
        self._write({"docs/old.md": "# old\n"})
        selection = self._select(["src/old.zig", "docs/old.md"])
        self.assertEqual("FULL", self._class_for(selection, "src/old.zig"))
        self.assertEqual("STATIC", self._class_for(selection, "docs/old.md"))
        self._assert_jobs(selection, FULL_EXTRA)

    def test_manual_dispatch_ignores_diff_and_excludes_binary_size(self) -> None:
        selection = self._select(["README.md"], event="workflow_dispatch")
        self._assert_jobs(
            selection,
            [
                "bench",
                "build",
                "conformance",
                "e2e",
                "native",
                "pgso-driver",
            ],
        )
        self.assertNotIn("binary-size", selection.jobs)
        self.assertEqual("all", selection.e2e_files)
        self.assertEqual(FULL_MATRIX, selection.e2e_matrix)
        self.assertEqual(
            "manual dispatch excludes binary-size",
            selection.reasons["binary-size"],
        )

    def test_full_e2e_matrix_has_seven_entries(self) -> None:
        selection = self._select(["src/main.zig"])
        self.assertEqual(FULL_MATRIX, selection.e2e_matrix)
        self.assertEqual(7, len(selection.e2e_matrix))
        linux = [entry for entry in selection.e2e_matrix if entry["name"].startswith("linux-")]
        macos = [entry for entry in selection.e2e_matrix if entry["name"] == "macos-aarch64"]
        self.assertEqual(6, len(linux))
        self.assertEqual(3, len([e for e in linux if e["name"] == "linux-x86_64"]))
        self.assertEqual(3, len([e for e in linux if e["name"] == "linux-aarch64"]))
        self.assertTrue(all(entry["lanes"] == 3 for entry in linux))
        self.assertTrue(all(entry["shard_count"] == 3 for entry in linux))
        self.assertEqual(1, len(macos))
        self.assertEqual(6, macos[0]["lanes"])
        self.assertEqual(1, macos[0]["shard_count"])
        self.assertEqual("1/1", macos[0]["label"])

    def test_single_file_e2e_matrix_is_one_shard_per_platform(self) -> None:
        selection = self._select(["tests/e2e/alpha.test.ts"])
        self.assertEqual(SINGLE_FILE_MATRIX, selection.e2e_matrix)
        self.assertEqual(3, len(selection.e2e_matrix))
        self.assertTrue(all(entry["shard_count"] == 1 for entry in selection.e2e_matrix))
        self.assertEqual(
            ["linux-x86_64", "linux-aarch64", "macos-aarch64"],
            [entry["name"] for entry in selection.e2e_matrix],
        )

    def test_two_file_e2e_matrix_caps_macos_at_one_shard(self) -> None:
        selection = self._select(["tests/e2e/alpha.test.ts", "tests/e2e/beta.test.ts"])
        self.assertEqual("alpha.test.ts beta.test.ts", selection.e2e_files)
        self.assertEqual(TWO_FILE_MATRIX, selection.e2e_matrix)
        linux = [entry for entry in selection.e2e_matrix if entry["name"].startswith("linux-")]
        macos = [entry for entry in selection.e2e_matrix if entry["name"] == "macos-aarch64"]
        self.assertEqual(4, len(linux))
        self.assertTrue(all(entry["shard_count"] == 2 for entry in linux))
        self.assertEqual(1, len(macos))
        self.assertEqual(1, macos[0]["shard_count"])

    def test_shard_count_follows_selected_file_count(self) -> None:
        one = self._select(["tests/e2e/alpha.test.ts"])
        self.assertEqual(SINGLE_FILE_MATRIX, one.e2e_matrix)

        two = self._select(["tests/e2e/alpha.test.ts", "tests/e2e/beta.test.ts"])
        self.assertEqual("alpha.test.ts beta.test.ts", two.e2e_files)
        self.assertEqual(TWO_FILE_MATRIX, two.e2e_matrix)

        full = self._select(["src/main.zig"])
        self.assertEqual("all", full.e2e_files)
        self.assertEqual(FULL_MATRIX, full.e2e_matrix)

    def test_build_is_selected_exactly_when_e2e_is(self) -> None:
        docs = self._select(["README.md"])
        self.assertNotIn("e2e", docs.jobs)
        self.assertNotIn("build", docs.jobs)

        one = self._select(["tests/e2e/alpha.test.ts"])
        self.assertIn("e2e", one.jobs)
        self.assertIn("build", one.jobs)

        full = self._select(["src/main.zig"])
        self.assertIn("e2e", full.jobs)
        self.assertIn("build", full.jobs)

        dispatch = self._select(["README.md"], event="workflow_dispatch")
        self.assertIn("e2e", dispatch.jobs)
        self.assertIn("build", dispatch.jobs)

        for path in (self.root / "tests" / "e2e").glob("*.test.ts"):
            path.unlink()
        self._write({"tests/e2e/helpers.ts": "x\n"})
        empty = self._select(["tests/e2e/helpers.ts"])
        self.assertNotIn("e2e", empty.jobs)
        self.assertNotIn("build", empty.jobs)
        self.assertEqual([], empty.e2e_matrix)

    def test_init_py_is_full(self) -> None:
        self._write({"scripts/__init__.py": ""})
        selection = self._select(["scripts/__init__.py"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/__init__.py"))
        self._assert_jobs(selection, FULL_EXTRA)


class AggregateTests(unittest.TestCase):
    def test_selected_success_passes(self) -> None:
        self.assertEqual(
            [],
            aggregate_errors(
                ["static"],
                {"static": {"result": "success"}},
            ),
        )

    def test_selected_skipped_fails(self) -> None:
        errors = aggregate_errors(
            ["static"],
            {"static": {"result": "skipped"}},
        )
        self.assertTrue(errors)
        self.assertIn("selected job static reported skipped", errors)

    def test_selected_cancelled_fails(self) -> None:
        errors = aggregate_errors(
            ["static"],
            {"static": {"result": "cancelled"}},
        )
        self.assertTrue(errors)
        self.assertIn("selected job static reported cancelled", errors)

    def test_selected_failure_fails(self) -> None:
        errors = aggregate_errors(
            ["static"],
            {"static": {"result": "failure"}},
        )
        self.assertTrue(errors)
        self.assertIn("selected job static reported failure", errors)

    def test_unselected_success_fails(self) -> None:
        errors = aggregate_errors(
            ["static"],
            {
                "static": {"result": "success"},
                "e2e": {"result": "success"},
            },
        )
        self.assertTrue(errors)
        self.assertIn("unselected job e2e reported success", errors)

    def test_unselected_skipped_passes(self) -> None:
        self.assertEqual(
            [],
            aggregate_errors(
                ["static"],
                {
                    "static": {"result": "success"},
                    "e2e": {"result": "skipped"},
                },
            ),
        )

    def test_selected_job_missing_from_needs_fails(self) -> None:
        errors = aggregate_errors(
            ["static", "e2e"],
            {"static": {"result": "success"}},
        )
        self.assertTrue(errors)
        self.assertIn("selected job e2e is missing from needs", errors)

    def test_none_selection_fails(self) -> None:
        errors = aggregate_errors(None, {"static": {"result": "success"}})
        self.assertTrue(errors)
        self.assertIn("scope jobs output is missing or unparseable", errors)


if __name__ == "__main__":
    unittest.main()
