# Brief: mcp-http + mcp-auth repair against the new list contract

Two files, unblocked by the committed renderer change (`3fcbe7b7`: `mcp list`
stopped printing transport-product fields it cannot fill). Read this file
completely before editing anything. Read `phase5-delegate-brief-example.md`
(the working pattern) first.

## Where you are

- Worktree/branch as assigned at delegation time. Binary at
  `zig-out/bin/fiber`, `tests/e2e/node_modules` installed.
- **Do not push.** Commit locally per file and stop.
- Scope: exactly `tests/e2e/mcp-http.test.ts` and `tests/e2e/mcp-auth.test.ts`.
  The running fake-codex delegate owns every other gateway reference; do not
  touch any other file even if failing.

## The one rule that matters

**Never edit `src/` to make a test pass.** Two deliberate product decisions
explain nearly every failure here; the correct fix is always in the test.
Anything else goes in `FINDINGS.md` with evidence.

## The new contract (what `3fcbe7b7` decided)

`fiber mcp list` never opens transports. It prints config plus stored
credentials only:

```
MCP health (1 server):
  fixture source=profile scope=user policy=optional transport=http state=disconnected auth=authenticated
```

- Header line keeps `state=` (the honest published state: not connected) and
  `auth=` (filled from stored credentials — `login`/`logout` flows still
  assert these).
- The negotiated/protocol/counts/cache/subscription/retry/discovery detail
  lines are gone whenever the snapshot doesn't know them (always, for `list`).
- `--connect` no longer exists (`parseMcpOptionalJsonArgs` accepts only
  `--json`). Every `["mcp", "list", "--connect"]` call now exits a usage
  error — convert, do not "fix" arg parsing.
- There is deliberately NO live-check surface yet: `mcp doctor` today covers
  config (`mcp_config` check) and is the named future home for live checks.
  Assertions that `list` connected (`state=ready`, `protocol=`,
  `negotiated_name=`, `tools=N`, fixture request sequences like
  `server/discover → initialize → tools/list`) have nowhere to move. DELETE
  them citing this decision — do not re-point them at `doctor`, which cannot
  prove them today.

## The mapping (per assertion, not per line)

| Old assertion | New assertion |
| --- | --- |
| `state=ready` / `protocol=` / `negotiated_*` / `tools=N` on `list` output | delete (decision above); keep the `code==0` + `stderr==""` skeleton |
| fixture `.requests` sequence after `list` | `expect(requests).toHaveLength(before)` — list opens nothing. This is the retained behavioral proof; the `mcp-auth` logout case already has this shape |
| `auth=authenticated` / `auth=required` in list output | KEEP — still printed, still meaningful (stored creds) |
| `["mcp", "list", "--connect"]` cases | plain `["mcp", "list"]` asserting config+auth, or delete if the case only proved liveness. Say which per case |
| `/mcp list` TUI cases (`sendText`) | same contract — the TUI path renders through the same function, but the TUI runtime never had live data in these fixtures either; apply the same mapping |
| `login` / `logout` / credential-file assertions | untouched — independent of `list` |

If a case's ONLY content was liveness-through-list (nothing left after the
mapping), delete the case and name the decision in the commit message. That is
an updated suite, not a weakened one — say so explicitly per deletion.

## Verifying

One file at a time, only your files:

```sh
cd tests/e2e
TMUX_TMPDIR=/tmp/fr-$$ bun test --max-concurrency 1 \
  --reporter=junit --reporter-outfile=/tmp/out.xml ./mcp-http.test.ts
```

Traps: short `TMUX_TMPDIR` (104-byte socket cap); bun 1.4 hides passes (read
the JUnit XML); never bare `zig build`; never retry to green; `-t` to iterate
single cases, full file at the end.

## Done means

1. Both files green except written-up FINDINGS.
2. One commit per file naming the file; body states per deleted assertion WHY
   the old contract is gone (reviewer must not rerun).
3. Matcher-ratio check per file (`toBe`/`toEqual` vs `toContain`/`toMatch`
   before/after — deletions shrink both proportionally; loosening shows as
   exact falling while fuzzy rises).
4. Plain unfinished list.
