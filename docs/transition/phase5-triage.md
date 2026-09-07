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

## Addendum 2026-09-07: held gateway-protocol files (second delegate wave)

The fake-codex delegate owns the 24 mechanical files. These four are held for
one reason each; none is mechanical.

- **`vision-route-fake-gateway.test.ts`** (3057 lines, one `describe`). Every
  case parameterizes over non-Codex providers (`zai/glm-5.2-fast`,
  `google/gemini-2.5-flash`). Precedent `764533fa` deleted the Grok provider
  surfaces rather than migrating them. Expect the same here: provider-specific
  cases delete with slice evidence, any provider-agnostic route remainder
  migrates. File rename goes in the owner rename pass.
- **`gateway-stream-lifecycle.test.ts`** (6562 lines) and
  **`tui-gateway-stream-lifecycle.test.ts`** (5942 lines). Built on gateway SSE
  wire shapes (`fakeGatewaySse`, `fakeGatewaySerializedToolCall`,
  `fakeGatewayToolCall`) plus gateway classifier decisions. The classifier was
  already deleted as superseded in `764533fa`; SSE-wire assertions have no Codex
  equivalent (different protocol) and delete or rewrite against
  `codexFinalText`/`codexToolCall` stream shapes. Per-test judgment, not
  mechanical — delegate with the delete-with-evidence rule.
- **`tui-gateway-stream-lifecycle` must be re-run before triage.** It is one of
  the four 900s-capped files with no results; unobserved failures cannot be
  classified. Re-run when the machine is free of delegates.
- **`auto-mode-reliability.test.ts`** (1816 lines). `classifierRequests`
  assertions (lines ~225-501) test the removed classifier — delete with
  evidence per `764533fa`. The lean reliability remainder migrates via the
  codex `route` callback. Delegate-able once the classifier rule is explicit
  in the brief.

## Addendum 2026-09-07: terminal-host residue (2 cases, owner-classified)

The terminal-host delegate left the file at 64 pass / 3 skip / 2 fail ($0.026).
Both edits verified clean (+11/-5, matcher ratio unchanged, second fix strictly
stricter). Residue:

- **`durable authority survives reconnect` — test was wrong, fixed.** The 5th
  foreign claim used `transport_role: "acp"`, unparseable since Slice 22 cut
  that arm from `TransportRole` (`{interactive, headless}`), so the client dies
  `InvalidPayload` instead of reaching `authority_denied`. Re-pointed at
  `"headless"` per the plan.md note; passes solo (44 expects).
- **`reopened cancellation reports open failure` — test-side race, fixed.**
  Replacement host (`idleMs=300`) retired before the final force-close
  handshake whenever scheduling delayed the handshake past the 300ms idle
  window with no clients or live work: failed solo (idle machine retires
  promptly), passed in loaded full-file runs (starved idle thread retires
  late). Product behavior is correct; the case proves force-close-after-
  failure, not idle timing, so the replacement now uses `idleMs=5000`.
  Verified 3/3 solo plus the full file green. The earlier "product suspect"
  call in this addendum was wrong; the fork-binary experiment is moot.

## Addendum 2026-09-07: mcp delegate residue

`mcp-http` (3 cases) and `mcp-auth` (4 cases) repaired against the
transport-free list contract and committed (1a0d2176, 44b624f4, $0.019).
Residue, both out of list-contract scope:

- **ask-based cases in both files still need gateway→codex migration**
  (~35/39 mcp-http, ~27/48 mcp-auth fail `MissingCredentials`). Steered into
  the running fake-codex delegate as its follow-up; list assertions already
  committed, auth plumbing only.
- **`mcp-auth:2398 "fresh TUI login"`**: `authorizationRequests` 0 vs 1 right
  after the `/mcp auth fixture` confirm prompt, pre-list, isolated solo run.
  Unclassified — needs a product-vs-test call once the migration lands.

## Addendum 2026-09-07: session-boundary wiring (owner src change)

