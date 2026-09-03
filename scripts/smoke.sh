#!/usr/bin/env sh
# Offline smoke gate for the Fiber transition. No auth, no network, no fixture.
# Exercises the entry path, session store, config, catalog, permissions, MCP
# config, workspace, and ACP framing -- the subsystems `help` alone misses.
# Exit codes only: output shifts constantly during demolition and the rename.
set -u
BIN="${1:-zig-out/bin/fiber}"
[ -x "$BIN" ] || { echo "smoke: no binary (build first, or pass a path)"; exit 2; }

fail=0
ok() { "$BIN" "$@" >/dev/null 2>&1 || { echo "FAIL exit=$? $*"; fail=1; }; }

ok help
ok sessions
ok status
ok doctor
ok permissions
ok mcp list
ok workspace list

"$BIN" definitely-not-a-command >/dev/null 2>&1 && { echo "FAIL: unknown subcommand exited 0"; fail=1; }

# `models` and ACP `initialize` reach the provider, so what they can prove
# depends on whether this profile has credentials. Stay strict when it does.
if [ -f "${HOME}/.fiber/chatgpt-auth.json" ]; then
  ok models
  acp_expect='"result"'
  acp_what="no result"
else
  echo "smoke: no ~/.fiber credentials; models and acp checked for framing only"
  acp_expect='"jsonrpc":"2.0","id":1'
  acp_what="no well-formed response"
  "$BIN" models >/dev/null 2>&1
  [ $? -le 1 ] || { echo "FAIL: models crashed rather than reporting an error"; fail=1; }
fi

printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n' \
  | "$BIN" acp 2>/dev/null | grep -q "$acp_expect" || { echo "FAIL: acp initialize returned $acp_what"; fail=1; }

[ "$fail" -eq 0 ] && echo "smoke: ok ($BIN)"
exit "$fail"
