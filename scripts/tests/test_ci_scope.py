from __future__ import annotations

import pathlib
import shutil
import tempfile
import unittest

from scripts.ci_scope import aggregate_errors, select_jobs


ALWAYS = ["scope", "shellcheck", "static"]
LINUX_X86 = {
    "name": "linux-x86_64",
    "runner": "ubuntu-24.04",
    "zig_tarball": "zig-x86_64-linux",
}
LINUX_ARM = {
    "name": "linux-aarch64",
    "runner": "ubuntu-24.04-arm",
    "zig_tarball": "zig-aarch64-linux",
}
MACOS_ARM = {
    "name": "macos-aarch64",
    "runner": "macos-15",
    "zig_tarball": "zig-aarch64-macos",
}


def _shards(count: int) -> list[dict[str, object]]:
    return [
        {"index": index, "shard_count": count, "label": "{}/{}".format(index + 1, count)}
        for index in range(count)
    ]


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

    def _select(
        self,
        paths: list[str],
        *,
        event: str = "pull_request",
        draft: bool = True,
    ):
        return select_jobs(paths, event=event, draft=draft, head_root=self.root)

    def _assert_jobs(self, selection, extra: list[str]) -> None:
        self.assertEqual(sorted(ALWAYS + extra), selection.jobs)

    def _class_for(self, selection, path: str) -> str:
        return dict(selection.path_classes)[path]

    def test_docs_only_selects_static_gates(self) -> None:
        selection = self._select(["README.md", "docs/guide.md"])
        self._assert_jobs(selection, [])
        self.assertEqual("", selection.e2e_files)
        self.assertEqual([], selection.e2e_platforms)
        self.assertEqual([], selection.e2e_shards)
        self.assertEqual("STATIC", self._class_for(selection, "README.md"))
        self.assertEqual("STATIC", self._class_for(selection, "docs/guide.md"))
        self.assertEqual("always selected", selection.reasons["static"])
        self.assertEqual(
            "no changed path selects it", selection.reasons["native-linux"]
        )
        self.assertEqual(
            "no changed path selects it", selection.reasons["pgso-driver"]
        )

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
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_script_referenced_by_build_zig_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "build.zig": "exe.addCSourceFile(.{ .file = \"used.sh\" });\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_script_referenced_by_a_test_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "tests/e2e/alpha.test.ts": "spawn('used.sh');\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_script_referenced_by_a_benchmark_is_full(self) -> None:
        self._write(
            {
                "scripts/used.sh": "#!/bin/sh\n",
                "benchmarks/startup.sh": "hyperfine used.sh\n",
            }
        )
        selection = self._select(["scripts/used.sh"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/used.sh"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_script_referenced_by_python_module_stem_is_full(self) -> None:
        self._write(
            {
                "scripts/helper_mod.py": "VALUE = 1\n",
                "scripts/other.py": "from .helper_mod import VALUE\n",
            }
        )
        selection = self._select(["scripts/helper_mod.py"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/helper_mod.py"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_markdown_under_src_is_full(self) -> None:
        self._write({"src/system_prompt.md": "# prompt\n"})
        selection = self._select(["src/system_prompt.md"])
        self.assertEqual("FULL", self._class_for(selection, "src/system_prompt.md"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_root_e2e_file_only_on_a_draft_pull_request(self) -> None:
        selection = self._select(["tests/e2e/alpha.test.ts"], draft=True)
        self.assertEqual(
            "E2E_FILE(alpha.test.ts)",
            self._class_for(selection, "tests/e2e/alpha.test.ts"),
        )
        self._assert_jobs(selection, ["e2e", "pgso-driver"])
        self.assertEqual("alpha.test.ts", selection.e2e_files)
        self.assertEqual([LINUX_X86], selection.e2e_platforms)
        self.assertEqual(_shards(1), selection.e2e_shards)
        self.assertEqual(
            "no changed path selects it", selection.reasons["native-linux"]
        )
        self.assertEqual(
            "no changed path selects it", selection.reasons["bench"]
        )

    def test_root_e2e_file_only_on_a_ready_pull_request(self) -> None:
        selection = self._select(["tests/e2e/alpha.test.ts"], draft=False)
        self._assert_jobs(selection, ["e2e", "pgso-driver"])
        self.assertEqual("alpha.test.ts", selection.e2e_files)
        self.assertEqual([LINUX_ARM, MACOS_ARM], selection.e2e_platforms)
        self.assertEqual(_shards(1), selection.e2e_shards)
        self.assertEqual(
            "no changed path selects it", selection.reasons["conformance"]
        )
        self.assertEqual(
            "no changed path selects it", selection.reasons["binary-size"]
        )

    def test_tui_performance_selects_bench_when_ready(self) -> None:
        self._write({"tests/e2e/tui-performance.test.ts": "export {}\n"})
        draft = self._select(["tests/e2e/tui-performance.test.ts"], draft=True)
        self._assert_jobs(draft, ["e2e", "pgso-driver"])
        self.assertEqual(
            "ready-only job; draft pull request", draft.reasons["bench"]
        )

        ready = self._select(["tests/e2e/tui-performance.test.ts"], draft=False)
        self._assert_jobs(ready, ["bench", "e2e", "pgso-driver"])
        self.assertEqual("tui-performance.test.ts", ready.e2e_files)
        self.assertIn("tui-performance.test.ts", ready.reasons["bench"])

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
                draft = self._select([path], draft=True)
                self.assertEqual("E2E_SHARED", self._class_for(draft, path))
                self._assert_jobs(draft, ["e2e", "pgso-driver"])
                self.assertEqual("all", draft.e2e_files)
                self.assertEqual([LINUX_X86], draft.e2e_platforms)
                self.assertEqual(_shards(3), draft.e2e_shards)
                self.assertEqual(
                    "ready-only job; draft pull request",
                    draft.reasons["conformance"],
                )
                self.assertEqual(
                    "ready-only job; draft pull request",
                    draft.reasons["bench"],
                )

                ready = self._select([path], draft=False)
                self._assert_jobs(
                    ready, ["bench", "conformance", "e2e", "pgso-driver"]
                )
                self.assertEqual("all", ready.e2e_files)
                self.assertEqual([LINUX_ARM, MACOS_ARM], ready.e2e_platforms)

    def test_e2e_file_mixed_with_source_is_full(self) -> None:
        self._write({"src/main.zig": "pub fn main() void {}\n"})
        selection = self._select(
            ["tests/e2e/alpha.test.ts", "src/main.zig"], draft=True
        )
        self.assertEqual("FULL", self._class_for(selection, "src/main.zig"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])
        self.assertEqual("all", selection.e2e_files)

    def test_source_is_full(self) -> None:
        self._write({"src/main.zig": "pub fn main() void {}\n"})
        selection = self._select(["src/main.zig"], draft=False)
        self.assertEqual("FULL", self._class_for(selection, "src/main.zig"))
        self._assert_jobs(
            selection,
            [
                "bench",
                "binary-size",
                "conformance",
                "e2e",
                "native-extra",
                "pgso-driver",
            ],
        )
        self.assertEqual(
            "draft-only job; ready pull request",
            selection.reasons["native-linux"],
        )

    def test_build_zig_is_full(self) -> None:
        self._write({"build.zig": "pub fn build() void {}\n"})
        selection = self._select(["build.zig"])
        self.assertEqual("FULL", self._class_for(selection, "build.zig"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_workflow_is_full(self) -> None:
        self._write({".github/workflows/ci.yml": "name: CI\n"})
        selection = self._select([".github/workflows/ci.yml"])
        self.assertEqual("FULL", self._class_for(selection, ".github/workflows/ci.yml"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_composite_action_is_full(self) -> None:
        self._write({".github/actions/setup-pgso/action.yml": "name: setup\n"})
        selection = self._select([".github/actions/setup-pgso/action.yml"])
        self.assertEqual(
            "FULL",
            self._class_for(selection, ".github/actions/setup-pgso/action.yml"),
        )
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_unknown_path_is_full(self) -> None:
        selection = self._select(["vendor/mystery.bin"])
        self.assertEqual("FULL", self._class_for(selection, "vendor/mystery.bin"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_deleted_unreferenced_script_is_static(self) -> None:
        selection = self._select(["scripts/gone.sh"])
        self.assertEqual("STATIC", self._class_for(selection, "scripts/gone.sh"))
        self._assert_jobs(selection, [])

    def test_deleted_root_e2e_file_is_shared(self) -> None:
        selection = self._select(["tests/e2e/gone.test.ts"], draft=False)
        self.assertEqual("E2E_SHARED", self._class_for(selection, "tests/e2e/gone.test.ts"))
        self._assert_jobs(
            selection, ["bench", "conformance", "e2e", "pgso-driver"]
        )
        self.assertEqual("all", selection.e2e_files)

    def test_rename_static_to_full_selects_full(self) -> None:
        self._write({"src/moved.md": "# moved\n"})
        selection = self._select(["README.md", "src/moved.md"])
        self.assertEqual("STATIC", self._class_for(selection, "README.md"))
        self.assertEqual("FULL", self._class_for(selection, "src/moved.md"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_rename_full_to_static_selects_full(self) -> None:
        self._write({"docs/old.md": "# old\n"})
        selection = self._select(["src/old.zig", "docs/old.md"])
        self.assertEqual("FULL", self._class_for(selection, "src/old.zig"))
        self.assertEqual("STATIC", self._class_for(selection, "docs/old.md"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])

    def test_manual_dispatch_ignores_diff_and_excludes_binary_size(self) -> None:
        selection = self._select(
            ["README.md"],
            event="workflow_dispatch",
            draft=False,
        )
        self._assert_jobs(
            selection,
            [
                "bench",
                "conformance",
                "e2e",
                "native-extra",
                "native-linux",
                "pgso-driver",
            ],
        )
        self.assertNotIn("binary-size", selection.jobs)
        self.assertEqual("all", selection.e2e_files)
        self.assertEqual([LINUX_X86, LINUX_ARM, MACOS_ARM], selection.e2e_platforms)
        self.assertEqual(_shards(3), selection.e2e_shards)
        self.assertEqual(
            "manual dispatch excludes binary-size",
            selection.reasons["binary-size"],
        )

    def test_shard_count_follows_selected_file_count(self) -> None:
        one = self._select(["tests/e2e/alpha.test.ts"])
        self.assertEqual(_shards(1), one.e2e_shards)

        two = self._select(["tests/e2e/alpha.test.ts", "tests/e2e/beta.test.ts"])
        self.assertEqual("alpha.test.ts beta.test.ts", two.e2e_files)
        self.assertEqual(_shards(2), two.e2e_shards)

        full = self._select(["src/main.zig"])
        self.assertEqual("all", full.e2e_files)
        self.assertEqual(_shards(3), full.e2e_shards)

    def test_init_py_is_full(self) -> None:
        self._write({"scripts/__init__.py": ""})
        selection = self._select(["scripts/__init__.py"])
        self.assertEqual("FULL", self._class_for(selection, "scripts/__init__.py"))
        self._assert_jobs(selection, ["e2e", "native-linux", "pgso-driver"])


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
