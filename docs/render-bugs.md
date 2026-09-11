# Reproducing render bugs


fiber's rendering is inline by default and deliberately emits a small ANSI subset. Three owner classes are the narrow exceptions, and each takes the alternate buffer exclusively through `AlternateScreenOwner` in `src/ui/shell_runtime.zig`: interactive permission review, the full-transcript screen, and catalog menus. Only one class may own the buffer at a time, and each must leave it and restore the main grid, composer, cursor, paste, mouse, focus, and keyboard modes when it closes. Transcript rendering, question prompts, command-output expansion, and subagent delegation remain inline. Three tools exist for reproducing and regression-proofing render bugs:

## tmux (live TTY repros)

Best for resize and SIGWINCH interactions. The helper in `tests/e2e/tmux-helpers.ts` exposes `resizeWindow(cols, rows)`, `capturePaneGrid()`, and `capturePaneEscapes()`. See `tests/e2e/tui-resize.test.ts` for the canonical resize matrix.

```bash
cd tests/e2e && bun test tui-resize.test.ts
```

## Debug terminal recording and replay

Set `FIBER_DEBUG_RECORD=1` to create an automatic private tape under
`~/.fiber/recordings/`. Set `FIBER_DEBUG_RECORD_SILENT_BANNER=1` as well when the
developer-only recording notice must stay out of the inline transcript during
a screen share. The notice remains available in the Ctrl+O full transcript.
Use `FIBER_RECORD=<path>` when a test or investigation needs an exact destination.
Recording dumps every byte fiber writes and every resize into a framed binary tape.
Replay the tape through the built-in virtual terminal:

```bash
FIBER_DEBUG_RECORD=1 ./zig-out/bin/fiber
FIBER_RECORD=/tmp/bug.fxtape ./zig-out/bin/fiber
./zig-out/bin/fiber replay /tmp/bug.fxtape
./zig-out/bin/fiber replay /tmp/bug.fxtape --frames
./zig-out/bin/fiber replay /tmp/bug.fxtape --json
./zig-out/bin/fiber replay /tmp/bug.fxtape --golden out.txt
```

The tape is deterministic — any reviewer can replay it without a TTY, and a golden file can be checked in as a regression test.

## Shared terminal engine (sub-second unit tests)

`src/core/terminal/engine.zig` is the shared bounded text-terminal engine for hosted terminal sessions, recovery, replay, and deterministic rendering tests. `src/ui/resize_tests.zig` drives `TranscriptRuntime` against it in process so resize behavior can be exercised with no fd or timing dependence.

```bash
zig build test                      # runs every VT and resize test
```

When a tmux or tape-based scenario exposes a bug, reproduce it as a Zig unit test in `resize_tests.zig` (or a new sibling) before fixing. The test lands the fix as a regression.

