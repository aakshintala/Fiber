#!/bin/sh
# Pass-1 disqualification probe. Re-runs every result reported for issue #11.
# Exits non-zero if any probe crashes, hangs, or reports FAIL where a PASS is
# expected. interrupt_guarded is EXPECTED to fail for Lua - that is the finding.
set -e
cd "$(dirname "$0")"
RUSTC_WRAPPER=../../crate-split/no_wrapper.sh cargo build --release
fail=0
run() { # run <bin> <probe>
  out=$(timeout 30 ./target/release/"$1" "$2" 2>&1) || out="RESULT $2 CRASHED_OR_TIMEOUT"
  echo "[$1] $out"
  case "$out" in *CRASHED_OR_TIMEOUT*) fail=1 ;; esac
}
echo "=== lua (mlua 0.12, Lua 5.4, stdlib stripped to TABLE/STRING/MATH/UTF8/COROUTINE) ==="
for p in sandbox interrupt interrupt_guarded interrupt_rearm interrupt_escalate \
         threads error recurse oom hook_cost; do run probe-lua "$p"; done
echo "=== luau (mlua 0.12 feature luau, sandbox(true)) ==="
for p in sandbox interrupt interrupt_guarded interrupt_adversarial \
         threads error recurse oom hook_cost; do run probe-luau "$p"; done
echo "=== js (rquickjs 0.14, Context::full) ==="
for p in sandbox interrupt interrupt_guarded threads error recurse oom hook_cost; do
  run probe-js "$p"; done
exit $fail
