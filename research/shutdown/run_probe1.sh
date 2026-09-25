#!/bin/bash
# Driver for probe1: runs the python probe (which SIGKILLs itself to
# simulate a Fiber crash), waits, then inspects which marker processes
# are still alive.
set -u
cd /tmp/fiber-wt-shutdown-crash/research/shutdown

echo "=== uname -a ==="
uname -a
echo

echo "=== launching probe1_orphan_sigpipe.py (it will SIGKILL itself) ==="
python3 probe1_orphan_sigpipe.py &
driver_pid=$!
wait "$driver_pid" 2>/dev/null
echo "probe1 driver exit status: $?"
echo

echo "=== waiting 3s after simulated crash ==="
sleep 3

echo "=== ps for surviving fiber_probe_* children ==="
ps -o pid,ppid,pgid,stat,command -e | awk 'NR==1 || /fiber_probe/'
echo

echo "=== output file (child D, writes to a file not a pipe) tail ==="
tail -n 3 probe1_output_file.txt 2>/dev/null || echo "(no output file / no lines yet)"
echo

echo "=== cleanup: killing any surviving fiber_probe_* processes ==="
ps -o pid,command -e | awk '/fiber_probe/ {print $1}' | while read -r pid; do
  echo "killing $pid"
  kill -9 "$pid" 2>/dev/null
done
rm -f probe1_quiet_file.txt probe1_output_file.txt
echo "done"
