#!/usr/bin/env bash
# Print CI job durations, slowest first, for a pull request's latest
# completed, non-cancelled ci.yml run.
#
# Usage: scripts/ci-timings.sh <pr-number>
set -euo pipefail

pr="${1:?usage: scripts/ci-timings.sh <pr-number>}"
repo="aakshintala/Fiber"

branch="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
run="$(gh run list -R "$repo" --workflow ci.yml --branch "$branch" -L 30 \
  --json databaseId,status,conclusion \
  --jq '[.[] | select(.status == "completed" and .conclusion != "cancelled")] | .[0].databaseId // empty')"

[ -n "$run" ] || { echo "no completed ci.yml runs for #$pr" >&2; exit 1; }

view="$(gh run view "$run" -R "$repo" --json headSha,createdAt,updatedAt,conclusion,jobs)"

jq -r --arg run "$run" '
  def mins: (. / 60 | floor | tostring) + "m" + (. % 60 | floor | tostring | if length < 2 then "0" + . else . end);
  "== run \($run) on \(.headSha[0:8]): \(.conclusion), wall \(((.updatedAt | fromdate) - (.createdAt | fromdate)) | mins)",
  (.jobs
    | map(select(.conclusion != "skipped" and .startedAt != null and .completedAt != null))
    | map(. + {secs: ((.completedAt | fromdate) - (.startedAt | fromdate))})
    | sort_by(-.secs)[]
    | "\(.secs | mins)\t\(.conclusion)\t\(.name)")
' <<<"$view"
