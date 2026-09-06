# Handoff: Fiber Phase 4 simplification

Rewritten 2026-09-06 after Slice 20. Supersedes every earlier copy.

## Read first

1. `phase4-audit/REAUDIT.md` — the re-audit checkpoint, run after Slice 15.
   Current numbers, the argument that every unsupported-target hit left in
   `src/` is explained, and the host-capability measurement.
2. `phase4-audit/OWNER-QUESTIONS.md` — decisions taken without the owner.
   **Decisions 5, 6, and 7 are resolved.** Decision 3 is withdrawn. Decision 5's
   original evidence was wrong; read the correction before trusting its premise.
3. `simplification-inventory.md` — the ordered slices.
4. `phase4-audit/CORRECTIONS.md` — retention decisions.

`REPORT.md` is raw evidence only. Its arithmetic holds; its scope and triage do
not. **The inventory's Slices 17-27 were written at `b26e3d99` and are stale by
roughly 500 deleted sites. Re-derive every removal surface before opening a
slice.** Slice 16 proved the inventory wrong in both directions at once.

## Where the work stands

Slices 0 through 20 are committed on `main`. The working tree is clean.

```
1230e87e Slice 20: delete dead MCP declarations
4ce80e1d Slice 19: retarget the reviewer model and delete dead execution code
32209fa3 Slice 18: delete dead agent and subagent declarations
f474e2d4 Slice 16b: delete the dead standalone device-code poll entry point
89cbe9b6 Record the Slice 16 and 17 audit corrections
acaa65be Slice 17: delete the empty top-level resource chain and dead command residue
352d08ea Update the Phase 4 handoff after Slice 16
8a24bb73 Slice 16: delete the dead OAuth helper family
00c89f49 Slice 15c: finish the native host profile and record the re-audit
b20f559c Slice 15: collapse the native host profile
259fdb51 Slice 14b: collapse the invariant capability constants
b8b43b4a Slice 14a: remove unsupported CLI, main, and shared I/O branches
15e9dc75 Slice 13: remove unsupported workspace, image, and skill branches
520a069d Slice 12: remove unsupported host, terminal, and session branches
423414b9 Slice 11: remove unsupported MCP and tooling branches
bf936540 Slice 10: remove unsupported execution and process branches
```

Slices 0-9 precede those; `git log --oneline` has them. Each slice's evidence is
in its own commit message. Read the message before re-deriving anything.

## Current numbers

| Signal | Opening (`38496f4c`) | Now (`1230e87e`) |
| --- | --- | --- |
| main test binary | 7287 pass, 2 skip, 7289 total | 7234, 2, 7236 |
| lazy-analysis probe | 7791 total, 502 never analysed | 7744 / 498 at `b20f559c` |
| `zlint` | 0 errors, 111 warnings, 496 files | 0, **85**, 492 |
| `zig fmt --check src/` | clean | clean |
| `./scripts/smoke.sh` | ok | ok |

## The platform family is done

Slices 10-15c removed every reachable `.windows`, `.wasi`, `.emscripten`, and
`.freestanding` branch, collapsed `supports_headless_interrupt`,
`supports_resize_signal`, `supports_test_pty`, and `hasPosixArgVector`, deleted
`runtime_profile.zig` entirely, and cut `host.Capabilities` to the one field
that still varies. `REAUDIT.md` documents why the remaining `.windows` literals
in `src/` are explained rather than residue.

**The platform rule, for reference.** `build.zig` accepts only aarch64-macos,
x86_64-linux, aarch64-linux. `== .windows` / `== .wasi` are false, `!=` are
true, and `.macos` / `.linux` comparisons still vary and must be left alone.
Slices touching platform-conditional code must cross-build both Linux targets.

