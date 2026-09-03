# Fiber identity inventory (Phase 2)

Scope: the rename described in "Establish the Fiber identity" in
[`../ideas/fiber-product-transition.md`](../ideas/fiber-product-transition.md).
No compatibility aliases, no fx state reads, no migration.

This is a light inventory. Unlike demolition, the surface is fully enumerable by
exact search, so it lists slices, searches, and stop conditions rather than a
classification matrix.

## Measured surface at `3128d515`

| Class | Count | Location |
| --- | --- | --- |
| Files containing `fx` | 322 | excludes `zig-out` |
| `FX_*` references | ~2,540 | src 161, tests 2,144, scripts 78, benchmarks 35, workflows 11, docs 7 |
| Distinct `FX_*` names read by `src/` | 97 | mostly `FX_TERMINAL_TEST_*` fixtures |
| `fx` tokens in `src/**/*.zig` | ~1,500 | ~150 files |
| `fx` tokens in `tests/` | ~5,085 | 70 files reference `FX_` |
| `zig-out/bin/fx` references | 16 files | tests, scripts, benchmarks, docs |

Already complete: `NOTICE` carries the fork-point attribution, and
`scripts/smoke.sh:7` already resolves `zig-out/bin/fiber` before
`zig-out/bin/fx`, so it needs no change at the cutover.

## Hazard classification

Renames divide into two classes, and the slice order exists to keep them apart.

**Silent renames** compile clean and change runtime or on-disk behavior. Each one
invalidates state, a wire format, or model input. These are hand-edited, never
sed'd, and each needs a runtime check beyond `zig build test`.

| Item | Location | Effect of rename |
| --- | --- | --- |
| `root_dir_name = ".fx"` | `src/core/shared/profile_paths.zig:5` | orphans settings, ChatGPT auth, sessions, recordings, prompt history, MCP credentials |
| `.fx.json` project config | 29 references | project configuration stops resolving |
| `FX_MCP_OAUTH_CREDENTIALS_V1` | `src/core/hosts/native_keychain.zig:8` | forces fresh MCP OAuth |
| Codex session Keychain service | `src/core/auth/chatgpt_session.zig` | forces fresh Codex authentication |
| `FXRPLY01` | `command_replay_store.zig:13` plus 5 literal copies in `session_store.zig` and `app_session_runtime.zig` | command replay files unreadable |
| `fx-permission-state-v*` | permission state persistence | saved permission state unreadable |
| `fx.shared_model_context.v*` | subagent relationship index | index signature mismatch |
| `<fx-turn-context>` | `src/builtins/context.zig:1940` and injection-escaping tests | changes prompt text sent to the model |
| `@fx-terminal-env:` | `src/core/execution/command_environment.zig:35` | permission identity prefix |
| `/tmp/fx-terminal-*` socket and bootstrap paths | `core/terminal/host.zig:139`, `native_session.zig:2183`, `tmux_session.zig:2694` | terminal host handshake |
| `--fx-internal-terminal-*` | 14 references, embedded in a generated shell bootstrap string | re-exec handoff; review the bootstrap string by hand |

**Inert renames** are identifiers, help text, fixture filenames, and
documentation. Mechanical replacement, verified by a residual-count search.

## Environment variable notes

- 97 distinct `FX_*` names are read by `src/`. Most are `FX_TERMINAL_TEST_*` and
  `FX_E2E_*` fixtures, which are retained behavior and get renamed, not deleted.
- `FX_GATEWAY_BASE_URL`, `FX_GATEWAY_CHAT_URL`, and `FX_E2E_GATEWAY_CHAT_URL`
  have zero readers in `src/`. They survive only in the 40 fake-Gateway test
  files that Phase 5 converts or deletes. Leave them; do not rename dead strings
  in files scheduled for conversion.
- `FX_E2E_GATEWAY_MODELS_URL` is still read by `src/` and is held until Phase 5
  by the demolition inventory. Rename it; do not remove it.
- `FX_AUTO_UPGRADE` has zero readers in `src/` after Slice 19. Delete its
  remaining test and script references rather than renaming them.
