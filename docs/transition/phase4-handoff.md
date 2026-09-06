# Handoff: Fiber Phase 4 simplification

Rewritten 2026-09-05 after Slice 9. Supersedes every earlier copy. The version
before this one told you to run the lazy-analysis probe as the next action and
asserted a test failure that does not exist. Do not work from it.

## Read first

1. `docs/transition/phase4-baseline.md` — baseline, gate repair, probe result
2. `docs/transition/phase4-audit/OWNER-QUESTIONS.md` — decisions taken without
   the owner; decision 3 is **withdrawn**, read why before trusting anything
   about the probe
3. `docs/transition/simplification-inventory.md` — the ordered slices
4. `docs/transition/phase4-audit/CORRECTIONS.md` — retention decisions, with two
   new entries from this session at the bottom

`REPORT.md` is raw evidence only. Its arithmetic holds; its scope and triage do
not.

## Where the work stands

Slices 0 through 9 are committed on `main`. **Slice 10 is in flight and
uncommitted** — see "Resuming Slice 10" below.

```
b99e6d9e Slice 9: close provider-selection discards
4d21a67e Slice 8: remove workspace_clean completely
1f3101dc Slice 7: remove deleted-product one-value residue
a14d5cf2 Withdraw decision 3: the probe's only failure was the probe's own doing
ac2853e8 Slice 6: remove the detached stream-flush switch
fbaa2d31 Slice 5: remove the unreachable Fiber search backend
9bc41a85 Slice 4: delete the dead request builders and legacy completion parser
2ea9c688 Narrow Slice 4: the fake-gateway request serialiser is not dead
b6e1bc0f Slice 3: flatten the OAuth transport wrapper
8d7764de Slice 2: remove deleted-host tool completion and sandbox residue
a346c276 Slice 1: restrict builds and CI to supported targets
2f42167c Slice 0: record the lazy-analysis probe result
38496f4c Slice 0: record the Phase 4 baseline, drop E2E from the gate
```

Each slice's evidence is in its own commit message. Read the message before
re-deriving anything about that slice.

## Current numbers

| Signal | Opening (`38496f4c`) | Now (`b99e6d9e`) |
| --- | --- | --- |
| main test binary | 7287 pass, 2 skip, 7289 total | 7245 pass, 2 skip, 7247 total |
| `zlint` | 0 errors, 111 warnings, 496 files | 0 errors, 109 warnings, 493 files |
| `zig fmt --check src/` | clean | clean |
| `./scripts/smoke.sh` | ok | ok |

## Resuming Slice 10

A Cursor `composer-2.5` job was mid-run at handoff, editing three files:

```
src/core/execution/command_runner.zig
src/core/execution/process_tree.zig
src/core/permissions/direct_command.zig
```

Check `git status` first.

- **Dirty tree, plausible diff:** review it against the rule below, run the full
  gate plus both Linux cross-builds, then commit as Slice 10.
- **Dirty tree, incoherent diff:** `git checkout --` those three files and
  redelegate. Nothing else depends on partial work.

Slice 10's proof is that `grep -n "windows\|wasi"` returns nothing in those three
files, and that `zig build -Dtarget=x86_64-linux` and `-Dtarget=aarch64-linux`
both still build.

## The platform rule — slices 10 through 15 all depend on it

Slice 1 restricted the project to **aarch64-macos, x86_64-linux, aarch64-linux**.
`build.zig` rejects everything else before configuring. So:

- `builtin.os.tag == .windows` → always **false**, delete the branch
- `builtin.os.tag == .wasi` → always **false**, delete the branch
- `!= .windows`, `!= .wasi` → always **true**, unwrap and propagate
- `== .macos`, `!= .macos`, `== .linux`, `!= .linux` → **still vary, leave alone**

macOS and Linux are both supported. A branch distinguishing them is live. Getting
this backwards silently breaks process groups, signals, or descendant cleanup on
a platform the local test run cannot exercise, which is why every slice in this
family must cross-build both Linux targets, not just build natively.

Architecture is `x86_64` and `aarch64` only; any other `builtin.cpu.arch` branch
is dead by the same rule.

## Per-slice gate

```sh
zig fmt --check src/
zig build -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe --summary all
./scripts/smoke.sh
zlint
```

Plus the slice's own absence greps, and for slices 10-15 the two Linux
cross-builds. Do not run `bun test`.

**Read test counts off the `+- run test ... pass, ... skip (... total)` line for
the main binary.** The `Build Summary` line aggregates a second one-test step and
is off by one. This has misled a delegate more than once.

**Grep `zig build test` output for `failed command:`.** The exit status lies —
it has printed that string while exiting 0.

**Run `zlint` bare from the repository root.** v0.9.1 silently lints zero files
when given a directory argument. The binary is at `~/.local/bin/zlint`.

