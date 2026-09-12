# Releasing


Fiber publishes no releases yet. The version is `0.0.1-dev`, and
`release.yml` refuses to publish any SemVer prerelease, so merging to `main`
cannot cut a release. There is no installation or upgrade path: `fiber upgrade`
fails with `UpgradeUnavailable` until a release source exists. Building
distribution is tracked as a GitHub issue, not attempted here.

When a stable release does happen, `release.yml` owns it. On a push to `main` it
reads the version from `src/main.zig` through `scripts/release_decision.py`. A
prerelease is refused before the tag is ever consulted. A stable version whose
tag is missing cross-compiles the platform binaries, creates the tag, and
publishes a GitHub Release whose body is the content between the
`<!-- release:start -->` and `<!-- release:end -->` markers in `CHANGELOG.md`.

Never create a version tag by hand; the workflow owns tag creation. Leave the
`build.zig.zon` version alone, it is a placeholder.

## Writing the changelog

Whether automated or manual, the changelog is public product copy. Describe observable user behavior, not the engineering process behind it. Use the diff, commits, and merged pull requests as research evidence only.

Public changelog entries must:

* Spell the product name `Fiber`. Preserve different casing only when it is part of an exact code identifier such as `FIBER_MODEL`.
* Use only relevant sections from `### Breaking Changes`, `### New Features`, `### Improvements`, `### Bug Fixes`, and `### Security`. Omit empty sections.
* Bold a short feature or fix name, then describe the user-visible change after a colon.
* Omit pull request numbers, issue numbers, commit hashes, contributor names, and author attribution.
* Omit internal details such as repository moves, website or marketing work, CDN layout, CI workflows, test fixtures, branch history, and implementation-only refactors. Translate relevant work into its public user outcome or leave it out.
* Avoid forcing every merged change into the notes. A change without a public user outcome does not need a bullet.

Only the current release should have markers; remove `<!-- release:start -->` and `<!-- release:end -->` from any previous entry:

```markdown
## 0.3.0

<!-- release:start -->
### New Features

- **Interactive terminal startup:** Start an interactive shell when the `terminal` tool receives an empty command
<!-- release:end -->

## 0.2.5

### Improvements

- **Inline rendering:** Keep the active conversation visible in terminal scrollback
```

Do not add a `### Contributors` section or tracker references. Use descriptive section names.

Do not create version tags manually. Do not change `build.zig.zon` version (it is a placeholder).

## Generating the changelog

Run the prompt below with any model available to the releaser and paste the
result between the release markers. There is no pinned model or delivery
path: the fx workflow that once called the Vercel AI Gateway was deleted at
commit 993688a5 and does not carry over. Collect the diff stat, the `src/`
diff, and the commit log since the previous release tag first (the
`fork-point` tag while no release tag exists yet):

```sh
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo fork-point)
git diff --stat "$PREV_TAG..HEAD"
git diff "$PREV_TAG..HEAD" -- src/ > /tmp/src-diff.txt
DIFF_SIZE=$(wc -c < /tmp/src-diff.txt | tr -d ' ')
if [ "$DIFF_SIZE" -gt 81920 ]; then
  head -c 81920 /tmp/src-diff.txt > /tmp/src-diff-short.txt
  printf '\n\n[diff truncated at 80KB — %s bytes total]' "$DIFF_SIZE" >> /tmp/src-diff-short.txt
fi
git log "$PREV_TAG..HEAD" --oneline
```

Send all three artifacts to the model in one message naming the version
under review and the previous tag. The `src/` diff is the source of truth;
the commit log is private research context only.

```text
You write changelogs for Fiber, an open-source AI-powered CLI tool written in Zig.

You will receive the actual code diff since the last release, a diff stat summary, and a commit log. Treat the commit log as private research context.

Rules:
- Base your changelog ONLY on what the diff actually shows. Do not trust commit messages or PR descriptions as authoritative — they go stale. The diff is the source of truth.
- Write public, user-facing product notes. Describe observable behavior and outcomes, not how the work was implemented or delivered.
- Always spell the product name Fiber. Preserve different casing only for exact code identifiers such as FIBER_MODEL.
- Group changes under ### Breaking Changes, ### New Features, ### Improvements, ### Bug Fixes, and ### Security as appropriate. Omit empty sections.
- Bold a short feature or fix name, then describe the user-visible change after a colon.
- Do not include pull request or issue numbers, links to trackers, commit hashes, contributor names, author attribution, or a Contributors section.
- Do not include internal details such as repository moves, website or marketing work, CDN layout, CI workflows, tests or fixtures, branch history, or implementation-only refactors. Translate relevant work into its public user outcome or omit it.
- Do not force every commit into the changelog. Omit changes without a public user outcome.
- Output ONLY the changelog body (the content that goes between the release markers). Do not include the ## version heading, do not include the <!-- release:start/end --> markers, do not include any preamble or explanation.
- Do not use emojis.
```

### Dry run

Prove the output on the real diff before editing `CHANGELOG.md`: generate
the body for the range under review, check every item below, and only then
paste it between the markers. The checklist is adapted from the validation
step of the deleted `prepare-release.yml`.

* The output is only the changelog body: no version heading, no release
  markers, no preamble.
* Every `###` heading is one of Breaking Changes, New Features,
  Improvements, Bug Fixes, Security.
* Every bullet matches `- **Name:** Description`.
* Every bullet traces to the diff: spot-check that each bullet maps to at
  least one `src/` diff hunk, and drop bullets with none.
* No pull request or issue numbers, tracker links, commit hashes,
  contributor names, or Contributors section.
* No internal details such as CI, tests, website work, branch history, or
  refactors without a user outcome.
* The product name is spelled Fiber except in exact code identifiers.
* No emojis.

Worked example: this procedure run against the shell poll clamp (empty
`interact` observations wait at least five seconds) produced:

```markdown
### Improvements

- **Shell observation wait:** Observing a running shell session without sending input now waits at least five seconds, so empty polls come back with useful output instead of spinning.
```

