# TypeScript test suites

One test suite lives under `tests/`, using Bun:

## `tests/e2e/` — End-to-End Tests

Deterministic runtime tests (CLI commands, TUI via tmux). No API key needed for most.

```bash
cd tests/e2e && bun install && bun test              # run all e2e tests
cd tests/e2e && bun test cli.test.ts                 # just CLI tests
cd tests/e2e && bun test tui-*.test.ts               # just TUI tests (requires tmux)
```

TUI tests use tmux to drive the interactive terminal. They require `tmux` to be installed.

A few `*-live.test.ts` files exercise real network or model credentials. They
skip unless explicitly opted in (`FIBER_E2E_REAL_API=1` for source context
limits, `FIBER_WEB_FETCH_LIVE=1` for public-URL fetching).

The former LLM eval suite was deleted (see #51); its salvaged
failure-mode ledger lives at `docs/agent-failure-modes.md`.
