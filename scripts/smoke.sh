#!/usr/bin/env sh
# Offline smoke gate for the Fiber transition. No auth, no network, no fixture.
# Exercises the entry path, session store, config, catalog, permissions, MCP
# config, workspace, and models -- the subsystems `help` alone misses.
# Exit codes only: output shifts constantly during demolition and the rename.
set -u
BIN="${1:-zig-out/bin/fiber}"
[ -x "$BIN" ] || { echo "smoke: no binary (build first, or pass a path)"; exit 2; }

fail=0
ok() { "$BIN" "$@" >/dev/null 2>&1 || { echo "FAIL exit=$? $*"; fail=1; }; }

json_ok() {
  out="$("$BIN" "$@" 2>/dev/null)" || { echo "FAIL exit=$? $*"; fail=1; return; }
  echo "$out" | grep -q '"ok":' || { echo "FAIL missing ok envelope: $*"; fail=1; }
  echo "$out" | grep -q '"kind":' || { echo "FAIL missing kind envelope: $*"; fail=1; }
}

ok help
json_ok sessions --json
json_ok status --json
json_ok doctor --json
json_ok permissions --json
ok mcp list
json_ok workspace list --json

"$BIN" definitely-not-a-command >/dev/null 2>&1
[ "$?" -eq 2 ] || { echo "FAIL: unknown subcommand did not exit 2"; fail=1; }

# `models` reaches the provider, so what it can prove depends on whether this
# profile has credentials. Stay strict when it does.
if [ -f "${HOME}/.fiber/chatgpt-auth.json" ]; then
  json_ok models --json
else
  echo "smoke: no ~/.fiber credentials; models checked for framing only"
  "$BIN" models >/dev/null 2>&1
  [ $? -le 1 ] || { echo "FAIL: models crashed rather than reporting an error"; fail=1; }
fi

[ "$fail" -eq 0 ] && echo "smoke: ok ($BIN)"
exit "$fail"