The session-recovery delegate's finding 1 verified: `logOptions()` had no
production caller, so 13 of 16 SIGKILL cases were unreachable. Wired
`session_test_controls.logOptions()` into the `fiber ask` create and resume
paths (`cli_ask.zig`; `startWritableSessionWithOptions` /
`ResumeOptions.log`). No env means byte-identical behavior (returns `. {}`).
Proved live on the binary: `FIBER_E2E_SESSION_BOUNDARY=after_event_append`
paused the process and wrote the ready file. Note the pause loop ignores
SIGTERM — kill hung probes with -9, and future harness SIGKILLs must target
the exact boundary-paused pid. Also noted: the seeded login needs exact
0700/0600 perms or the credential check fails before session create.
Finding 3 (`show last` tie-break surfacing the corrupt source) stands as a
product question for the session owner.

## Addendum 2026-09-07: fake-codex wave 1 lands (15 files, $0.67)

First delegate done: 7 files full-green, independently re-verified and
committed (cli, file-tool-permissions, permission-errors,
yolo-permission-mode, tui-interrupt-recovery, ask-presentation,
tui-resume-brutal). 8 files migrated with classified residuals (left dirty,
not committed): notifications (4/5), prompt-history (3/4),
tui-slash-commands (6/8), tui-decision-prompts (47/49),
tui-composer-edit-contracts (28/30), tui-performance (3/1 + 2 gated),
tui-file-picker (15 + 1 live-skip); tui-cost unmigratable (no edits);
tui-input-navigation harness converted, image-paste case mid-debug.
Untouched: mcp-legacy-remote, tui-command-permissions,
tui-full-transcript-brutal, tui-permissions, tui-resize, tui-resume,
tui-slash-menu, tui-terminal-tool (+ mcp-http/auth gateway follow-up).
Residual findings needing owner calls: /sound removed (Slice 17?),
`debug replay --json` frame_count gone, /settings [All] tab, /help
Commands 20 vs 35, cost always 0 (no Codex generation reconciliation),
malformed ask_user_question kills turn (SyntaxError, no recovery),
malformed-call arg echo without tool_execution_failed envelope,
missing-HOME sessions cannot authenticate, tui-performance has no
isolated-HOME credential story, template web-search-fake-codex itself
red on the .data envelope. Ops note: a pre-crash orphan fiber process
(2h49m, 8s CPU, notifications fixture) wedged later spot-checks until
killed — always `pgrep` for strays after a delegate dies mid-run.

## Addendum 2026-09-07: owner calls, item 1 (command-surface residuals)

- **`/sound`: removed, delete-with-evidence.** Transition doc orders the removal; Slice 17a (`420ed0bc`) removed the command; the setting it controlled lives in `/settings` only.
- **Keep the `[All]` catalog tabs; fix the E2E line.** Tabs are inherited upstream (`52f389b2`), rendered by both catalog presentations (`settings_menu_presentation.zig:190-208`, `help_menu_presentation.zig:212-230`), and pinned by unit test (`settings_menu_presentation.zig:464-491`). The single contradicting line (`tui-slash-commands.test.ts:192`, `not.toContain("[All]")`) flips to `toContain`. Test-only.
- **Accept Commands 20; update six files 35→20.** The header renders live from catalog size (`help_menu_presentation.zig:206-211`); 20 is correct-by-construction after the doc's removal list. Files: `prompt-history`, `tui-gateway-stream-lifecycle`, `tui-input-navigation`, `tui-render-stress`, `tui-resize` (+1 more holder).

## Addendum 2026-09-07: owner calls, item 2 (isolated-HOME credential story)

- **Bundled into one helper.** `seededFakeCodexEnv` in `tests/e2e/tmux-helpers.ts`
  seeds the ChatGPT login (0700/0600) and returns `fakeCodexEnv` in one call.
  Forgetting the seeding surfaced as `MissingCredentials`, indistinguishable
  from a product regression; the pair is now unforgetable. Other files adopt
  as touched. Env-credential product fallback ruled out (resurrects the
  deleted gateway seam; doc requires fresh Fiber auth from HOME).
- **Missing HOME cannot authenticate: product-correct, pinned.**
  `tui-performance` "prompt admission treats missing HOME" migrated off the
  gateway harness: with HOME unset the turn blocks at the subscription-login
  notice, never `HomeNotSet`, stderr clean, no request. Gateway-era success
  of that turn is superseded, not regressed.
- `tui-performance.test.ts`: 4 pass / 2 gated-skip / 0 fail.

## Addendum 2026-09-07: owner calls, item 3 (second-wave scope approved)

