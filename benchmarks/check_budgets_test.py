#!/usr/bin/env python3

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MODULE_PATH = pathlib.Path(__file__).with_name("check_budgets.py")
SPEC = importlib.util.spec_from_file_location("check_budgets", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
check_budgets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_budgets)


class BudgetContractTests(unittest.TestCase):
    def run_checker(self, results):
        with tempfile.TemporaryDirectory() as tmp:
            result_dir = pathlib.Path(tmp)
            for index, result in enumerate(results):
                (result_dir / f"{index}.json").write_text(json.dumps({"results": [result]}))
            env = os.environ.copy()
            env["FIBER_BENCH_RESULTS_GLOB"] = str(result_dir / "*.json")
            return subprocess.run(
                [sys.executable, str(MODULE_PATH)],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

    def test_linux_keeps_two_millisecond_raw_budget(self) -> None:
        self.assertEqual(
            check_budgets.command_budget("Linux", "fiber sessions --json"),
            0.002,
        )

    def test_darwin_has_no_local_product_budget(self) -> None:
        self.assertIsNone(
            check_budgets.command_budget("Darwin", "fiber sessions --json"),
        )

    def test_budget_check_uses_raw_mean(self) -> None:
        self.assertFalse(check_budgets.within_budget(0.0021, 0.002))
        self.assertTrue(check_budgets.within_budget(0.002, 0.002))

    def test_missing_results_fail(self):
        result = self.run_checker([])
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("No benchmark result files found after excluding summary.json", result.stdout)

    def write_memory(self, directory, workloads):
        path = pathlib.Path(directory) / "memory.json"
        path.write_text(json.dumps({"workloads": workloads}))
        return path

    def memory_entry(self, mib):
        return {"peak_rss_bytes": int(mib * 2**20), "runs": 1}

    def test_linux_memory_budgets_cover_all_heavy_workloads(self) -> None:
        self.assertEqual(
            set(check_budgets.MEMORY_BUDGETS_MIB),
            {
                "file-index-100k",
                "ui-activity",
                "approval-transcript",
                "approval-diff",
                "approval-payload",
                "approval-combined",
            },
        )

    def test_darwin_has_no_memory_budget(self) -> None:
        self.assertIsNone(check_budgets.memory_budget("Darwin", "ui-activity"))
        self.assertIsNotNone(check_budgets.memory_budget("Linux", "ui-activity"))

    def test_memory_json_excluded_from_latency_glob(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory = str(pathlib.Path(tmp) / "memory.json")
            pathlib.Path(memory).write_text(json.dumps({"workloads": {}}))
            self.assertFalse(check_budgets.check_results([memory], "Linux"))

    def test_memory_passes_under_budget_on_linux(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workloads = {
                name: self.memory_entry(budget / 2)
                for name, budget in check_budgets.MEMORY_BUDGETS_MIB.items()
            }
            path = self.write_memory(tmp, workloads)
            self.assertTrue(check_budgets.check_memory_results(str(path), "Linux"))

    def test_memory_fails_on_seeded_regression(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workloads = {
                name: self.memory_entry(budget / 2)
                for name, budget in check_budgets.MEMORY_BUDGETS_MIB.items()
            }
            workloads["approval-combined"] = self.memory_entry(
                check_budgets.MEMORY_BUDGETS_MIB["approval-combined"] * 2
            )
            path = self.write_memory(tmp, workloads)
            self.assertFalse(check_budgets.check_memory_results(str(path), "Linux"))

    def test_memory_missing_file_fails_on_linux_passes_on_darwin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(pathlib.Path(tmp) / "memory.json")
            self.assertFalse(check_budgets.check_memory_results(missing, "Linux"))
            self.assertTrue(check_budgets.check_memory_results(missing, "Darwin"))

    def test_checker_fails_on_seeded_memory_regression(self):
        with tempfile.TemporaryDirectory() as tmp:
            workloads = {
                name: self.memory_entry(budget * 2)
                for name, budget in check_budgets.MEMORY_BUDGETS_MIB.items()
            }
            memory_path = self.write_memory(tmp, workloads)
            env = os.environ.copy()
            env["FIBER_BENCH_RESULTS_GLOB"] = str(pathlib.Path(tmp) / "*.json")
            env["FIBER_MEMORY_RESULTS"] = str(memory_path)
            env["FIBER_BENCH_SYSTEM"] = "Linux"
            result = subprocess.run(
                [sys.executable, str(MODULE_PATH)],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(1, result.returncode, result.stdout + result.stderr)
            self.assertIn("Memory budget exceeded", result.stdout)


if __name__ == "__main__":
    unittest.main()
