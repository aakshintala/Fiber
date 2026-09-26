#!/bin/bash
# Linux re-run for fiber#16. Run from the repository root; writes everything under out/.
# probe.yml is the workflow that ran it (copy it to .github/workflows/ on a throwaway branch).
set -u
ROOT=$PWD
OUT=$ROOT/out
mkdir -p $OUT
ARCH=$(uname -m)
{ uname -a; nproc; lscpu | grep -E 'Model name|^CPU\(s\)'; rustc --version; ldd --version | head -1; } > $OUT/host.txt 2>&1

cd $ROOT/research/concurrency
for T in $ARCH-unknown-linux-musl $ARCH-unknown-linux-gnu; do
  cargo build -q --release --target $T -p threads_scale -p idle_std -p mini_blocking -p mini_smol -p mini_tokio -p cancel_ureq_connector || { echo "build failed $T" >> $OUT/errors.txt; continue; }
  B=target/$T/release
  file $B/mini_blocking > $OUT/file_$T.txt
  {
    for n in 1 8 32 128 512; do echo "--- N_THREADS=$n STACK_KIB=0 ---"; IDLE_SECS=10 SETTLE_SECS=2 N_THREADS=$n $B/threads_scale; done
    for n in 128 512; do echo "--- N_THREADS=$n STACK_KIB=64 ---"; IDLE_SECS=10 SETTLE_SECS=2 N_THREADS=$n STACK_KIB=64 $B/threads_scale; done
  } > $OUT/threads_scale_$T.txt 2>&1
  {
    for m in mini_blocking mini_smol mini_tokio; do
      cp $B/$m /tmp/$m.stripped; strip /tmp/$m.stripped
      echo "## $m unstripped=$(stat -c %s $B/$m) stripped=$(stat -c %s /tmp/$m.stripped)"
      for r in 1 2 3; do
        /usr/bin/time -v $B/$m > /tmp/o.txt 2> /tmp/t.txt
        echo "run $r: $(grep -E '^(cancelled|total)' /tmp/o.txt | tr '\n' ' ') maxrss_kib=$(awk -F': ' '/Maximum resident/{print $2}' /tmp/t.txt) wall=$(awk -F': ' '/Elapsed/{print $2}' /tmp/t.txt)"
      done
    done
  } > $OUT/mini_$T.txt 2>&1
  CANCEL_ITERS=20 $B/cancel_ureq_connector > $OUT/cancel_ureq_connector_$T.txt 2>&1
done
# Idle 60 s context-switch gate, shipped (musl) target only.
B=target/$ARCH-unknown-linux-musl/release
{ IDLE_SECS=60 SETTLE_SECS=3 $B/idle_std; IDLE_SECS=60 SETTLE_SECS=3 N_THREADS=32 $B/threads_scale; } > $OUT/idle60_musl.txt 2>&1

cd $ROOT/research/hook-conversion-cost
for T in $ARCH-unknown-linux-musl $ARCH-unknown-linux-gnu; do
  { uname -srm; echo "target $T"; cargo run -q --release --target $T; } > $OUT/hook_conversion_$T.txt 2>&1
done

cd $ROOT/research/shutdown
{
  echo "### probe1"; bash run_probe1.sh
  echo "### probe2"; python3 probe2_pgid_starttime.py
  echo "### probe3 (Linux)"; python3 probe3_pdeathsig_linux.py
  echo "### probe4"; python3 probe4_stale_output_file.py
  echo "### probe5"; python3 probe5_nested_kill_cost.py
} > $OUT/shutdown.txt 2>&1
echo done