- Owner approved the sketched brief: delete-with-evidence for
  provider-specific (vision-route), classifier, and SSE-wire cases; migrate
  the remainder via the Codex `route` callback; file renames stay with owner.
- Sequencing: re-run capped `tui-gateway-stream-lifecycle` on a delegate-free
  machine before classifying it. Brief must flag the malformed-tool-arg cases
  (`gateway-stream-lifecycle:2174,4339`) as re-verify-against-fixed-product,
  not delete candidates (intake classification landed in
  `responses_protocol.zig`). Delegates on muse-spark-1.3-contributor.

## Addendum 2026-09-07: owner calls, item 4 (template `.data` envelope)

- **Explained and fixed.** `fiber ask --json` wraps payloads in
  `{ok, kind, data}` (pinned in `cli_ask.zig:7422`); the template's
  `parseFxJson` read `output`/`tool_calls` off the top level instead of
  unwrapping `.data`, so every `ask --json` assertion failed before testing
  behavior. One-line unwrap; 3/4 green. The remaining case (:297) is the
  briefed ACP-driver conversion (`AcpClient` spawns removed `fiber acp`),
  not the envelope — rides with the ACP-conversion work, converts to
  `seededFakeCodexEnv` when it does.
- `web-search-fake-codex.test.ts`: 3 pass / 0 skip / 1 fail (ACP leftover).

## Addendum 2026-09-07: intake fix verified live, one test-shape leftover

- `responses_protocol.zig` finish classifies each Codex tool call via
  `ToolArgumentIntegrity.classifySerialized` (single intake point).
  Full Zig suite: 7228 pass / 2 skip. Live binary (`-t malformed`,
  tui-decision-prompts): the pane no longer shows SyntaxError and the
  Codex follow-up pairs `tool_execution_failed` /
  "Tool arguments were not valid JSON." for `ask_user_question`.
- Leftover for the file's delegate (test-shape, not product): two cases
  still assert the gateway-era `'"input":{}'` substring, which has no
  Codex equivalent (follow-up carries `output:{error:{...}}` in
  function_call_output history items). Replace with a Codex-shape
  assertion on the paired error output. Cases: "malformed ask arguments
  recover without opening a question prompt", "malformed streamed read
  arguments never publish their provisional label".

## Addendum 2026-09-07: decision-prompts 47/49, scrub-vs-retain owner call

- Delegate migrated the two malformed cases to Codex-shape error assertions
  (pass live); no-SyntaxError + tool_execution_failed pins hold (47 green,
  independently re-verified). File stays dirty, uncommitted.
- Remaining 2 failures are whole-body `not.toContain` echo checks: Codex
  follow-up retains verbatim malformed args (`"arguments":"{]"`) in the
  `function_call` history item beside the paired `function_call_output`
  error; gateway-era scrubbed to `{}`. Retain reads coherent (the call item
  is the recorded model action; the output references it by call_id), but
  scrub-vs-retain in persisted history is a product call. Morning decision:
  (a) accept retain → relax the two echo assertions to target the output
  item, or (b) scrub at the pairing site → src change + keep assertions.
- Ops: a wave-2 delegate's broad pkill clipped a sibling's fixture
  mid-run; composer-edit gets an insurance re-run before the night ends.
  Briefs now say: scope pkill patterns to your own TMPDIR/fixture names.

## Addendum 2026-09-07: capped tui-gateway-stream-lifecycle re-run (50/51 fail)

- Solo ReleaseSafe rerun: 51 tests, 50 fail, 0 skip, 1541s. No data before;
  now the second wave has its classification base.
- Signature clusters: 15 auth-blocked (turn dies at Codex login — harness
  still points at the gateway seam); 19 bare timeouts; rest pane-predicate
  timeouts on gateway-flavored waits ("held Gateway stream/request",
  "full-window model catalog", "HTTP retry/restricted provider", token
  counters, checkpointed-request duplicates, Fast-heartbeat/model-ID cases).
- File saturates per-case `startFakeGateway` servers (61 helper refs).
  Briefed as one staged delegate task: (1) mechanical harness swap to
  fake-codex + seeded env, re-run, report; (2) per-case judgment —
  gateway-wire/classifier-only deletes with evidence, TUI behavior with a
  Codex equivalent rewrites, unclassifiable stays red in the report.

