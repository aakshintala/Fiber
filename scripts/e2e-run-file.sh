#!/usr/bin/env bash
# Run one deterministic E2E file, with one retry on first-attempt failure.
#
# Invoked once per test file by the E2E shard step, several at a time via
# `xargs -P`. Each invocation gets its own tmux server (TMUX_TMPDIR) so lanes
# cannot tear down each other's sessions.
#
# This ALWAYS exits 0 and records the real outcome under RESULTS_DIR, because
# `xargs -P` aborts the whole fan-out when a child exits non-zero. The shard
# step aggregates those files and decides the job's exit code.
set -uo pipefail

test_file="$1"
: "${RESULTS_DIR:?RESULTS_DIR must be set}"
: "${SHARD_INDEX:?SHARD_INDEX must be set}"

slug="$(printf '%s' "$test_file" | tr -c '[:alnum:]' '-')"
lane_dir="${RESULTS_DIR}/${slug}"
mkdir -p "$lane_dir"

# A tmux socket must stay under the 104-byte sun_path limit, and the isolated
# launch path appends a ~31-char socket name under <dir>/tmux-<uid>/. TMPDIR on
# macOS is a ~48-char /var/folders path, which overruns; /tmp is the same choice
# terminal-host-helpers.ts makes for the same reason.
tmux_tmp_dir="$(mktemp -d /tmp/fe2e-XXXXXX)"
junit_report="${lane_dir}/junit.xml"

status=0
if TMUX_TMPDIR="$tmux_tmp_dir" bun test --max-concurrency 1 \
  --reporter=junit --reporter-outfile="$junit_report" "./$test_file"; then
  :
else
  printf 'E2E shard %s: %s failed first attempt; retrying once\n' "$SHARD_INDEX" "$test_file" >&2
  # Failing test names come from the structured JUnit report, never from
  # grepping the log. An unparseable or missing report yields nothing and the
  # entry degrades to the bare file line, exactly as before.
  failing_tests=$(python3 -c 'import sys,xml.etree.ElementTree as ET;print("\n".join(lbl for tc in ET.parse(sys.argv[1]).getroot().iter("testcase") for name in [(tc.get("name") or "").strip()] for cn in [(tc.get("classname") or "").strip()] for lbl in [(cn+" > "+name) if cn and cn!=name else name] if (tc.find("failure") is not None or tc.find("error") is not None) and lbl))' "$junit_report" 2>/dev/null || true)

  retry_tmp_dir="$(mktemp -d /tmp/fe2er-XXXXXX)"
  if TMUX_TMPDIR="$retry_tmp_dir" bun test --max-concurrency 1 "./$test_file"; then
    printf '::warning::E2E flake (passed on retry, needs flake issue): %s\n' "$test_file"
    printf '%s\n' "$test_file" > "${lane_dir}/retried"
    while IFS= read -r failing_test; do
      [ -n "$failing_test" ] || continue
      printf '%s: %s\n' "$test_file" "$failing_test" >> "${lane_dir}/flakes"
    done <<< "$failing_tests"
  else
    status=1
  fi
  TMUX_TMPDIR="$retry_tmp_dir" tmux kill-server 2>/dev/null || true
  rm -rf "$retry_tmp_dir"
fi

TMUX_TMPDIR="$tmux_tmp_dir" tmux kill-server 2>/dev/null || true
rm -rf "$tmux_tmp_dir"

printf '%s\n' "$status" > "${lane_dir}/status"
exit 0
