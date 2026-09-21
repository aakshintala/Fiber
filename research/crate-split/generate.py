#!/usr/bin/env python3
"""Generate two equivalent synthetic Rust codebases: one crate vs workspace.

Shape A (shape_a/): one package, eight logical modules as `mod`.
Shape B (shape_b/): cargo workspace, one crate per module plus a binary crate.

Module graph (realistic layered agent-shaped layout):

    core_ids     (leaf)  used by almost every crate
    bytes_util   (leaf)  fewest dependents

    syntax       (mid)   core_ids + bytes_util
    catalog      (mid)   core_ids
    engine       (mid)   core_ids + syntax

    session      (top)   engine + catalog
    policy       (top)   catalog + syntax

    app          (bin)   session + policy

Internal module bodies are identical across shapes. Import paths differ:
Shape A uses `crate::<mod>`, Shape B uses the extern crate name.
"""

from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Scale: 7 library modules * ITEMS * ~90 lines, plus bridges and tests.
# 28 items lands in the 30k–40k line band without being trivial to compile.
ITEMS = 28
FILES = 4  # model_0.rs .. model_3.rs, items split across them

MODULES = [
    {"name": "core_ids", "layer": "leaf", "deps": []},
    {"name": "bytes_util", "layer": "leaf", "deps": []},
    {"name": "syntax", "layer": "mid", "deps": ["core_ids", "bytes_util"]},
    {"name": "catalog", "layer": "mid", "deps": ["core_ids"]},
    {"name": "engine", "layer": "mid", "deps": ["core_ids", "syntax"]},
    {"name": "session", "layer": "top", "deps": ["engine", "catalog"]},
    {"name": "policy", "layer": "top", "deps": ["catalog", "syntax"]},
]

BIN = "app"


def qual(shape: str, dep: str) -> str:
    return f"crate::{dep}" if shape == "a" else dep


def crate_toml(name: str, deps: list[str], binary: bool = False) -> str:
    lines = [
        "[package]",
        f'name = "{name}"',
        'version = "0.1.0"',
        'edition = "2021"',
        'publish = false',
        "",
        "[dependencies]",
        'serde = { workspace = true }',
        'serde_json = { workspace = true }',
        'thiserror = { workspace = true }',
    ]
    for dep in deps:
        lines.append(f"{dep} = {{ workspace = true }}")
    if binary:
        lines += [
            "",
            "[[bin]]",
            f'name = "{name}"',
            'path = "src/main.rs"',
        ]
    lines.append("")
    return "\n".join(lines)


def shape_a_root_toml() -> str:
    return textwrap.dedent(
        """\
        [package]
        name = "fiber_synth"
        version = "0.1.0"
        edition = "2021"
        publish = false

        [lib]
        doctest = false

        [dependencies]
        serde = { version = "=1.0.229", features = ["derive"] }
        serde_json = "=1.0.151"
        thiserror = "=2.0.20"
        """
    )


def shape_b_workspace_toml() -> str:
    members = ",\n".join(f'    "crates/{m["name"]}"' for m in MODULES)
    dep_pins = "\n".join(f'{m["name"]} = {{ path = "crates/{m["name"]}" }}' for m in MODULES)
    return f"""[workspace]
resolver = "2"
members = [
{members},
    "crates/{BIN}",
]

[workspace.dependencies]
serde = {{ version = "=1.0.229", features = ["derive"] }}
serde_json = "=1.0.151"
thiserror = "=2.0.20"
{dep_pins}
{BIN} = {{ path = "crates/{BIN}" }}
"""


def shape_b_crate_toml(name: str, deps: list[str], binary: bool = False) -> str:
    lines = [
        "[package]",
        f'name = "{name}"',
        'version = "0.1.0"',
        'edition = "2021"',
        "publish = false",
        "",
    ]
    if not binary:
        lines += ["[lib]", "doctest = false", ""]
    lines += [
        "[dependencies]",
        'serde = { workspace = true }',
        "serde_json = { workspace = true }",
        "thiserror = { workspace = true }",
    ]
    for dep in deps:
        lines.append(f"{dep} = {{ workspace = true }}")
    lines.append("")
    return "\n".join(lines)