## Addendum 2026-09-07: scrub-vs-retain now spans three files

- `tui-gateway-stream-lifecycle` migrated: 33 pass / 1 fail / 0 skip in
  70s (was 50 fail in 1541s). 17 deletions with in-file ledger
  (11 gateway transport recovery-arc, 3 standing-Fast, 1 GLM picker,
  2 /image). Committed.
- The 1 failure is the duplicate-key scrub assertion — third instance of
  the pending call alongside decision-prompts x2. Pattern now reads as
  product truth (retain verbatim model action in function_call; error in
  the paired output), but the pin stays red until the owner rules.

## Addendum 2026-09-07: mcp-http 38/39, ECONNRESET residue

- Migrated tree verified as-is on resume (no new edits needed): 38 pass /
  1 fail, 9s. Independently re-verified, same single failure. Stays dirty.
- `fixed-length sse responses complete on one-shot connections`: every
  product assertion passes (exit 0, output, methods, connection:close);
  only the fixture-health assert fails (`read ECONNRESET`). Evidence:
  return-on-first-final-SSE is by design (776f9c84); fixture's 5ms split
  write races the client close; streamable_http.zig fork-identical;
  baseline-green on CI. Morning options: (a) fixture-tolerance fix
  (test-only — RST after full delivery is expected fallout of the
  by-design early return), (b) quarantine as platform-flake, (c) leave red.

## Addendum 2026-09-07: vision-route 40 -> 10, claim verified at src

- Delegate deleted 30 vision-fallback cases citing a198a07c. Verified the
  claim independently: builtin_providers.native codex bundle sets no
  .capabilities (providers.zig:8-17), Bundle.Capabilities defaults
  vision_fallback=false (provider_set.zig:16-20), and main App HAS
  providerSet (main.zig:1674/1788) so the true-branches in
  app_agent_runtime.zig:169/1045 never fire for codex. Vision tool never
  advertised; deletions legitimate. 10/10 green, committed.
- Product question for images owner: resuming a session with a corrupted
  owned snapshot now silently omits the image (exit 0, no request) — old
  image_unavailable tool result unreachable. Not pinned; needs owner call.

## Addendum 2026-09-07: tui-permissions 21/21, pacing-hold question

- Migrated (review-queue pattern from auto-mode verbatim): 21/21 green,
  committed. 1 deletion: `pauses paced assistant text while a file
  approval is active` (gateway streaming-arc pin, no Codex equivalent —
  Codex commits streamed text + Thinking-footer preview before decision).
- Owner question (non-blocking): should the pacing hold be re-implemented
  for Codex, or is commit-then-preview the accepted behavior? If the
  latter, nothing to do.

## Addendum 2026-09-07: gateway-stream-lifecycle 52/1/2, held for scrub call

- Split-brief finish worked: cluster 1 was one shared startGateway body
  fix; clusters 2-3 migrated per case; 1 gateway-only empty-finish test
  deleted. Owner independently re-ran the FULL file: 52 pass / 1 skip /
  2 fail in 57s — the delegate's 10-fail intermediate was contention
  under 4 runners, not product. File stays dirty until the scrub call.
- Scrub-vs-retain now spans FIVE cases in four files: decision-prompts
  x2, TGSL duplicate-key, GSL saved-malformed-recovery + malformed-MCP-
  echo. Every instance identical: verbatim model action retained in
  function_call, structured error in paired output, no-SyntaxError +
  tool_execution_failed pins green. Recommendation: accept retain (rule
  in favor of history fidelity), relax the 5 echo assertions to target
  the output item — all test-only, one decision unblocks four files.

## Addendum 2026-09-07: transcript-brutal trace-needle correction (accepted)

- tui-full-transcript-brutal 3/3/0 green, committed. Trace waits changed
  from require-ALL to require-ANY with the routeless product line added.
  Accepted as correction, not weakening, verified at src: the runtime
  logs `depth_transition from={s} to={s} trigger={s}` with NO route field
  (input_full_transcript_runtime.zig:211); only ctrl_o-open (main.zig:2566)
  and approval_handoff (app_lifecycle.zig:816) carry route=root. The old
  `route=root trigger=escape` needle is unsatisfiable at fork point —
  baseline TSV pass for that soak is inconsistent with the code. Flagged.
