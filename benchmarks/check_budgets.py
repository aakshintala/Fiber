#!/usr/bin/env python3
"""Enforce raw per-command wall-clock latency budgets against hyperfine results."""

import json
import glob
import os
import platform
import sys

LINUX_BUDGETS = {
    "fiber (startup)": 0.002,
    "fiber help": 0.002,
    "fiber status --json": 0.002,
    "fiber doctor --json": 0.002,
    "fiber sessions --json": 0.002,
}
DEFAULT_LINUX_BUDGET = 0.002

# Peak RSS budgets in MiB per heavy workload. Each is at least 2x the peak
# measured on macOS arm64 ReleaseSafe (see benchmarks/README.md), leaving
# headroom for Linux runner variance.
MEMORY_BUDGETS_MIB = {
    "file-index-100k": 40.0,
    "ui-activity": 8.0,
    "approval-transcript": 32.0,
    "approval-diff": 12.0,
    "approval-payload": 24.0,
    "approval-combined": 40.0,
}


def memory_budget(system_name, workload):
    if system_name != "Linux":
        return None
    return MEMORY_BUDGETS_MIB.get(workload)


def command_budget(system_name, command):
    if system_name != "Linux":
        return None
    return LINUX_BUDGETS.get(command, DEFAULT_LINUX_BUDGET)


def within_budget(mean, budget):
    return mean <= budget


def check_results(result_files, system_name):
    filtered_files = [
        result_file
        for result_file in result_files
        if os.path.basename(result_file) not in ("summary.json", "memory.json")
    ]
    if not filtered_files:
        print("No benchmark result files found after excluding summary.json")
        return False

    failed = False
    for result_file in filtered_files:
        with open(result_file) as file:
            data = json.load(file)
        result = data["results"][0]
        name = result["command"]
        if name == "process baseline":
            print(
                f"  BASE  {name:<25} median={result['median'] * 1000:>5.1f}ms  "
                f"min={result['min'] * 1000:>5.1f}ms  mean={result['mean'] * 1000:>5.1f}ms"
            )
            continue
        mean = result["mean"]
        median = result["median"]
        budget = command_budget(system_name, name)
        ms = mean * 1000
        min_ms = result["min"] * 1000
        median_ms = median * 1000
        if budget is None:
            print(
                f"  INFO  {name:<25} mean={ms:>5.1f}ms  median={median_ms:>5.1f}ms  "
                f"min={min_ms:>5.1f}ms  (Linux budget: 2ms)"
            )
            continue
        limit_ms = budget * 1000
        ok = within_budget(mean, budget)
        tag = "PASS" if ok else "FAIL"
        print(
            f"  {tag}  {name:<25} mean={ms:>5.1f}ms  median={median_ms:>5.1f}ms  "
            f"min={min_ms:>5.1f}ms  (limit: {limit_ms:.0f}ms)"
        )
        if not ok:
            failed = True
    return not failed


def check_memory_results(memory_path, system_name):
    if not os.path.isfile(memory_path):
        if system_name != "Linux":
            print(f"  INFO  no memory results at {memory_path} (Linux-only gate)")
            return True
        print(f"No memory results found at {memory_path}")
        return False
    with open(memory_path) as file:
        data = json.load(file)
    workloads = data.get("workloads", {})
    failed = False
    for name in sorted(set(workloads) | set(MEMORY_BUDGETS_MIB)):
        budget = memory_budget(system_name, name)
        entry = workloads.get(name)
        if entry is None:
            print(f"  FAIL  {name:<20s} missing from memory results")
            failed = True
            continue
        mib = entry["peak_rss_bytes"] / 2**20
        if budget is None:
            if name not in MEMORY_BUDGETS_MIB:
                print(f"  INFO  {name:<20s} peak={mib:>7.2f} MiB  (no budget defined)")
                continue
            print(
                f"  INFO  {name:<20s} peak={mib:>7.2f} MiB  "
                f"(Linux budget: {MEMORY_BUDGETS_MIB[name]:.0f} MiB)"
            )
            continue
        if name not in MEMORY_BUDGETS_MIB:
            print(f"  FAIL  {name:<20s} peak={mib:>7.2f} MiB  (no budget defined)")
            failed = True
            continue
        ok = mib <= budget
        tag = "PASS" if ok else "FAIL"
        print(
            f"  {tag}  {name:<20s} peak={mib:>7.2f} MiB  "
            f"(limit: {budget:.0f} MiB)"
        )
        if not ok:
            failed = True
    return not failed


def main():
    system_name = os.environ.get("FIBER_BENCH_SYSTEM", platform.system())
    result_files = sorted(
        glob.glob(
            os.environ.get(
                "FIBER_BENCH_RESULTS_GLOB",
                "benchmarks/results/*.json",
            )
        )
    )
    latency_ok = check_results(result_files, system_name)
    memory_path = os.environ.get(
        "FIBER_MEMORY_RESULTS", "benchmarks/results/memory.json"
    )
    memory_ok = check_memory_results(memory_path, system_name)
    if latency_ok and memory_ok:
        if system_name != "Linux":
            print(
                f"\nLinux 2ms budget not evaluated on {system_name}; "
                "raw local means are informational"
            )
            return 0
        print("\nAll commands within budget")
        return 0
    if not latency_ok:
        print("\nLatency budget exceeded")
    if not memory_ok:
        print("\nMemory budget exceeded")
    return 1


if __name__ == "__main__":
    sys.exit(main())