## Per-slice gate

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe --summary all
./scripts/smoke.sh
zlint
```

Plus the slice's own absence greps, and the two Linux cross-builds for any slice
touching platform-conditional code. Do not run `bun test`.

**Read test counts off the `+- run test ... pass, ... skip (... total)` line for
the main binary.** The `Build Summary` line aggregates a second one-test step and
is off by one. This has misled a delegate more than once.

**Grep `zig build test` output for `failed command:`.** The exit status lies — it
has printed that string while exiting 0.

**Run `zlint` bare from the repository root.** v0.9.1 silently lints zero files
when given a directory argument. Binary at `~/.local/bin/zlint`.

**`zlint` is a ratchet, not a ceiling.** It may never rise above what the
previous slice left. Each slice records the count it ends on.

Attribution: any formatting, build, unit-test, or smoke failure first seen after
a slice is caused by that slice until fixed or reverted.

## How to derive a removal surface

The scanner used for Slices 16 through 20 is at
`scratchpad/deadscan.py` in the session temp dir; rewrite it if lost. It strips
`test "..." { }` blocks by brace matching, then for every container-level
declaration counts references in the production text against references in the
full text, across all of `src/`. Run it per subsystem, it takes a few minutes.

```sh
python3 deadscan.py src/core/auth
```

`prod=0 test=0` is a clean kill. **`prod=0 test>0` is not.** Those split into
test fixtures supporting retained tests, which must stay, and production-shaped
functions only tests reach, which are candidates. Read each one. Slice 4 nearly
deleted a family that about twenty retained tests were asserting through.

`zlint --format json` gives the machine-readable `unused-decls` list, which is a
different and narrower signal: it only catches unreferenced container-level
declarations, not chains that are dead as a whole.

## Working with the Cursor delegates

Demolition goes to `composer-2.5` via `cursor_run`, `capability: "write"`,
`isolation: CallerProvided` at the repo root, in the background. What works:

- Name every site by file and line, and state each one's shape.
- State the stop condition and tell it to verify rather than trust you.
- Say explicitly what to retain, not just what to delete, with the evidence.
- Warn about `if` polarity every time, and separate the `==` sites from the `!=`
  sites in the brief. Mixing both without flagging it is how Slice 5 broke.
- Give a specific numeric expectation for the test count, including when it
  should not move, so a surprise is visible to both of you.
- Tell it not to hand-roll brace matching in a script.

Verify the diff yourself before committing.

**Check your own brief too.** Slice 5's brief told the delegate that removing a
`@hasField` read left `"/v1/models"`; that was the `else` arm, production took
the `then` arm, and the delegate faithfully changed live behaviour. Slice 9's
brief claimed every caller passed null for a parameter; five did not, and the
delegate was right.

## Standing traps

**Zig never analyses an unreferenced container-level declaration.** A green build
does not prove a deleted symbol has no remaining callers. Grep every name.

**One test compiles the tree a second time.** `assistant_stream.zig`'s
"streamed presentation preserves ANSI OSC 8 code fence and table spans" runs
`zig test -lc -Mroot=src/main.zig` as a child and asserts it exits 0. Anything
that modifies `src/main.zig` breaks that child, because raw `zig test` does not
supply the generated `build_options` module. The probe does exactly that. This
cost three flips of the same claim before it was understood.

**About 498 tests never run under `zig build test`.** Lazy analysis: files whose
only `@import` sits in a function body nothing analyses. `benchmark_exports.zig`
and `terminal_client_fixture.zig` are genuinely never imported.

**Killing a `bun test` run leaves processes alive.** `tmux kill-server` and
`pkill -f zig-out/bin/fiber`.

## The probe

Run at checkpoints and at phase exit, never committed:

```sh
{ echo 'const std = @import("std");'
  git ls-files 'src/**/*.zig' \
    | sed 's|^src/||; s|.*|test { std.testing.refAllDecls(@import("&")); }|'
} > src/zz_refall_probe.zig
printf '\ntest { _ = @import("zz_refall_probe.zig"); }\n' >> src/main.zig
zig build test -Doptimize=ReleaseSafe
git checkout src/main.zig && rm src/zz_refall_probe.zig
```

Must run through `zig build`, not `zig test`. Takes several minutes; run it in
the background and check `git status` afterwards, since a killed run leaves both
files behind.

**Expected: no failure except the OSC 8 meta-test, which the probe breaks by
construction.** That failure is not a signal.

## Decisions standing without the owner

Ratified 2026-09-05: E2E is out of Phase 4 entirely (Phase 5 owns rewiring the
harness onto Codex), and the Slice 0 gate repair stands. The owner authorised
autonomous execution: route around anything needing a decision, record it, and
stop only if everything is blocked.

**All resolved by the owner on 2026-09-05:**

- **Decision 5** — delete the device-code OAuth chain. **The evidence behind the
  question was wrong and the scope was corrected before acting.**
  `LoginPollDeps`, `LoginPollState`, and `realPollDeviceToken` are live:
  `chatgpt_oauth.zig:80` injects `pollBrowserToken` into the polling machinery
  rather than bypassing it. Only `pollForTokenWithDeps` was dead. Shipped as
  Slice 16b, 145 lines, not the 300-400 first claimed.
- **Decision 6** — neither blocker nor target. A dedicated end-of-phase slice
  categorizes each remaining `zlint` warning and resolves it individually.
  Added to the inventory as **Slice 28**.
- **Decision 7** — leave `admitChildPermission` and its test alone. The `.yolo`
  default note stands as an observation for outside Phase 4.

Earlier: decision 4 keeps `buildAgentRequest` and `provider_bundle`; decision 3
is withdrawn; `CORRECTIONS.md` records that merged-settings `credential_source`
is parsed and never read, deferred to Slice 25 or 27 as a product decision.

## Next actions

1. **Slice 21**, terminal and session. Scans of `src/core/terminal` and
   `src/core/session` were running when this was written; rerun them.
   **This slice has the tightest retention rule in the series:** stop if a
   candidate participates in serialization, hashing, authority checks, or
   recovery of a retained record. Those touch persisted session data that must
   stay readable.
2. Slices 22-25, each with its surface re-derived before it opens. `REAUDIT.md`
   lists the merges worth making by subsystem.
3. Slice 26, the implementation-seam audit. It inherits three measurements:
   `host.Capabilities.terminal` from Slice 15c, the model-catalog field question
   from Slice 16, and `LoginPollDeps.poll_device_token` from Slice 16b, a
   defaulted function pointer with one overriding caller.
4. Slice 27, the final sweep. Also owns retargeting the
   `"moonshotai/kimi-k3"` fixture data at `app_render_runtime.zig:3395-3397`.
5. **Slice 28**, the zlint categorization slice the owner added. 85 warnings
   remain, down from 111; the deletion slices have been clearing them as a side
   effect.
6. Phase exit criteria are at the bottom of `simplification-inventory.md`.

## What the last five slices established about the inventory

**It is a good map of where dead code lives and an unreliable one of what is
dead.** Re-derive every surface before opening a slice. So far:

- Slice 16's model-catalog half: 0 dead of 41 declarations scanned.
- Slice 17's headline claim, dead re-exports across three builtins files: 20 of
  22 have real callers, up to 774. Two of its rows named symbols that do not
  exist in the tree.
- Slice 16's "retain polling" instruction pointed at code that was partly dead.
- Slice 19's Kimi row was correct and precise.

All retractions are written into `CORRECTIONS.md` rather than skipped, because
phase exit requires every audit row to be explicitly resolved.

## Two near-misses worth not repeating

Both were caught before shipping, both were the same failure: **a grep or a scan
answered a narrower question than the claim being made.**

1. The declaration scanner reports references to a *name*, not reachability.
   `pollForTokenWithDeps` having no production caller does not make
   `LoginPollDeps` dead. Dependency injection makes a chain look dead from its
   default entry point while production reaches it through an injected callback.
   A defaulted function pointer's only reference is its own field initialiser,
   which reads as dead while the field is live.
2. A `grep | head -12` truncated away the MCP PKCE call sites and briefly made
   it look like MCP ran an OAuth authorization-code flow without PKCE. It does
   not: `code_challenge` with `S256` at `mcp_auth.zig:1541`, verifier at
   `:1652`.

Before writing a claim of the form "X is dead" or "Y is missing", run the
un-truncated grep for every name in the chain.
