#!/bin/bash
# Round 2 grid for fiber#76: Lua extension set and provider catalogs.
# Needs openrouter-models.json and models-dev.json next to this script (fetch.sh).
cd "$(dirname "$0")"
./target/release/rss-probe luaset 1 stats
bash measure.sh idle
for m in src bin strip; do
  for n in 1 10 40; do bash measure.sh luaset $n $m; done
done
bash measure.sh json openrouter-models.json
bash measure.sh json models-dev.json
