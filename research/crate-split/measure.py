#!/usr/bin/env python3
"""Measure Shape A (one crate) vs Shape B (workspace) on this machine.

Every number written to results/ comes from a command recorded in the JSON.
Re-run: python3 measure.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
ARTIFACTS = ROOT / "artifacts"
RUNS = 5
PLATFORM = None

SHAPES = {
    "A": ROOT / "shape_a",
    "B": ROOT / "shape_b",
}

TOUCH_FILES = {
    "A": {
        "leaf": ROOT / "shape_a/src/bytes_util/model_0.rs",
        "top": ROOT / "shape_a/src/policy/model_0.rs",
        "core": ROOT / "shape_a/src/core_ids/model_0.rs",
    },
    "B": {
        "leaf": ROOT / "shape_b/crates/bytes_util/src/model_0.rs",
        "top": ROOT / "shape_b/crates/policy/src/model_0.rs",
        "core": ROOT / "shape_b/crates/core_ids/src/model_0.rs",
    },
}

MARKER_RE = re.compile(r"(pub const TOUCH_MARKER: u32 = )(\d+)(;)")

# Workspace members we look for in compiler-artifact messages.
WORKSPACE_CRATES = [
    "core_ids",
    "bytes_util",
    "syntax",
    "catalog",
    "engine",
    "session",
    "policy",
    "app",
    "fiber_synth",
]


def platform_info() -> dict:
    uname = subprocess.check_output(["uname", "-smar"], text=True).strip()
    cpu = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    ncpu = subprocess.check_output(["sysctl", "-n", "hw.ncpu"], text=True).strip()
    rustc = subprocess.check_output(["rustc", "--version"], text=True).strip()
    cargo = subprocess.check_output(["cargo", "--version"], text=True).strip()
    return {
        "uname": uname,
        "cpu": cpu,
        "ncpu": int(ncpu),
        "rustc": rustc,
        "cargo": cargo,
        "label": f"macOS arm64 ({uname}); {cpu}; {ncpu} CPUs; {rustc}",
    }


def run(cmd, cwd, env, timeout=None):
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def cargo_env(target_dir: Path, incremental: bool | None = None, extra=None) -> dict:
    env = os.environ.copy()
    env.pop("RUSTC_WRAPPER", None)
    env.pop("RUSTC_WORKSPACE_WRAPPER", None)
    env.pop("SCCACHE", None)
    env.pop("SCCACHE_DIR", None)
    # Override ~/.cargo/config.toml rustc-wrapper = "sccache". sccache refuses
    # CARGO_INCREMENTAL=1, which we need for debug incremental measurements.
    wrapper = str(ROOT / "no_wrapper.sh")
    env["RUSTC_WRAPPER"] = wrapper
    env["CARGO_BUILD_RUSTC_WRAPPER"] = wrapper
    env["CARGO_TERM_COLOR"] = "never"
    if incremental is True:
        env["CARGO_INCREMENTAL"] = "1"
    elif incremental is False:
        env["CARGO_INCREMENTAL"] = "0"
    env["CARGO_TARGET_DIR"] = str(target_dir)
    if extra:
        env.update(extra)
    return env


def toggle_marker(path: Path) -> int:
    text = path.read_text()
    match = MARKER_RE.search(text)
    if not match:
        raise SystemExit(f"TOUCH_MARKER not found in {path}")
    current = int(match.group(2))
    nxt = 1 if current != 1 else 2
    path.write_text(MARKER_RE.sub(rf"\g<1>{nxt}\3", text, count=1))
    return nxt


def median_range(times: list[float]) -> dict:
    s = sorted(times)
    return {
        "times": times,
        "median": statistics.median(s),
        "min": s[0],
        "max": s[-1],
        "mean": statistics.mean(s),
        "n": len(times),
    }


def timed(cmd, cwd, env) -> tuple[float, subprocess.CompletedProcess]:
    t0 = time.perf_counter()
    proc = run(cmd, cwd, env)
    dt = time.perf_counter() - t0
    return dt, proc


def save(doc: dict) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "results.json").write_text(json.dumps(doc, indent=2) + "\n")


def count_lines() -> dict:
    def wc_rs(root: Path) -> int:
        total = 0
        files = 0
        for p in root.rglob("*.rs"):
            total += len(p.read_text().splitlines())
            files += 1
        return total

    def wc_toml(root: Path) -> tuple[int, int]:
        files = list(root.rglob("Cargo.toml"))
        lines = sum(len(p.read_text().splitlines()) for p in files)
        return len(files), lines

    a_files, a_toml_lines = wc_toml(SHAPES["A"])
    b_files, b_toml_lines = wc_toml(SHAPES["B"])
    return {
        "shape_a_rs_lines": wc_rs(SHAPES["A"]),
        "shape_b_rs_lines": wc_rs(SHAPES["B"]),
        "shape_a_cargo_toml_files": a_files,
        "shape_a_cargo_toml_lines": a_toml_lines,
        "shape_b_cargo_toml_files": b_files,
        "shape_b_cargo_toml_lines": b_toml_lines,
        "command": "python3 measure.py (pathlib rglob *.rs / Cargo.toml line counts)",
    }


def du_bytes(path: Path) -> int:
    proc = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, check=True)
    return int(proc.stdout.split()[0]) * 1024


def packages_from_json(stdout: str) -> list[str]:
    found = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-artifact":
            continue
        pkg_id = msg.get("package_id", "")
        # cargo 1.98 package_id may be a string or a path-ish string like
        # "bytes_util 0.1.0 (path+file://...)"
        name = None
        if isinstance(pkg_id, dict):
            name = pkg_id.get("name")
        else:
            name = str(pkg_id).split(" ", 1)[0]
        if name in WORKSPACE_CRATES and name not in found:
            found.append(name)
    return found


def compiling_from_stderr(stderr: str) -> list[str]:
    names = []
    for line in stderr.splitlines():
        m = re.search(r"^\s*(?:Compiling|Checking|Running tests)\s+(\S+)", line)
        if m:
            names.append(line.strip())
    return names


def repeat_clean(shape: str, profile: str, kind: str, n: int, doc: dict) -> None:
    """kind is 'build' or 'check'. profile is 'debug' or 'release'."""
    key = f"clean_{kind}_{profile}_{shape}"
    if key in doc["scenarios"]:
        print(f"skip {key} (already recorded)")
        return
    target = ARTIFACTS / f"{shape}-{kind}-{profile}"
    cwd = SHAPES[shape]
    incremental = profile == "debug"
    extra = {}
    cmd = ["cargo", kind]
    if profile == "release":
        cmd.append("--release")
    times = []
    last_err = ""
    print(f"== {key}: {n} clean runs, cmd={' '.join(cmd)}, target={target}")
    for i in range(n):
        if target.exists():
            shutil.rmtree(target)
        env = cargo_env(target, incremental=incremental, extra=extra)
        dt, proc = timed(cmd, cwd, env)
        if proc.returncode != 0:
            last_err = proc.stderr[-4000:]
            print(proc.stderr[-2000:])
            raise SystemExit(f"{key} failed on run {i+1}: {last_err}")
        times.append(dt)
        print(f"   run {i+1}/{n}: {dt:.3f}s")
    rec = median_range(times)
    rec.update(
        {
            "scenario": key,
            "shape": shape,
            "profile": profile,
            "kind": kind,
            "command": f"rm -rf {target} && CARGO_TARGET_DIR={target} CARGO_INCREMENTAL={1 if incremental else 0} {' '.join(cmd)}",
            "cwd": str(cwd),
            "platform": doc["platform"]["label"],
        }
    )
    doc["scenarios"][key] = rec
    save(doc)


def repeat_incremental(shape: str, profile: str, kind: str, which: str, n: int, doc: dict) -> None:
    key = f"incr_{which}_{kind}_{profile}_{shape}"
    if key in doc["scenarios"]:
        print(f"skip {key} (already recorded)")
        return
    target = ARTIFACTS / f"{shape}-{kind}-{profile}"
    cwd = SHAPES[shape]
    incremental = profile == "debug"
    cmd = ["cargo", kind]
    if profile == "release":
        cmd.append("--release")
    env = cargo_env(target, incremental=incremental)
    print(f"== {key}: warmup + {n} touched rebuilds")
    dt, proc = timed(cmd, cwd, env)
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        raise SystemExit(f"warmup failed for {key}")
    print(f"   warmup: {dt:.3f}s")
    times = []
    touch_path = TOUCH_FILES[shape][which]
    compiled = None
    stderr_sample = None
    for i in range(n):
        toggle_marker(touch_path)
        dt, proc = timed(cmd, cwd, env)
        if proc.returncode != 0:
            print(proc.stderr[-2000:])
            raise SystemExit(f"{key} failed on run {i+1}")
        times.append(dt)
        print(f"   run {i+1}/{n}: {dt:.3f}s")
        if i == 0:
            stderr_sample = proc.stderr
    rec = median_range(times)
    rec.update(
        {
            "scenario": key,
            "shape": shape,
            "profile": profile,
            "kind": kind,
            "touch": which,
            "touch_file": str(touch_path),
            "command": f"toggle TOUCH_MARKER in {touch_path}; CARGO_TARGET_DIR={target} CARGO_INCREMENTAL={1 if incremental else 0} {' '.join(cmd)}",
            "cwd": str(cwd),
            "platform": doc["platform"]["label"],
            "stderr_compiling": compiling_from_stderr(stderr_sample or ""),
        }
    )
    doc["scenarios"][key] = rec
    save(doc)


def one_shot_messages(shape: str, cmd: list[str], target: Path, incremental: bool, label: str, doc: dict, touch=None, warmup=False) -> None:
    key = f"messages_{label}_{shape}"
    if key in doc["scenarios"]:
        print(f"skip {key}")
        return
    cwd = SHAPES[shape]
    env = cargo_env(target, incremental=incremental)
    if warmup:
        print(f"== {key}: warmup {' '.join(cmd)}")
        dt_w, proc_w = timed(cmd, cwd, env)
        if proc_w.returncode != 0:
            print(proc_w.stderr[-2000:])
            raise SystemExit(f"warmup failed for {key}")
        print(f"   warmup: {dt_w:.3f}s")
    if touch:
        toggle_marker(TOUCH_FILES[shape][touch])
    full_cmd = cmd + ["--message-format=json"]
    print(f"== {key}: {' '.join(full_cmd)}")
    dt, proc = timed(full_cmd, cwd, env)
    pkgs = packages_from_json(proc.stdout)
    rec = {
        "scenario": key,
        "shape": shape,
        "seconds": dt,
        "returncode": proc.returncode,
        "command": f"CARGO_TARGET_DIR={target} {' '.join(full_cmd)}",
        "cwd": str(cwd),
        "platform": doc["platform"]["label"],
        "workspace_packages_with_compiler_artifact": pkgs,
        "stderr_compiling": compiling_from_stderr(proc.stderr),
        "stderr_tail": proc.stderr[-2500:],
    }
    if proc.returncode != 0:
        rec["stderr_tail"] = proc.stderr[-4000:]
        print(proc.stderr[-2000:])
    doc["scenarios"][key] = rec
    # save raw json lines for proof
    (RESULTS / f"{key}.stdout.jsonl").write_text(proc.stdout)
    (RESULTS / f"{key}.stderr.txt").write_text(proc.stderr)
    save(doc)


def repeat_test(shape: str, scoped: bool, n: int, doc: dict) -> None:
    key = f"{'scoped_test' if scoped else 'warm_test'}_{shape}"
    if key in doc["scenarios"]:
        print(f"skip {key}")
        return
    target = ARTIFACTS / f"{shape}-test-debug"
    cwd = SHAPES[shape]
    env = cargo_env(target, incremental=True)
    if scoped:
        if shape == "B":
            cmd = ["cargo", "test", "-p", "bytes_util"]
        else:
            cmd = ["cargo", "test", "--lib", "bytes_util::"]
    else:
        cmd = ["cargo", "test"]
    print(f"== {key}: warmup + {n} runs, cmd={' '.join(cmd)}")
    if not scoped:
        if target.exists():
            shutil.rmtree(target)
    dt, proc = timed(cmd, cwd, env)
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        raise SystemExit(f"warmup test failed for {key}")
    print(f"   warmup: {dt:.3f}s")
    times = []
    stderr_sample = ""
    for i in range(n):
        if scoped:
            toggle_marker(TOUCH_FILES[shape]["leaf"])
        dt, proc = timed(cmd, cwd, env)
        if proc.returncode != 0:
            print(proc.stderr[-2000:])
            raise SystemExit(f"{key} failed on run {i+1}")
        times.append(dt)
        print(f"   run {i+1}/{n}: {dt:.3f}s")
        if i == 0:
            stderr_sample = proc.stderr
    rec = median_range(times)
    rec.update(
        {
            "scenario": key,
            "shape": shape,
            "scoped": scoped,
            "command": " ".join(cmd),
            "cwd": str(cwd),
            "platform": doc["platform"]["label"],
            "note": (
                "Shape A `cargo test --lib bytes_util::` filters which tests RUN but still compiles the whole lib crate."
                if shape == "A" and scoped
                else "Shape B `cargo test -p bytes_util` builds only that crate and its deps."
                if shape == "B" and scoped
                else "Warm full `cargo test` with no source change after a successful test build."
            ),
            "stderr_compiling": compiling_from_stderr(stderr_sample),
        }
    )
    doc["scenarios"][key] = rec
    save(doc)


def run_timings(shape: str, profile: str, doc: dict) -> None:
    key = f"timings_{profile}_{shape}"
    if key in doc["scenarios"]:
        print(f"skip {key}")
        return
    target = ARTIFACTS / f"{shape}-timings-{profile}"
    if target.exists():
        shutil.rmtree(target)
    cwd = SHAPES[shape]
    incremental = profile == "debug"
    cmd = ["cargo", "build", "--timings"]
    if profile == "release":
        cmd.append("--release")
    env = cargo_env(target, incremental=incremental)
    print(f"== {key}: {' '.join(cmd)}")
    dt, proc = timed(cmd, cwd, env)
    if proc.returncode != 0:
        print(proc.stderr[-2000:])
        raise SystemExit(f"timings failed for {key}")
    timing_dir = target / "cargo-timings"
    dest = RESULTS / f"timings-{shape}-{profile}"
    if dest.exists():
        shutil.rmtree(dest)
    if timing_dir.exists():
        shutil.copytree(timing_dir, dest)
    rec = {
        "scenario": key,
        "shape": shape,
        "profile": profile,
        "seconds": dt,
        "command": f"rm -rf {target} && CARGO_TARGET_DIR={target} {' '.join(cmd)}",
        "cwd": str(cwd),
        "platform": doc["platform"]["label"],
        "copied_to": str(dest),
        "files": sorted(p.name for p in dest.glob("*")) if dest.exists() else [],
    }
    rec.update(parse_timings(dest))
    doc["scenarios"][key] = rec
    save(doc)


def parse_timings(dest: Path) -> dict:
    """Parse cargo-timing.html UNIT_DATA (cargo 1.98 writes HTML, not JSON)."""
    html_files = [p for p in dest.glob("cargo-timing.html")]
    if not html_files:
        return {"units": [], "peak_concurrent_units": None, "max_overlap_names": []}
    text = html_files[0].read_text()
    summary = {}
    for key, pat in (
        ("total_units", r"<td>Total units:</td><td>(\d+)</td>"),
        ("max_concurrency_html", r"<td>Max concurrency:</td><td>([^<]+)</td>"),
        ("total_time_html", r"<td>Total time:</td><td>([^<]+)</td>"),
    ):
        m = re.search(pat, text)
        if m:
            summary[key] = m.group(1)
    m = re.search(r"const UNIT_DATA = (\[.*?\n\]);", text, re.S)
    if not m:
        summary["units"] = []
        return summary
    raw = json.loads(m.group(1))
    ours_names = {
        "core_ids",
        "bytes_util",
        "syntax",
        "catalog",
        "engine",
        "session",
        "policy",
        "app",
        "fiber_synth",
    }
    units = []
    for u in raw:
        sections = []
        for sec in u.get("sections") or []:
            if isinstance(sec, list) and len(sec) == 2 and isinstance(sec[1], dict):
                sections.append(
                    {
                        "name": sec[0],
                        "start": sec[1].get("start"),
                        "end": sec[1].get("end"),
                    }
                )
        units.append(
            {
                "name": u.get("name"),
                "target": u.get("target"),
                "start": u.get("start"),
                "duration": u.get("duration"),
                "end": (u.get("start") or 0) + (u.get("duration") or 0),
                "sections": sections,
            }
        )
    ours = [u for u in units if u["name"] in ours_names]

    def peak(group):
        events = []
        for u in group:
            events.append((u["start"], 1, f"{u['name']}{u.get('target') or ''}"))
            events.append((u["end"], -1, f"{u['name']}{u.get('target') or ''}"))
        events.sort(key=lambda e: (e[0], e[1]))
        cur = 0
        peak_n = 0
        active = []
        peak_active = []
        for _, delta, name in events:
            if delta == 1:
                active.append(name)
                cur += 1
                if cur > peak_n:
                    peak_n = cur
                    peak_active = list(active)
            else:
                cur -= 1
                if name in active:
                    active.remove(name)
        return peak_n, peak_active

    peak_all, names_all = peak(units)
    peak_ours, names_ours = peak(ours)
    summary.update(
        {
            "units": units,
            "our_crates": ours,
            "peak_concurrent_units": peak_all,
            "max_overlap_names": names_all,
            "peak_concurrent_our_crates": peak_ours,
            "our_overlap_names": names_ours,
            "command": f"parsed UNIT_DATA from {html_files[0]}",
        }
    )
    return summary


def codegen_units_experiment(doc: dict) -> None:
    """Show that a single crate's backend parallelizes via codegen-units, on Shape A debug."""
    key = "cgu_experiment_A"
    if key in doc["scenarios"]:
        print(f"skip {key}")
        return
    cwd = SHAPES["A"]
    rec = {"scenario": key, "shape": "A", "profile": "debug", "platform": doc["platform"]["label"], "variants": {}}
    for cgu in (1, 16, 256):
        target = ARTIFACTS / f"A-cgu-{cgu}"
        if target.exists():
            shutil.rmtree(target)
        env = cargo_env(target, incremental=False, extra={"CARGO_PROFILE_DEV_CODEGEN_UNITS": str(cgu)})
        cmd = ["cargo", "build"]
        print(f"== CGU={cgu} clean cargo build (Shape A, incremental off)")
        dt, proc = timed(cmd, cwd, env)
        if proc.returncode != 0:
            print(proc.stderr[-2000:])
            raise SystemExit(f"cgu {cgu} failed")
        print(f"   {dt:.3f}s")
        rec["variants"][str(cgu)] = {
            "seconds": dt,
            "command": f"rm -rf {target} && CARGO_PROFILE_DEV_CODEGEN_UNITS={cgu} CARGO_INCREMENTAL=0 CARGO_TARGET_DIR={target} cargo build",
        }
    doc["scenarios"][key] = rec
    save(doc)


