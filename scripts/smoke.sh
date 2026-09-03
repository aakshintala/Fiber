#!/usr/bin/env sh
# Offline smoke gate for the Fiber transition. No auth, no network, no fixture.
# Exercises the entry path, session store, config, catalog, permissions, MCP
# config, workspace, and ACP framing -- the subsystems `help` alone misses.
# Exit codes only: output shifts constantly during demolition and the rename.
set -u
BIN="${1:-$(ls zig-out/bin/fiber zig-out/bin/fx 2>/dev/null | head -1)}"
[ -x "$BIN" ] || { echo "smoke: no binary (build first, or pass a path)"; exit 2; }

fail=0
ok() { "$BIN" "$@" >/dev/null 2>&1 || { echo "FAIL exit=$? $*"; fail=1; }; }

ok help
ok sessions
ok status
ok doctor
ok models
ok permissions
ok mcp list
ok workspace list

"$BIN" definitely-not-a-command >/dev/null 2>&1 && { echo "FAIL: unknown subcommand exited 0"; fail=1; }

printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n' \
  | "$BIN" acp 2>/dev/null | grep -q '"result"' || { echo "FAIL: acp initialize returned no result"; fail=1; }

[ "$fail" -eq 0 ] && echo "smoke: ok ($BIN)"
exit "$fail"
