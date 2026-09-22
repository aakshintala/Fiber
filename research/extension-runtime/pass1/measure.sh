#!/bin/sh
# Pass-1 disqualification probe. Re-runs every result reported for issue #11.
# Exits non-zero if any probe crashes or hangs. Note: probe-lua's
# interrupt_guarded is EXPECTED to report FAIL - that is the finding, not a bug.
set -e
cd "$(dirname "$0")"
W=../../crate-split/no_wrapper.sh
RUSTC_WRAPPER=$W cargo build --release                       # lua54 + js
RUSTC_WRAPPER=$W cargo build --release --manifest-path luau/Cargo.toml

fail=0
bin() { # bin <name> -> path
  case "$1" in
    probe-luau) echo "./luau/target/release/probe-luau" ;;
    *) echo "./target/release/$1" ;;
  esac
}
run() { # run <bin> <probe>
  _rb=$(bin "$1")
  out=$(timeout 30 "$_rb" "$2" 2>&1) || out="RESULT $2 CRASHED_OR_TIMEOUT"
  echo "[$1] $out"
  case "$out" in *CRASHED_OR_TIMEOUT*) fail=1 ;; esac
}

echo "=== platform ==="
uname -srm; getconf PAGESIZE

echo "=== lua 5.4 (mlua 0.12, stdlib stripped to TABLE/STRING/MATH/UTF8/COROUTINE) ==="
for p in sandbox interrupt interrupt_guarded interrupt_rearm interrupt_escalate \
         threads error recurse oom; do run probe-lua "$p"; done

echo "=== luau (mlua 0.12 feature luau, sandbox(true)) ==="
for p in sandbox interrupt interrupt_guarded interrupt_adversarial \
         threads error recurse oom; do run probe-luau "$p"; done

echo "=== js (rquickjs 0.14, Context::full) ==="
for p in sandbox interrupt interrupt_guarded threads error recurse oom; do
  run probe-js "$p"; done

# Steady state only: the first iteration in each process pays warmup.
echo "=== hook cost, 5 runs each, read the last ==="
for b in probe-lua probe-luau probe-js; do
  for i in 1 2 3 4 5; do run "$b" hook_cost; done
done

exit $fail
