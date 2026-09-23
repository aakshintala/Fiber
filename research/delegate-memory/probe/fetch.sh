#!/bin/bash
# Fetch the two provider catalogs round2.sh parses. No keys needed.
set -e
cd "$(dirname "$0")"
curl -sSf -o openrouter-models.json https://openrouter.ai/api/v1/models
curl -sSf -o models-dev.json https://models.dev/api.json
wc -c openrouter-models.json models-dev.json
