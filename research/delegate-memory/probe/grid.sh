#!/bin/bash
# Round 1 grid for fiber#76: per-session state, threads against processes.
M="$(dirname "$0")/measure.sh"
bash "$M" idle
for kb in 200 2048; do
  for n in 1 10 110; do
    bash "$M" run $n $kb shared all
    bash "$M" run $n $kb per all
    bash "$M" spawn $n $kb all
  done
done
# Components, one at a time, in one process (slope 10 -> 110 isolates the per-session increment).
for c in lua sql tls conv thread; do
  for n in 10 110; do bash "$M" run $n 200 per $c; done
done
for n in 10 110; do bash "$M" run $n 2048 per conv; done
for n in 10 110; do bash "$M" run $n 200 shared tls; done
