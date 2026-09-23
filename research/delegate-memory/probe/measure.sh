#!/bin/bash
# Usage: measure.sh <rss-probe args...>
# Prints: args | pids | sum RSS KB | sum M2 KB | first-pid RSS KB | first-pid M2 KB
# M2 is phys_footprint on macOS (from `footprint`) and PSS on Linux (from /proc/<pid>/smaps_rollup).
cd "$(dirname "$0")"
out=$(mktemp)
./target/release/rss-probe "$@" > "$out" &
until grep -q READY "$out"; do sleep 0.1; done
sleep 2
pids=$(sed 's/READY //' "$out")
rss=0; m2=0; first=""
for p in $pids; do
  if [ "$(uname)" = Linux ]; then
    r=$(awk '/^Rss:/ {print $2}' /proc/$p/smaps_rollup)
    f=$(awk '/^Pss:/ {print $2}' /proc/$p/smaps_rollup)
  else
    r=$(ps -o rss= -p "$p" | tr -d ' ')
    f=$(footprint "$p" 2>/dev/null | awk '/phys_footprint:/ {v=$2; u=$3; if (u=="MB") v*=1024; else if (u=="GB") v*=1048576; else if (u=="B") v/=1024; print int(v)}')
  fi
  rss=$((rss + r)); m2=$((m2 + f))
  [ -z "$first" ] && first="$r $f"
done
n=$(echo $pids | wc -w | tr -d ' ')
echo "$* | $n | $rss | $m2 | $first"
kill $pids 2>/dev/null
wait 2>/dev/null
rm -rf "${TMPDIR:-/tmp}/rss-probe" "$out"
