#!/usr/bin/env bash
# Print CI job durations, slowest first, for a pull request's latest
# completed draft-scope and ready-scope runs.
#
# The critical path differs by scope: draft runs Linux x86_64 only, ready adds
# macOS and arm64. Name the scope whenever you call a job "the wall".
#
# Usage: scripts/ci-timings.sh <pr-number>
set -euo pipefail

pr="${1:?usage: scripts/ci-timings.sh <pr-number>}"
repo="aakshintala/Fiber"

branch="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
runs="$(gh run list -R "$repo" --workflow ci.yml --branch "$branch" -L 30 \
  --json databaseId,status,conclusion \
  --jq '.[] | select(.status == "completed" and .conclusion != "cancelled") | .databaseId')"

seen_draft="" seen_ready=""
for run in $runs; do
  view="$(gh run view "$run" -R "$repo" --json headSha,createdAt,updatedAt,conclusion,jobs)"
  # Ready scope is the only one that runs a macOS job.
  if jq -e '[.jobs[] | select((.name | test("macos")) and .conclusion != "skipped")] | length > 0' <<<"$view" >/dev/null; then
    scope=ready
    [ -n "$seen_ready" ] && continue
    seen_ready=1
  else
    scope=draft
    [ -n "$seen_draft" ] && continue
    seen_draft=1
  fi

  jq -r --arg scope "$scope" --arg run "$run" '
    def mins: (. / 60 | floor | tostring) + "m" + (. % 60 | floor | tostring | if length < 2 then "0" + . else . end);
    "== \($scope) run \($run) on \(.headSha[0:8]): \(.conclusion), wall \(((.updatedAt | fromdate) - (.createdAt | fromdate)) | mins)",
    (.jobs
      | map(select(.conclusion != "skipped" and .startedAt != null and .completedAt != null))
      | map(. + {secs: ((.completedAt | fromdate) - (.startedAt | fromdate))})
      | sort_by(-.secs)[]
      | "\(.secs | mins)\t\(.conclusion)\t\(.name)")
  ' <<<"$view"

  [ -n "$seen_draft" ] && [ -n "$seen_ready" ] && break
done

[ -n "$seen_draft$seen_ready" ] || { echo "no completed ci.yml runs for #$pr" >&2; exit 1; }
# canary
