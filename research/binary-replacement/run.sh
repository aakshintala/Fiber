#!/bin/sh
set -u
V=1 rustc -O main.rs -o v1; V=2 rustc -O main.rs -o v2
cp v1 fiberA; ./fiberA A.log & PA=$!
cp v1 fiberB; ./fiberB B.log & PB=$!
sleep 1.2
echo "in-place cp:"; cp v2 fiberA; echo "cp exit=$?"
cp v2 fiberB.new && mv fiberB.new fiberB; echo "mv exit=$?"
sleep 2
wait $PA; echo "A exit=$?"; wait $PB; echo "B exit=$?"
echo '--- A'; sed -E 's/exe=[^ ]+ //' A.log | sed -n '2,6p'
echo '--- B'; sed -n '3,7p' B.log