def target_sizes(doc: dict) -> None:
    key = "target_sizes"
    if key in doc["scenarios"]:
        print(f"skip {key}")
        return
    sizes = {}
    for shape in ("A", "B"):
        for kind, profile in (("build", "debug"), ("build", "release")):
            path = ARTIFACTS / f"{shape}-{kind}-{profile}"
            if path.exists():
                sizes[f"{shape}-{kind}-{profile}"] = {
                    "path": str(path),
                    "bytes": du_bytes(path),
                    "human": subprocess.check_output(["du", "-sh", str(path)], text=True).split()[0],
                    "command": f"du -sk {path}",
                }
    doc["scenarios"][key] = sizes
    save(doc)


def rustc_parallel_help(doc: dict) -> None:
    key = "rustc_help"
    if key in doc["scenarios"]:
        return
    z = run(["rustc", "-Z", "help"], cwd=ROOT, env=os.environ.copy())
    c = run(["rustc", "-C", "help"], cwd=ROOT, env=os.environ.copy())
    doc["scenarios"][key] = {
        "z_help_returncode": z.returncode,
        "z_help_has_threads": "threads" in (z.stdout + z.stderr),
        "codegen_units_in_C_help": "codegen-units" in (c.stdout + c.stderr),
        "C_help_excerpt": "\n".join(
            line for line in (c.stdout + c.stderr).splitlines() if "codegen-units" in line or "incremental" in line
        ),
        "command": "rustc -Z help; rustc -C help",
    }
    save(doc)