def header_rs(mod: str, deps: list[str], shape: str) -> str:
    uses = "\n".join(f"use {qual(shape, d)};" for d in deps)
    extra = (uses + "\n") if uses else ""
    return f"""//! Synthetic `{mod}` module for the crate-split compile-scope benchmark.
#![allow(dead_code, unused_imports, unused_variables)]
#![allow(clippy::all)]

use serde::{{Deserialize, Serialize}};
{extra}
pub const TOUCH_MARKER: u32 = 1;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum Error {{
    #[error("invalid record {{0}}")]
    Invalid(String),
    #[error("missing id {{0}}")]
    Missing(u64),
    #[error("checksum mismatch {{expected}} != {{actual}}")]
    Checksum {{ expected: u64, actual: u64 }},
}}

pub trait Foldable {{
    fn fold_key(&self) -> u64;
    fn fold_label(&self) -> &str;
}}

pub fn combine_keys<T: Foldable>(items: &[T]) -> u64 {{
    items
        .iter()
        .map(|item| item.fold_key())
        .filter(|key| *key & 1 == 0)
        .fold(0u64, u64::wrapping_add)
}}

"""


def item_block(mod: str, i: int, deps: list[str], shape: str) -> str:
    """One non-trivial type cluster: struct, enum, impls, generics, iterators, tests."""
    bridge = ""
    if deps:
        src_dep = deps[0]
        q = qual(shape, src_dep)
        extra_checksum = ""
        if "bytes_util" in deps:
            bq = qual(shape, "bytes_util")
            extra_checksum = f"checksum: {bq}::checksum_{i:03d}(src.name.as_bytes()),"
        else:
            extra_checksum = "checksum: src.checksum,"
        bridge = f"""
pub fn from_dep_{i:03d}(src: &{q}::Item{i:03d}) -> Item{i:03d} {{
    Item{i:03d} {{
        id: src.id,
        name: src.name.clone(),
        tags: src.tags.clone(),
        flags: src.flags ^ {i},
        weight: src.weight.saturating_add({i}),
        path: src.path.clone(),
        parent: src.parent,
        {extra_checksum}
        meta_a: src.meta_a,
        meta_b: src.meta_b.saturating_add(1),
        extra: src.extra.clone(),
        note: src.note.clone(),
    }}
}}

pub fn lift_dep_{i:03d}(src: &{q}::Item{i:03d}) -> u64 {{
    {q}::combine_keys(std::slice::from_ref(src)) ^ fold_item_{i:03d}(&[from_dep_{i:03d}(src)])
}}
"""

    bytes_helpers = ""
    if mod == "bytes_util":
        bytes_helpers = f"""
pub fn checksum_{i:03d}(bytes: &[u8]) -> u64 {{
    bytes
        .iter()
        .copied()
        .enumerate()
        .map(|(idx, b)| (b as u64).wrapping_mul(idx as u64 + {i} + 1))
        .fold(0x9e37_79b9_7f4a_7c15, u64::wrapping_add)
}}

pub fn window_{i:03d}(bytes: &[u8]) -> Vec<u8> {{
    bytes
        .windows({(i % 5) + 2})
        .map(|w| w.iter().copied().fold(0u8, u8::wrapping_add))
        .take(32)
        .collect()
}}
"""

    return f"""
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Item{i:03d} {{
    pub id: u64,
    pub name: String,
    pub tags: Vec<String>,
    pub flags: u32,
    pub weight: i64,
    pub path: String,
    pub parent: Option<u64>,
    pub checksum: u64,
    pub meta_a: i32,
    pub meta_b: i32,
    pub extra: Vec<u8>,
    pub note: Option<String>,
}}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Kind{i:03d} {{
    Alpha {{ n: u32, label: String }},
    Beta {{ n: u32, label: String, flag: bool }},
    Gamma(u64),
    Delta,
    Epsilon {{ items: Vec<String> }},
    Zeta {{ left: i32, right: i32 }},
}}

impl Item{i:03d} {{
    pub fn new(id: u64, name: impl Into<String>) -> Self {{
        let name = name.into();
        let checksum = name
            .as_bytes()
            .iter()
            .copied()
            .fold(id, |acc, b| acc.wrapping_mul(16777619) ^ (b as u64));
        Self {{
            id,
            name,
            tags: Vec::new(),
            flags: (id as u32) & 0xffff,
            weight: id as i64,
            path: format!("/{mod}/{{id}}"),
            parent: None,
            checksum,
            meta_a: {i},
            meta_b: -{i},
            extra: Vec::new(),
            note: None,
        }}
    }}

    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {{
        self.tags.push(tag.into());
        self
    }}

    pub fn score(&self) -> i64 {{
        let tag_part: i64 = self.tags.iter().map(|t| t.len() as i64).sum();
        self.weight
            .wrapping_add(tag_part)
            .wrapping_add(self.flags as i64)
            .wrapping_add(self.meta_a as i64)
            .wrapping_sub(self.meta_b as i64)
    }}

    pub fn kind(&self) -> Kind{i:03d} {{
        match self.flags % 6 {{
            0 => Kind{i:03d}::Alpha {{ n: self.flags, label: self.name.clone() }},
            1 => Kind{i:03d}::Beta {{
                n: self.flags,
                label: self.name.clone(),
                flag: self.parent.is_some(),
            }},
            2 => Kind{i:03d}::Gamma(self.checksum),
            3 => Kind{i:03d}::Delta,
            4 => Kind{i:03d}::Epsilon {{ items: self.tags.clone() }},
            _ => Kind{i:03d}::Zeta {{
                left: self.meta_a,
                right: self.meta_b,
            }},
        }}
    }}

    pub fn kind_weight(&self) -> u64 {{
        match self.kind() {{
            Kind{i:03d}::Alpha {{ n, label }} => n as u64 + label.len() as u64,
            Kind{i:03d}::Beta {{ n, label, flag }} => n as u64 + label.len() as u64 + flag as u64,
            Kind{i:03d}::Gamma(v) => v,
            Kind{i:03d}::Delta => 1,
            Kind{i:03d}::Epsilon {{ items }} => items.iter().map(|s| s.len() as u64).sum(),
            Kind{i:03d}::Zeta {{ left, right }} => (left as u64).wrapping_add(right as u64),
        }}
    }}
}}

impl Foldable for Item{i:03d} {{
    fn fold_key(&self) -> u64 {{
        self.id ^ self.checksum ^ (self.score() as u64)
    }}
    fn fold_label(&self) -> &str {{
        &self.name
    }}
}}

pub fn fold_item_{i:03d}(items: &[Item{i:03d}]) -> u64 {{
    items
        .iter()
        .filter(|item| item.flags & 1 == 0)
        .map(|item| item.score())
        .filter(|&score| score > 0)
        .map(|score| score as u64)
        .fold(0u64, u64::wrapping_add)
}}

pub fn transform_item_{i:03d}<F>(items: &[Item{i:03d}], mut mapper: F) -> Vec<String>
where
    F: FnMut(&Item{i:03d}) -> Option<String>,
{{
    items
        .iter()
        .filter(|item| !item.name.is_empty())
        .filter_map(|item| mapper(item))
        .collect()
}}

pub fn rank_item_{i:03d}(items: &[Item{i:03d}]) -> Vec<u64> {{
    let mut ranked: Vec<(u64, u64)> = items
        .iter()
        .map(|item| (item.fold_key(), item.kind_weight()))
        .collect();
    ranked.sort_by_key(|(k, w)| (std::cmp::Reverse(*w), *k));
    ranked.into_iter().map(|(k, _)| k).collect()
}}

pub fn summarize_item_{i:03d}(items: &[Item{i:03d}]) -> Result<u64, Error> {{
    if items.is_empty() {{
        return Err(Error::Invalid(stringify!(Item{i:03d}).to_string()));
    }}
    let total = items
        .iter()
        .map(Item{i:03d}::kind_weight)
        .zip(items.iter().map(Item{i:03d}::score))
        .map(|(w, s)| w.wrapping_add(s as u64))
        .sum();
    Ok(total)
}}
{bytes_helpers}{bridge}
#[cfg(test)]
mod item_{i:03d}_tests {{
    use super::*;

    #[test]
    fn serde_roundtrip() {{
        let item = Item{i:03d}::new({i} + 7, "alpha")
            .with_tag("t1")
            .with_tag("t2");
        let json = serde_json::to_string(&item).unwrap();
        let back: Item{i:03d} = serde_json::from_str(&json).unwrap();
        assert_eq!(item, back);
        assert!(back.score() > 0 || back.flags > 0 || back.id == {i} + 7);
    }}

    #[test]
    fn fold_and_rank() {{
        let items: Vec<_> = (0..8)
            .map(|n| Item{i:03d}::new(n, format!("n{{n}}")).with_tag("k"))
            .collect();
        let folded = fold_item_{i:03d}(&items);
        let ranked = rank_item_{i:03d}(&items);
        assert_eq!(ranked.len(), items.len());
        assert_eq!(summarize_item_{i:03d}(&items).unwrap() > 0, true);
        let _ = transform_item_{i:03d}(&items, |item| Some(item.name.clone()));
        assert!(folded == folded);
    }}
}}
"""


