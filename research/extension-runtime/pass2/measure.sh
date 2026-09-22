#!/bin/sh
# Pass-2 streaming-provider RSS sweep. Re-runs every reported figure.
set -e
cd "$(dirname "$0")"
W=../../crate-split/no_wrapper.sh
RUSTC_WRAPPER=$W cargo build --release >/dev/null 2>&1
RUSTC_WRAPPER=$W cargo build --release --manifest-path luau/Cargo.toml >/dev/null 2>&1

echo "=== platform ==="; uname -srm; getconf PAGESIZE
TURNS=${TURNS:-50}
for inst in 1 4 16; do
  (cd lua  && ./../target/release/stream-lua   serde  "$TURNS" "$inst" | sed 's/strategy=serde/rt=lua/')
  (cd luau && FIBER_SANDBOX=0 ./target/release/stream-luau serde "$TURNS" "$inst" | sed 's/strategy=serde/rt=luau-nosbx/')
  (cd luau && FIBER_SANDBOX=1 ./target/release/stream-luau serde "$TURNS" "$inst" | sed 's/strategy=serde/rt=luau-sbx/')
  (cd js   && ./../target/release/stream-js     native "$TURNS" "$inst" | sed 's/strategy=native/rt=js/')
done
