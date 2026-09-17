#!/usr/bin/env python3
"""Measure peak RSS for the heavy benchmark workloads.

Runs each workload from scripts/pgso/qualify.py as a child process and reads
peak resident set size from getrusage(RUSAGE_CHILDREN).ru_maxrss, which is in
bytes on macOS and kilobytes on Linux, so no GNU time dependency is needed.
Each workload runs in a fresh measurer process so RUSAGE_CHILDREN holds only
that child's peak.

Usage:
  python3 benchmarks/measure_memory.py                  # build benches, measure, write results
  python3 benchmarks/measure_memory.py --skip-build     # measure with existing binaries
  python3 benchmarks/measure_memory.py --summary        # markdown table of recorded results
"""

import argparse
import json
import os
import pathlib
import platform
import resource
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_BINARY_DIR = REPO_ROOT / "zig-out" / "bin"
DEFAULT_RESULTS = REPO_ROOT / "benchmarks" / "results" / "memory.json"

# Workload argv mirrors the heavy corpus in scripts/pgso/qualify.py.
WORKLOADS = {
    "file-index-100k": ("file-index-bench", ("100000", "500")),
    "ui-activity": ("ui-activity-progress-bench", ()),
    "approval-transcript": ("approval-review-bench", ("transcript", "1", "1")),
    "approval-diff": ("approval-review-bench", ("diff", "1", "1")),
    "approval-payload": ("approval-review-bench", ("payload", "1", "1")),
    "approval-combined": ("approval-review-bench", ("combined", "1", "1")),
}


def ru_maxrss_to_bytes(value):
    if platform.system() == "Darwin":
        return value
    return value * 1024


def peak_rss_bytes(argv):
    """Run argv as a child and return its peak RSS in bytes."""
    # The caller is a fresh measurer process with no prior children, so
    # RUSAGE_CHILDREN holds exactly this child's peak.
    completed = subprocess.run(argv, stdout=subprocess.DEVNULL, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} exited with {completed.returncode}")
    return ru_maxrss_to_bytes(
        resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    )


def run_workload(workload, binary_dir):
    binary, args = WORKLOADS[workload]
    return peak_rss_bytes([str(binary_dir / binary), *args])


def measure_all(binary_dir, repeat):
    results = {}
    for workload in WORKLOADS:
        # Fresh process per workload so RUSAGE_CHILDREN peaks do not accumulate.
        peaks = []
        for _ in range(repeat):
            proc = subprocess.run(
                [sys.executable, __file__, "--measure-one", workload,
                 "--binary-dir", str(binary_dir)],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"workload {workload} failed: {proc.stderr.strip()}")
            peaks.append(int(json.loads(proc.stdout)["peak_rss_bytes"]))
        results[workload] = {"peak_rss_bytes": max(peaks), "runs": repeat}
        mib = results[workload]["peak_rss_bytes"] / 2**20
        print(f"  {workload:<20s} peak={mib:>7.2f} MiB  (runs: {repeat})", flush=True)
    return results


def build_benches():
    subprocess.run(
        ["zig", "build", "bench-file-index", "bench-ui-activity",
         "bench-approval-review", "-Doptimize=ReleaseSafe"],
        cwd=REPO_ROOT,
        check=True,
    )


def summary_markdown(results_path):
    data = json.loads(pathlib.Path(results_path).read_text())
    lines = ["| workload | peak RSS (MiB) |", "| --- | ---: |"]
    for workload in WORKLOADS:
        entry = data["workloads"][workload]
        lines.append(f"| {workload} | {entry['peak_rss_bytes'] / 2**20:.2f} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--binary-dir", default=str(DEFAULT_BINARY_DIR))
    parser.add_argument("--results", default=os.environ.get(
        "FIBER_MEMORY_RESULTS", str(DEFAULT_RESULTS)))
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--measure-one", choices=sorted(WORKLOADS))
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()

    if args.summary:
        print(summary_markdown(args.results))
        return 0

    binary_dir = pathlib.Path(args.binary_dir)
    if args.measure_one:
        print(json.dumps({
            "workload": args.measure_one,
            "peak_rss_bytes": run_workload(args.measure_one, binary_dir),
        }))
        return 0

    if not args.skip_build:
        build_benches()
    print("peak RSS per heavy workload:")
    results = measure_all(binary_dir, args.repeat)
    results_path = pathlib.Path(args.results)
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps({"workloads": results}, indent=2) + "\n")
    print(f"results written to {results_path}")
    table = summary_markdown(results_path)
    print(table)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a") as handle:
            handle.write("## Peak RSS per heavy workload\n" + table + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