def file_mod_rs(mod: str, file_idx: int, indices: list[int], deps: list[str], shape: str) -> str:
    body = header_rs(mod, deps, shape) if file_idx == 0 else (
        f"use serde::{{Deserialize, Serialize}};\n"
        + (f"use super::{{Error, Foldable}};\n" if True else "")
        + "".join(f"use {qual(shape, d)};\n" for d in deps)
        + "\n"
    )
    # file 0 has Error/Foldable; other files use super::
    if file_idx != 0:
        body = (
            "#![allow(dead_code, unused_imports, unused_variables)]\n"
            "use serde::{Deserialize, Serialize};\n"
            "use super::{Error, Foldable, combine_keys};\n"
            + "".join(f"use {qual(shape, d)};\n" for d in deps)
            + "\n"
        )
    for i in indices:
        body += item_block(mod, i, deps, shape)
    return body


def split_indices() -> list[list[int]]:
    chunks: list[list[int]] = [[] for _ in range(FILES)]
    for i in range(ITEMS):
        chunks[i % FILES].append(i)
    return chunks


def lib_rs(mod: str, deps: list[str], shape: str) -> str:
    mod_decls = "\n".join(f"mod model_{n};" for n in range(FILES))
    reexports = "\n".join(f"pub use model_{n}::*;" for n in range(FILES))
    q_deps = ", ".join(qual(shape, d) for d in deps) if deps else ""
    dep_exercise = ""
    if deps:
        calls = []
        for d in deps:
            q = qual(shape, d)
            calls.append(f"    acc ^= {q}::TOUCH_MARKER as u64;")
            calls.append(f"    acc ^= {q}::compile_anchor();")
        dep_exercise = "\n".join(calls)

    anchor_lines = [
        "pub fn compile_anchor() -> u64 {",
        "    let mut acc = TOUCH_MARKER as u64;",
    ]
    for i in range(ITEMS):
        anchor_lines.append(f'    let item_{i:03d} = Item{i:03d}::new({i}, "n{i}");')
        anchor_lines.append(
            f"    acc ^= fold_item_{i:03d}(std::slice::from_ref(&item_{i:03d}));"
        )
        anchor_lines.append(
            f"    acc ^= rank_item_{i:03d}(std::slice::from_ref(&item_{i:03d})).first().copied().unwrap_or(0);"
        )
        anchor_lines.append(
            f"    acc ^= transform_item_{i:03d}(std::slice::from_ref(&item_{i:03d}), |it| Some(it.name.clone())).len() as u64;"
        )
        if deps:
            q = qual(shape, deps[0])
            anchor_lines.append(f'    let dep_{i:03d} = {q}::Item{i:03d}::new({i}, "d{i}");')
            anchor_lines.append(f"    acc ^= lift_dep_{i:03d}(&dep_{i:03d});")
    anchor_lines.append("    acc")
    anchor_lines.append("}")
    anchor = "\n".join(anchor_lines)

    mut = "mut " if deps else ""
    return f"""//! {mod}: {('depends on ' + q_deps) if deps else 'leaf module (no internal deps)'}.
#![allow(dead_code, unused_imports, unused_variables, unused_mut)]

{mod_decls}

{reexports}

pub use model_0::{{Error, Foldable, TOUCH_MARKER, combine_keys}};

{anchor}

pub fn module_fingerprint() -> u64 {{
    let {mut}acc = compile_anchor();
{dep_exercise}
    acc
}}

#[cfg(test)]
mod fingerprint_tests {{
    use super::*;

    #[test]
    fn fingerprint_is_stable() {{
        let a = module_fingerprint();
        let b = module_fingerprint();
        assert_eq!(a, b);
    }}
}}
"""