- Test-side env renames land in the same slice as the `src/` side. E2E does not
  run in the transition gate, so a split slice would leave a silent mismatch for
  Phase 5 to mistake for real breakage.

## Slices

One slice at a time on `main`, one commit each, per `AGENTS.md`. Gate for every
slice: `zig fmt --check src/`, `zig build -Doptimize=ReleaseSafe`,
`zig build test -Doptimize=ReleaseSafe`, the slice's exact searches, and
`./scripts/smoke.sh`.

### S1: executable and build wiring

`build.zig` executable name and install path, `build.zig.zon`, the 16
`zig-out/bin/fx` references, `FX_BIN` in `tests/evals/eval-helpers.ts:15`,
workflow artifact names, `scripts/pgso` artifact paths.

First, because every later slice's gate runs the built binary.

Stop condition: `zig build` produces `zig-out/bin/fiber` and `smoke.sh` passes
against it with no argument.

### S2: environment variables

`FX_*` to `FIBER_*` across `src/`, `tests/`, `scripts/`, `benchmarks/`,
`.github/`, and docs, subject to the notes above.

Stop condition: `rg -o 'FX_[A-Z0-9_]+' --glob '!zig-out'` returns only names in
the fake-Gateway files listed by
`rg -l 'startFakeGateway|FAKE_GATEWAY_MODEL|/v3/ai/language-model|/v1/generation' tests/e2e`.

### S3: state root and project configuration

`profile_paths.root_dir_name`, `.fx.json` to `.fiber.json`, and every test
fixture that constructs a fake home.

Stop condition: `rg -n '"\.fx"|\.fx\.json|~/\.fx' --glob '!zig-out'` returns only
historical references in `CHANGELOG.md` and the transition documents.

The owner's live `~/.fx` becomes unreachable at this slice. Copy any wanted
`settings.json` values aside before it runs. Fresh authentication is required
afterward by design.

### S4: credentials

MCP OAuth and Codex session Keychain service names, plus
`FX_TEST_MCP_OAUTH_CREDENTIALS_V1`.

Stop condition: `fiber mcp login` and Codex authentication both complete against
the renamed services on a clean Keychain entry.

### S5: internal formats and runtime paths

`FXRPLY01`, the permission-state signature, the shared model context signature,
`<fx-turn-context>`, `@fx-terminal-env:`, `/tmp/fx-terminal-*`, and the
`--fx-internal-terminal-*` flags including the generated bootstrap string.

Hand-edited. The one slice that is not a mechanical replacement.

Stop condition: a real terminal-host command runs end to end, a session saves and
resumes, and permission state persists across a restart.

### S6: product text and protocol identity

CLI help and usage strings, ACP `initialize` metadata, the shared HTTP client
identity and user agent, error and log strings.

Stop condition: `fiber --help`, `fiber status`, `fiber doctor`, and an ACP
`initialize` response contain no fx product text.

### S7: identifiers and fixtures

`SkillSource.global_fx` and `workspace_fx`, `fx_dir`, `fx_path`, `fx_version`,
`fx_search`, module and file names, and fixture filenames such as
`fx-path-fixture.txt`, `fx-test-strategy`, `fx-command-replay.bin`.

Inert. Largest diff, lowest risk.

### S8: documentation and changelog

`README.md`, `CONTRIBUTING.md`, `AGENTS.md` binary references, and resetting
`CHANGELOG.md` to a Fiber release line. Preserve `NOTICE`, the fork attribution,
and unavoidable historical records.

`AGENTS.md` process rewriting stays in Phase 6; this slice only fixes binary and
path references that S1 through S7 falsify.

## Phase exit

`zig build` produces `fiber`, the deterministic Zig suite passes, `smoke.sh`
passes, and an exact search for `fx` across the tree returns only:

- attribution in `NOTICE`, `README.md`, and `LICENSE`
- historical `CHANGELOG.md` entries preceding the Fiber release line
- the transition documents under `docs/`
- dead strings inside the fake-Gateway test files owned by Phase 5

Anything else is either renamed or explicitly reclassified into a later phase
with exact path and symbol evidence.
