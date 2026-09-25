#!/bin/sh
# Re-runs the conversion cost table in README.md. Prints the platform first.
set -e
cd "$(dirname "$0")"
uname -srm; rustc --version
RUSTC_WRAPPER=../crate-split/no_wrapper.sh cargo run --release --quiet
