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

* Spell the product name `fiber`. Preserve different casing only when it is part of an exact code identifier such as `FIBER_MODEL`.
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

