# Re-audit checkpoint, after Slice 15

Run at `b20f559c`, after the platform family (Slices 10-15) and before the
dead-code series at Slice 16. Required by `simplification-inventory.md`.

## Numbers

| Signal | Opening (`38496f4c`) | Slice 14 (`259fdb51`) | Now (`b20f559c`) |
| --- | --- | --- | --- |
| main test binary | 7287 pass, 2 skip, 7289 total | 7245, 2, 7247 | 7244, 2, 7246 |
| lazy-analysis probe | 7791 total | 7746 total | 7744 total |
| never analysed | 502 | 499 | 498 |
| `zlint` | 0 errors, 111 warnings, 496 files | 0, 109, 493 | 0, 108, 492 |

The probe's only failure in every run is the OSC 8 meta-test, which the probe
breaks by construction. See `phase4-baseline.md`.

**The unreached-test count barely moved while the gate lost 43 tests.** The
lazy-analysis gap is structural, not something these slices are widening.

## Unsupported-target searches

`git grep -n -E '\.windows|\.wasi|\.emscripten|\.freestanding' -- src/ benchmarks/ tests/ build.zig`

Every remaining hit under `src/` is one of two explained kinds. No unexplained
hits remain.

### Kind 1: `else`-arm coverage for functions that still vary

`clipboardCommand`, `launchUrl`, and `command_effect.plan` take an
`os_tag: std.Target.Os.Tag` parameter and have real, differing `.macos` and
`.linux` arms. Zig requires the switch to be exhaustive over `Os.Tag`, so each
keeps an `else` arm; production reaches it never, because production passes
`builtin.os.tag`.

The tests at `native.zig:257`, `url_opener.zig:125`, and
`command_effect.zig:1266` pass `.windows` to reach that `else` arm. They assert
that retained scaffolding still works, not that a deleted product still works.
Deleting them would remove coverage without removing code.

Same argument for the `os_tags` arrays at `terminal/host.zig:1572`,
`terminal/native_session.zig:269`, and `tooling/tool_dispatch.zig:1513`, which
assert two capability helpers agree across the tag space.

`command_effect.ApprovalReason.unsupported_platform` is retained on the same
basis: one producer at `command_effect.zig:313`, the `else` arm of a live
function, and the test above is its only coverage.

### Kind 2: out of scope for Phase 4

`tests/e2e/fixtures/mcp-stdio-dispatcher-driver.zig` lines 322, 2017, 2043.
E2E was dropped from Phase 4 by owner ratification on 2026-09-05; Phase 5 owns
rewiring that harness.

## Host capability measurement

`host.Capabilities` has four fields. Production consumers, measured by grep
across all of `src/`:

| Field | Production consumers | Varies across the 3 targets |
| --- | --- | --- |
| `process_control` | 1, `tools/shell/process_provider.zig:230` | no, always true |
| `url_open` | **0** | no, always true |
| `native_url_open` | 1, `core/auth/login_flow.zig:607` | **yes**, macOS only |
| `terminal` | via `ToolCapabilities.for_host` | no, always `.supported` |

`url_open` is dead and `process_control` is a constant-true field with a single
reader whose guard can never fire. Both are Slice 15c.

`terminal` is **not** collapsed. `tool_dispatch.DispatchContext` defaults
`tool_capabilities` to `.{}`, which means `.terminal = .unsupported`, and
production overrides it through `for_host`. The field therefore has real runtime
variation, and `terminalAvailable()` gates a user-visible
`terminal_unavailable_message`. Whether that seam should exist at all is a
Slice 26 question, with this measurement as its input.

`native_url_open` is retained outright. It is the one host capability that still
differs between two supported targets.

## Slice 15c

Slice 15 was under-scoped: `host.nativeForOs` is the native host profile just as
`runtime_profile.native` was, and it is generic over `Os.Tag` only so tests can
feed it foreign tags. Closing that:

- delete `Capabilities.url_open`, zero consumers
- delete `Capabilities.process_control` and the dead guard in `process_provider`
- delete the redundant BSD arms in `shell_runtime.vminIndex` / `vtimeIndex`,
  which duplicate their own `else`

## Effect on Slices 16-27

Re-derive each removal surface against the collapsed tree before opening it. The
platform family deleted roughly 154 unsupported-target sites and 31
`runtime_profile` sites and orphaned code no earlier slice could see.

Merges to make, by subsystem:

- **16 and 26** overlap on the auth and model-catalog seam. 26's model-catalog
  retention rule (`modelProviderRank`, `modelTierRank`,
  `featured_picker_families`, `ModelProviderFilter`) already constrains 16.
- **19, 20, 21** each carry their own retention lists that survive the collapse
  unchanged. Keep separate.
- **22** grew: Slice 14b already deleted the non-signal resize fallback, so the
  resize-reflow surface is smaller than written.
- **25** absorbs the constant-field residue this phase created, alongside the
  `credential_source` finding in `CORRECTIONS.md`.

`zlint` must reach **zero** `unused-decls` warnings at phase exit. It is at 108.
That is the largest single gap remaining and no slice currently names it as its
own deliverable; Slice 27 inherits it by default. Worth confirming with the owner
whether 108 warnings is a phase-exit blocker or a target.
