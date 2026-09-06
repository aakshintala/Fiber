#!/usr/bin/env bash
# Phase 5 census: run the deterministic E2E suite once and record EVERY case
# result, not only the failures. The pass names are what the baseline diff needs
# to detect a case that disappeared, which is the finding no other gate catches.
#
# Recipe from .github/workflows/full-ci.yml:185-214 -- per file,
# --max-concurrency 1, one retry after killing the tmux server.
#
# Each attempt gets its own log. A retried file is scored on its LAST attempt,
# matching CI, so a flake does not contribute phantom failures to the diff.
set -uo pipefail
cd "$(dirname "$0")/../.."

OUT=${1:-flight-logs/census}
mkdir -p "$OUT/files"
export FIBER_REQUIRE_TMUX=1

echo "building ReleaseSafe..."
if ! zig build -Doptimize=ReleaseSafe > "$OUT/build.log" 2>&1; then
  echo "BUILD FAILED - census cannot run. See $OUT/build.log"
  exit 1
fi

run_file() {  # <file> <attempt> -> log path on stdout, exit status of the run
  local f=$1 attempt=$2 log="$OUT/files/${1}.${2}.log"
  ( cd tests/e2e && TMUX_TMPDIR="$TMPD" bun test --max-concurrency 1 "./$f" ) > "$log" 2>&1
}

: > "$OUT/index.tsv"
n=0
for test_file in $(cd tests/e2e && ls *.test.ts); do
  TMPD="/tmp/fiber-e2e-tmux-$n"; mkdir -p "$TMPD"
  status=PASS; final=1
  if run_file "$test_file" 1; then
    final=1
  else
    TMUX_TMPDIR="$TMPD" tmux kill-server 2>/dev/null || true
    if run_file "$test_file" 2; then status=FLAKY; else status=FAIL; fi
    final=2
  fi
  TMUX_TMPDIR="$TMPD" tmux kill-server 2>/dev/null || true
  printf '%s\t%s\t%s\n' "$status" "$final" "$test_file" | tee -a "$OUT/index.tsv"
  n=$((n + 1))
done

# Authoritative per-case results: the last attempt of each file only.
{
  printf 'status\tfile\tcase\n'
  while IFS=$'\t' read -r _ final test_file; do
    sed -E 's/\x1b\[[0-9;]*m//g' "$OUT/files/${test_file}.${final}.log" \
      | grep -aE '^\((pass|fail|skip|todo)\)' \
      | sed -E "s/^\((pass|fail|skip|todo)\) (.*)$/\1\t${test_file}\t\2/" \
      | sed -E 's/ \[[0-9.]+m?s\]$//'
  done < "$OUT/index.tsv"
} > "$OUT/results.tsv"

{
  echo "# E2E census - $(date -u +%FT%TZ) - $(git rev-parse --short HEAD)"
  echo
  echo "files: $n   FAIL: $(grep -c '^FAIL' "$OUT/index.tsv")   FLAKY: $(grep -c '^FLAKY' "$OUT/index.tsv")   PASS: $(grep -c '^PASS' "$OUT/index.tsv")"
  awk -F'\t' 'NR>1{c[$1]++} END{for(k in c) printf "cases %s: %d\n", k, c[k]}' "$OUT/results.tsv"
  echo
  echo "## Files not clean"
  grep -E '^(FAIL|FLAKY)' "$OUT/index.tsv" | sort || echo "(none)"
} > "$OUT/SUMMARY.md"

cat "$OUT/SUMMARY.md"
