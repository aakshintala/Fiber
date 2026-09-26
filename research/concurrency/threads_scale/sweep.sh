#!/bin/sh
# Parked-thread scale sweep: idle CPU / wakeups / RSS vs N_THREADS and stack.
# Label the host when quoting the numbers; timings are per platform.
set -eu
cd "$(dirname "$0")/.."
WRAPPER="$(cd .. && pwd)/crate-split/no_wrapper.sh"
export RUSTC_WRAPPER="$WRAPPER"
export CARGO_BUILD_RUSTC_WRAPPER="$WRAPPER"
mkdir -p results
cargo build --release -p threads_scale
BIN=./target/release/threads_scale
{
    echo "=== threads_scale sweep ($(uname -srm)) ==="
    for n in 1 8 32 128 512; do
        echo
        echo "--- N_THREADS=$n STACK_KIB=0 ---"
        IDLE_SECS=10 SETTLE_SECS=2 N_THREADS=$n "$BIN"
    done
    for n in 128 512; do
        echo
        echo "--- N_THREADS=$n STACK_KIB=64 ---"
        IDLE_SECS=10 SETTLE_SECS=2 N_THREADS=$n STACK_KIB=64 "$BIN"
    done
} | tee results/threads_scale.txt