def rustfmt_skip_main(shape: str) -> str:
    if shape == "a":
        session = "crate::session"
        policy = "crate::policy"
        engine = "crate::engine"
        catalog = "crate::catalog"
        syntax = "crate::syntax"
        core_ids = "crate::core_ids"
        bytes_util = "crate::bytes_util"
        pkg_note = "single-crate binary"
    else:
        session = "session"
        policy = "policy"
        engine = "engine"
        catalog = "catalog"
        syntax = "syntax"
        core_ids = "core_ids"
        bytes_util = "bytes_util"
        pkg_note = "workspace binary crate"

    return f"""//! Thin binary on top of the layered modules ({pkg_note}).
fn main() {{
    let n = run();
    println!("fiber_synth {{n}}");
}}

pub fn run() -> u64 {{
    let mut acc = 0u64;
    acc ^= {session}::module_fingerprint();
    acc ^= {policy}::module_fingerprint();
    acc ^= {engine}::module_fingerprint();
    acc ^= {catalog}::module_fingerprint();
    acc ^= {syntax}::module_fingerprint();
    acc ^= {core_ids}::module_fingerprint();
    acc ^= {bytes_util}::module_fingerprint();
    acc ^= {session}::TOUCH_MARKER as u64;
    acc ^= {policy}::TOUCH_MARKER as u64;
    acc
}}
"""


