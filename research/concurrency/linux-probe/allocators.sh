#!/bin/bash
# Allocator comparison for fiber#16: musl's allocator against mimalloc and
# jemalloc on the musl target, with glibc's allocator as the reference.
# Run from the repository root; writes everything under out/.
set -u
ROOT=$PWD
OUT=$ROOT/out
mkdir -p $OUT
ARCH=$(uname -m)
MUSL=$ARCH-unknown-linux-musl
GNU=$ARCH-unknown-linux-gnu
{ uname -a; nproc; lscpu | grep -E 'Model name|^CPU\(s\)'; rustc --version; } > $OUT/host.txt 2>&1

# label target features
VARIANTS="musl-system:$MUSL: musl-mimalloc:$MUSL:mimalloc musl-jemalloc:$MUSL:jemalloc glibc-system:$GNU:"

for v in $VARIANTS; do
  IFS=: read -r label target feature <<< "$v"
  flags=(--release --target "$target")
  [ -n "$feature" ] && flags+=(--features "$feature")

  cd $ROOT/research/concurrency
  cargo build -q "${flags[@]}" -p threads_scale || { echo "build failed $label threads_scale" >> $OUT/errors.txt; continue; }
  B=target/$target/release/threads_scale
  cp $B /tmp/ts && strip /tmp/ts
  {
    echo "## $label threads_scale stripped=$(stat -c %s /tmp/ts)"
    for n in 1 32 128 512; do echo "--- N_THREADS=$n ---"; IDLE_SECS=10 SETTLE_SECS=2 N_THREADS=$n $B; done
  } > $OUT/threads_scale_$label.txt 2>&1

  cd $ROOT/research/hook-conversion-cost
  cargo build -q "${flags[@]}" || { echo "build failed $label hook" >> $OUT/errors.txt; continue; }
  H=target/$target/release/hook-conversion-cost
  cp $H /tmp/hk && strip /tmp/hk
  {
    echo "## $label hook-conversion-cost stripped=$(stat -c %s /tmp/hk)"
    for r in 1 2 3; do
      echo "--- run $r ---"
      /usr/bin/time -v $H 2> /tmp/t.txt
      awk -F': ' '/Maximum resident/{print "maxrss_kib: " $2}' /tmp/t.txt
    done
  } > $OUT/hook_$label.txt 2>&1
done
echo done
