# Phase 5 triage: what the first full E2E run found

The first complete local run of the end-to-end suite since the transition began.
macOS arm64, ReleaseSafe, serial, one pass, no retry. 212 minutes for 55 files
against a fork-point budget of roughly 40 minutes, and the whole difference is
failure tax: a failing wait burns its entire timeout where a passing one returns
in milliseconds.

**961 cases measured, 684 failing (71%), 254 passing, 23 skipped, across 51
files.** Compare `phase5-baseline.tsv`, where every one of these passed.

## Read this first

**Nothing found so far is a defect in the product.** Every cluster identified
below is either a deliberate transition decision the test never learned about,
or a test whose environmental assumption the transition invalidated. That is the
expected shape — but it is a finding, not an assumption, and the next cluster
may break the pattern.

Four files produced no result at all, hitting a 900-second per-file cap:
`tui-composer-edit-contracts`, `tui-decision-prompts`, `tui-gateway-stream-lifecycle`,
and `tui-resume` (988s). They are unmeasured, not passing and not failing.

Thirteen files ran against a Debug binary after a stray `zig build` replaced
ReleaseSafe mid-run, and their results are void: `tui-keybindings`, `tui-resize`,
`tui-interrupt-recovery`, `tui-slash-commands`, `tui-render-replay`,
`tui-slash-extra`, `tui-render-lab`, `tui-render-stress`, `tui-performance`,
`tui-native-clear-recovery`, `tui-resume-brutal`, `tui-permissions`,
`tui-render-live-stress`. Re-run them before trusting any number here that
depends on them.

Twelve files are fully green: `ci-shards`, `context-limits-live`, `tmux-helpers`,
`tui-agent`, `tui-auth-source-selection`, `tui-direct-write-audit`,
`tui-input-line-delete`, `tui-keychain`-adjacent `tui-native-clear-recovery`,
`tui-render-live-stress`, `web-fetch-live`, `web-search-permission-progress`,
`tui-keybindings`. Several are green only because they skip without credentials.

## Cluster 1 — the fake Gateway no longer authenticates

**The largest by far.** Every test that drives `fiber ask` through a fake gateway
fails identically. Reproduced by hand:

```
$ fiber ask --json --permission-mode auto --no-save "hi"
{"ok":true,...,"error":"MissingCredentials"}
exit=1
fiber ask: fiber needs a Codex subscription login for this model. Run fiber login codex.
```

The tests stand up a fake Gateway and point `FX_GATEWAY_BASE_URL` and
`FX_GATEWAY_CHAT_URL` at it. Fiber is Codex-only now and that env path no longer
satisfies the credential check. The Gateway seam was deliberately deleted, so
this is superseded, not broken.

Affects `gateway-stream-lifecycle` (72), `mcp-legacy-remote` (38),
`auto-mode-reliability` (27), `permission-errors`, and others not yet attributed.

**The migration is already half done.** `764533fa` ("Repair focused e2e suites
for the Codex-only runtime") replaced `web-search-fake-gateway.test.ts` with
`web-search-fake-codex.test.ts` and stopped there. That file is the template for
the rest.

## Cluster 2 — `mcp list` no longer opens transports

`mcp-http` asserts `state=ready` from plain `mcp list`; `mcp-auth` calls
`mcp list --connect`, which now exits 2 as a usage error. Confirmed against the
binary:

```
$ fiber mcp list --connect
usage: fiber mcp <command> ...
exit=2

$ fiber mcp list
No MCP servers configured.
exit=0
```

`../enhancements/pending.md` records the decision under `fiber mcp doctor`: the
removal happened and nothing replaced it. Roughly 74 cases.

**A product question falls out of this.** `mcp list` still prints `state=`,
`auth=`, `protocol=`, `tools=`, `resources=`, `cache=`, `subscription=` for every
server, and every one is now permanently a placeholder — `disconnected`,
`unavailable`, `unknown`, `pending`. Owner's decision: **`mcp list` should stop
printing fields it cannot fill.** That is a source change, and the tests follow
it rather than the reverse.

## Cluster 3 — the rename pushed a socket path over the macOS limit

All 54 `terminal-host` failures are one cause, and it is the subtlest thing here.

```
/var/folders/dq/.../T/fiber-terminal-host-XXXXXX/.fiber/terminal-host-v7/host.sock
= 109 bytes                                                  (macOS limit: 104)

under fx:  .../fx-terminal-host-XXXXXX/.fx/terminal-host-v7/host.sock
= 103 bytes                                                  (fit, by one byte)
```

`fx` to `fiber` and `.fx` to `.fiber` added six characters. The tests build their
HOME with `mkdtempSync(join(tmpdir(), "fiber-terminal-host-"))`, and macOS
`tmpdir()` is a 48-character `/var/folders/...` path.

**The product handles this correctly.** `host.zig:120` catches `NameTooLong` and
falls back to a hashed endpoint under `/private/tmp/fiber-terminal-<uid>-<sha>/`,
which is exactly where the socket appears. The test's `hostPaths()` only knows
the non-fallback location, so it waits 2 seconds for a socket that will never
exist there and reports `fixture timed out`.

Fix belongs in the test: resolve the endpoint the way the product does, or give
the test a short HOME. Do not change the fallback — it works, and it is the
reason this is not a user-facing bug.

Note the runs leave `/private/tmp/fiber-terminal-501-*` directories behind, 199
after one pass. The idle timeout reaps the processes; the directories persist.

## What this says about the suite

The failure count is not the useful number. 684 failures resolve to a small
number of causes, and the three identified here account for roughly 280 of them
without a single line of product change. Triage by signature, not by case.

The corollary matters for scheduling: repairing the fake-gateway cluster is one
piece of work that turns hundreds of cases green at once, and it should happen
before anything is measured again.