def shape_a_lib_rs() -> str:
    mods = "\n".join(f"pub mod {m['name']};" for m in MODULES)
    return f"""//! Fiber synth monolith: eight logical modules in one crate.
#![allow(dead_code, unused_imports)]

{mods}

pub fn run_app() -> u64 {{
    let mut acc = 0u64;
    acc ^= session::module_fingerprint();
    acc ^= policy::module_fingerprint();
    acc
}}

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn app_fingerprint_nonzero_or_zero_is_deterministic() {{
        assert_eq!(run_app(), run_app());
    }}
}}
"""


def write_module(dir_path: Path, mod: dict, shape: str) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)
    name = mod["name"]
    deps = mod["deps"]
    chunks = split_indices()
    for file_idx, indices in enumerate(chunks):
        (dir_path / f"model_{file_idx}.rs").write_text(
            file_mod_rs(name, file_idx, indices, deps, shape)
        )
    if shape == "a":
        (dir_path / "mod.rs").write_text(lib_rs(name, deps, shape))
    else:
        (dir_path / "lib.rs").write_text(lib_rs(name, deps, shape))


def generate_shape_a(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    src = root / "src"
    src.mkdir(parents=True)
    (root / "Cargo.toml").write_text(shape_a_root_toml())
    (src / "lib.rs").write_text(shape_a_lib_rs())
    (src / "main.rs").write_text(
        """//! Thin binary on top of the layered modules (single-crate binary).
fn main() {
    let n = run();
    println!("fiber_synth {n}");
}

fn run() -> u64 {
    fiber_synth::run_app()
        ^ fiber_synth::session::module_fingerprint()
        ^ fiber_synth::policy::module_fingerprint()
        ^ fiber_synth::engine::module_fingerprint()
        ^ fiber_synth::catalog::module_fingerprint()
        ^ fiber_synth::syntax::module_fingerprint()
        ^ fiber_synth::core_ids::module_fingerprint()
        ^ fiber_synth::bytes_util::module_fingerprint()
}
"""
    )
    for mod in MODULES:
        write_module(src / mod["name"], mod, "a")


def generate_shape_b(root: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    (root / "Cargo.toml").write_text(shape_b_workspace_toml())
    for mod in MODULES:
        crate = root / "crates" / mod["name"]
        (crate / "src").mkdir(parents=True)
        (crate / "Cargo.toml").write_text(shape_b_crate_toml(mod["name"], mod["deps"]))
        write_module(crate / "src", mod, "b")
    app = root / "crates" / BIN
    (app / "src").mkdir(parents=True)
    (app / "Cargo.toml").write_text(
        shape_b_crate_toml(
            BIN,
            ["session", "policy", "engine", "catalog", "syntax", "core_ids", "bytes_util"],
            binary=True,
        )
    )
    # Binary crate: only a main.rs (no lib), so it depends on the seven libs.
    (app / "src" / "main.rs").write_text(
        """//! Thin binary on top of the layered modules (workspace binary crate).
fn main() {
    let n = run();
    println!("fiber_synth {n}");
}

fn run() -> u64 {
    session::module_fingerprint()
        ^ policy::module_fingerprint()
        ^ engine::module_fingerprint()
        ^ catalog::module_fingerprint()
        ^ syntax::module_fingerprint()
        ^ core_ids::module_fingerprint()
        ^ bytes_util::module_fingerprint()
        ^ session::TOUCH_MARKER as u64
        ^ policy::TOUCH_MARKER as u64
}
"""
    )


def main() -> None:
    generate_shape_a(ROOT / "shape_a")
    generate_shape_b(ROOT / "shape_b")
    print("generated shape_a/ and shape_b/")
    print(f"ITEMS={ITEMS} FILES={FILES} modules={len(MODULES)}")


if __name__ == "__main__":
    main()