**`zlint` is now a ratchet, not a ceiling.** It may never rise above what the
previous slice left, and each slice records the count it ends on in its commit
message. A fixed ceiling let Slice 2's orphaned alias hide inside slack; the
count has since fallen to 109, so a ceiling of 111 would now hide two.

Attribution: any formatting, build, unit-test, or smoke failure first seen after
a slice is caused by that slice until fixed or reverted.

## Working with the Cursor delegates

Demolition slices go to `composer-2.5` via `cursor_run`, `capability: "write"`,
`isolation: CallerProvided` at the repo root, in the background. The pattern that
has worked:

- Name every site by file and line, and state what each one's shape is.
- State the stop condition and tell it to verify rather than trust you.
- Say explicitly what to retain, not just what to delete.
- Warn about `if` polarity every time. A condition that is always false means the
  `else` survives; `if (!always_false)` means the `then` survives.
- Tell it which test-count line to read.

Verify the diff yourself before committing. Delegates have, in this session:
reported pre-change test counts as post-change; left an orphaned alias that
tripped zlint; dropped an assertion from a retained test; and left a discarded
`_ = ctx` parameter behind. All were caught in review. None were wrong about the
deletion itself.

**Check your own brief too.** Slice 5's brief told the delegate that removing a
`@hasField` read left `"/v1/models"` — that was the `else` arm; production took
the `then` arm and used `""`. The delegate followed instructions and changed live
behaviour. Slice 9's brief claimed every caller passed null for a parameter; five
did not, and the delegate said so.

## Standing traps

**Zig never analyses an unreferenced container-level declaration.** A green build
does not prove a deleted symbol has no remaining callers. Grep for every name.

**One test compiles the tree a second time.** `assistant_stream.zig`'s
"streamed presentation preserves ANSI OSC 8 code fence and table spans" is a
meta-test: it runs `zig test -lc -Mroot=src/main.zig --test-filter <its own
name>` as a child process and asserts the child exits 0. Anything that modifies
`src/main.zig` breaks that child, because raw `zig test` does not supply the
generated `build_options` module. The lazy-analysis probe does exactly that. This
cost three flips of the same claim before it was understood; see
`phase4-baseline.md`.

**502 tests never run under `zig build test`.** The probe measured 7791 against
7289 at baseline. The cause is Zig's lazy analysis — files whose only `@import`
sits in a function body nothing analyses. Two files under `src/` are genuinely
never imported: `benchmark_exports.zig` and `terminal_client_fixture.zig`.

**Killing a `bun test` run leaves processes alive.** `tmux kill-server` and
`pkill -f zig-out/bin/fiber`.

## The probe

Run at the re-audit checkpoint and at phase exit, never committed:

```sh
{ echo 'const std = @import("std");'
  git ls-files 'src/**/*.zig' \
    | sed 's|^src/||; s|.*|test { std.testing.refAllDecls(@import("&")); }|'
} > src/zz_refall_probe.zig
printf '\ntest { _ = @import("zz_refall_probe.zig"); }\n' >> src/main.zig
zig build test -Doptimize=ReleaseSafe
git checkout src/main.zig && rm src/zz_refall_probe.zig
```

It must run through `zig build`, not `zig test`. It takes several minutes; run it
in the background. Check `git status` afterwards — a killed run leaves both files
behind.

**Expected result: no failures except the OSC 8 meta-test, which the probe breaks
by construction.** That one failure is not a signal.

## Decisions standing without the owner

Ratified by the owner on 2026-09-05: E2E is out of Phase 4 entirely (Phase 5 owns
rewiring the harness onto Codex), and the Slice 0 gate repair stands. The owner
also authorised autonomous execution: route around anything needing a decision,
record it in `OWNER-QUESTIONS.md`, and stop only if everything is blocked.

Open entries added this session:

- **Decision 4** — Slice 4 keeps `buildAgentRequest` and `provider_bundle`
  against the inventory's removal surface. They are test-only but not dead;
  about twenty retained tests assert on captured request bodies.
- **Decision 3 is withdrawn.** No decision was needed.
- `CORRECTIONS.md` records that the merged-settings `credential_source` is now
  parsed and never read — a user setting with no effect. Not fixed: it sits on
  the persisted-config boundary, so removing the key is a product decision. Slice
  26 or 27 owns it and the analysis is already written down.

## Next actions

1. Resolve Slice 10 per "Resuming Slice 10" above.
2. Slices 11 through 15, one at a time, one commit each, all under the platform
   rule. 11 is MCP and tooling, 12 host/terminal/session, 13
   workspace/image/skill, 14 CLI/UI/main/shared I/O, 15 collapses the native host
   profile.
3. **The re-audit checkpoint** at `simplification-inventory.md:436`. Run the
   probe and `zlint`, compare against this file's numbers, and re-audit before
   starting the deletion slices at 16.
