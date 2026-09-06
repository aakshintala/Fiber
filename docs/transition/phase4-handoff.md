# Handoff: Fiber Phase 4 simplification

Rewritten 2026-09-06 after Slice 25. Supersedes every earlier copy.

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

Slices 0 through 25 are committed on `main`. The working tree is clean.

```
3fe15777 Slice 25: collapse one-value and always-true residue
6d4cba8e Slice 24b: collapse the cooperative live-session transition
f6431873 Slice 24a: delete dead app-runtime declarations
9c2b3625 Record the declaration scanner's nested-declaration blind spot
01ad3a6e Slice 23: delete dead skill, filesystem, tooling, and shared helpers
67f50729 Record the Slice 21 and 22 audit findings
f5cdc9d8 Slice 22a: collapse the dead subagent body mode and delete unreferenced UI declarations
83aa7171 Slice 21: delete dead terminal and session code
2281b408 Fix stale references in the Phase 4 handoff header
c5133dfa Update the Phase 4 handoff after Slice 20
1230e87e Slice 20: delete dead MCP declarations
4ce80e1d Slice 19: retarget the reviewer model and delete dead execution code
32209fa3 Slice 18: delete dead agent and subagent declarations
f474e2d4 Slice 16b: delete the dead standalone device-code poll entry point
```

Slices 0-9 precede those; `git log --oneline` has them. Each slice's evidence is
in its own commit message. Read the message before re-deriving anything.

## Current numbers

| Signal | Opening (`38496f4c`) | Now (`3fe15777`) |
| --- | --- | --- |
| main test binary | 7287 pass, 2 skip, 7289 total | **7226, 2, 7228** |
| lazy-analysis probe | 7791 total, 502 never analysed | 7744 / 498 at `b20f559c` |
| `zlint` | 0 errors, 111 warnings, 496 files | 0, **71**, 492 |
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

**Use `scratchpad/deepscan.py`, not `fastscan.py`.** Both count references the
same way and both were validated byte-identical to the original `deadscan.py` on
three subsystems. The difference is which declarations they enumerate.

The original regex was anchored at column 0. Fiber writes most of its runtime as
methods inside `pub fn Runtime(comptime App: type) type { return struct { ... } }`
generics and inside `pub const Foo = struct { ... }`, all indented, so Slices 16
through 23 measured roughly a quarter of the real surface. Allowing `^[ \t]*`
raised `src/core/app` from 1,416 declarations to 5,569 and its clean kills from
8 to 32. Nothing those slices deleted was wrong; they were just incomplete.

```sh
python3 deepscan.py src/core/auth      # a subsystem
python3 deepscan.py src                # whole tree, about 2 seconds
```

It rewrites the old scanner's O(decls x files x filesize) loop into a single
tokenizing pass, so a whole-tree scan takes ~2s instead of ~3 minutes per
subsystem. Re-derive after every slice: deletions cascade, and a helper whose
last caller you just removed only shows up on the next run.

`prod=0 test=0` is a clean kill. **`prod=0 test>0` is not.** Those split into test
fixtures supporting retained tests, which must stay, and production-shaped
functions only tests reach, which are candidates. Read each one. Slice 4 nearly
deleted a family that about twenty retained tests were asserting through, and
Slice 22 found that most of `src/ui`'s remaining population is convenience
wrappers and test instruments rather than dead code.

**Two things the scan cannot see, both hit in Slice 24.** A mutually-referential
cluster never reports as dead, because each member is referenced by the others --
`ApprovalOwnershipBinding` and `ApprovalOwnershipSubagents` had to be read, not
measured. And a symbol reached only through `@hasDecl(App, "name")` is safe *only*
because the tokenizer scans raw text including string literals; keep it that way.

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

Copy the scanners out of the session scratchpad before they vanish:
`deepscan.py` (use this) and `fastscan.py`. Rewrite from the description above
if lost.

1. **Slice 26**, the implementation-seam audit. It now inherits five
   measurements, three of them found tonight:
   - `host.Capabilities.terminal` (Slice 15c)
   - the model-catalog field question (Slice 16)
   - `LoginPollDeps.poll_device_token`, a defaulted function pointer with one
     overriding caller (Slice 16b)
   - **the subagent relationship index** (Slice 21): production reads
     `relationship-index.bin` at `session_store.zig:3053` but the only writer in
     the repository is a test fixture. `encodePage` has no reference at all.
   - **`reportTurnControl`** (Slice 23): production wires up `turn_control_sink`
     and the orchestrator acts on the result at `orchestrator.zig:8485`, but no
     tool ever calls the reporter, so `turn_control` is always null and that
     branch never runs.
2. **Slice 27**, the final sweep, and it is now the big one. The deep scanner
   finds **116 clean kills tree-wide**; Slice 24 took the 32 in `src/core/app`,
   leaving ~84 across subsystems earlier slices had closed -- 14 in
   `src/core/session`, 12 in `src/core/auth`, 9 at the `src/` root, 6 each in
   `src/ui/transcript` and `src/core/mcp`, and a long tail. Re-scan before
   starting; the number moves as slices land. Slice 27 also still owns
   retargeting the `"moonshotai/kimi-k3"` fixture data at
   `app_render_runtime.zig:3395-3397`.
3. **Slice 28**, the zlint categorization slice the owner added. 71 warnings
   remain, down from 111.
4. Re-run the lazy-analysis probe at phase exit; its numbers are stale from
   `b20f559c`.
5. Phase exit criteria are at the bottom of `simplification-inventory.md`.

**Two questions need the owner, neither blocking:**

- The `src/ui` convenience-wrapper family (Slice 22, recorded in
  `CORRECTIONS.md`). About twenty non-interruptible wrappers over interruptible
  implementations, plus `buildInputLine` and `inlineApprovalPanelRows`.
  Production calls the interruptible form; tests call the simple twin. Deleting
  them removes no dead weight, it just forces every test to thread an extra
  `null`. Style call, not cleanup.
- The two "parsed but never read" findings,
  `oauth.Metadata.revocation_endpoint` and merged-settings `credential_source`.
  Both are inert behind retained seams. Whether the second is a bug is a product
  question.

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
