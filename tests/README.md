# TypeScript test suites


Two test suites live under `tests/`, both using Bun:

## `tests/evals/` — LLM Evals

Eval scenarios that exercise the agent through `fiber ask --json`. Require `AI_GATEWAY_API_KEY`.

```bash
cd tests/evals && bun install && bun test           # run all evals
cd tests/evals && bun run eval:matrix               # cross-model matrix run
```

## `tests/e2e/` — End-to-End Tests

Deterministic runtime tests (CLI commands, TUI via tmux). No API key needed for most.

```bash
cd tests/e2e && bun install && bun test              # run all e2e tests
cd tests/e2e && bun test cli.test.ts                 # just CLI tests
cd tests/e2e && bun test tui-*.test.ts               # just TUI tests (requires tmux)
```

TUI tests use tmux to drive the interactive terminal. They require `tmux` to be installed.