def fetch_deps(doc: dict) -> None:
    for shape, cwd in SHAPES.items():
        print(f"== cargo fetch {shape}")
        proc = run(["cargo", "fetch"], cwd=cwd, env=os.environ.copy())
        if proc.returncode != 0:
            print(proc.stderr)
            raise SystemExit("cargo fetch failed")


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    if (RESULTS / "results.json").exists():
        doc = json.loads((RESULTS / "results.json").read_text())
        print("resuming from results/results.json")
    else:
        doc = {"platform": platform_info(), "scenarios": {}, "lines": count_lines()}
        save(doc)
        print(doc["platform"]["label"])
        print(doc["lines"])

    fetch_deps(doc)
    rustc_parallel_help(doc)

    # 1. Clean full build debug + release
    for shape in ("A", "B"):
        for profile in ("debug", "release"):
            repeat_clean(shape, profile, "build", RUNS, doc)

    # 2-3. Incremental rebuilds after leaf / top / core touch
    for shape in ("A", "B"):
        for profile in ("debug", "release"):
            for which in ("leaf", "top", "core"):
                repeat_incremental(shape, profile, "build", which, RUNS, doc)

    # 6. cargo check equivalents
    for shape in ("A", "B"):
        for profile in ("debug", "release"):
            repeat_clean(shape, profile, "check", RUNS, doc)
            for which in ("leaf", "top"):
                repeat_incremental(shape, profile, "check", which, RUNS, doc)

    # 4. warm cargo test
    for shape in ("A", "B"):
        repeat_test(shape, scoped=False, n=RUNS, doc=doc)

    # 5. scoped test after touching leaf
    for shape in ("A", "B"):
        repeat_test(shape, scoped=True, n=RUNS, doc=doc)

    # Proof: which packages actually compiled
    # Warm Shape B test target already exists; touch leaf and cargo test -p bytes_util
    one_shot_messages(
        "B",
        ["cargo", "test", "-p", "bytes_util"],
        ARTIFACTS / "B-test-debug",
        True,
        "scoped_test_leaf",
        doc,
        touch="leaf",
    )
    one_shot_messages(
        "A",
        ["cargo", "test", "--lib", "bytes_util::"],
        ARTIFACTS / "A-test-debug",
        True,
        "scoped_test_leaf",
        doc,
        touch="leaf",
    )
    one_shot_messages(
        "B",
        ["cargo", "build"],
        ARTIFACTS / "B-build-debug",
        True,
        "incr_core_build",
        doc,
        touch="core",
    )
    one_shot_messages(
        "B",
        ["cargo", "build"],
        ARTIFACTS / "B-build-debug",
        True,
        "incr_leaf_build",
        doc,
        touch="leaf",
    )
    one_shot_messages(
        "B",
        ["cargo", "build"],
        ARTIFACTS / "B-build-debug",
        True,
        "incr_top_build",
        doc,
        touch="top",
    )
    one_shot_messages(
        "B",
        ["cargo", "build"],
        ARTIFACTS / "B-build-debug",
        True,
        "incr_core_build_isolated",
        doc,
        touch="core",
        warmup=True,
    )

    # 7. timings
    for shape in ("A", "B"):
        for profile in ("debug", "release"):
            run_timings(shape, profile, doc)

    codegen_units_experiment(doc)
    target_sizes(doc)

    print("done. results in", RESULTS / "results.json")


if __name__ == "__main__":
    main()
