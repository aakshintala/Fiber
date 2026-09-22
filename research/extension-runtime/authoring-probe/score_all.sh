#!/bin/sh
cd "$(dirname "$0")"
P3=../pass3
for f in out/*.lua out/*.luau out/*.js; do
  [ -s "$f" ] || continue
  base=$(basename "$f"); ext="${base##*.}"
  clean="out/clean/$base"
  python3 clean.py "$f" "$clean"
  abs="$(cd "$(dirname "$clean")" && pwd)/$(basename "$clean")"
  case "$ext" in
    lua)  (cd "$P3/lua"  && ./../target/release/score-lua   "$abs") ;;
    luau) (cd "$P3/luau" && ./target/release/score-luau      "$abs") ;;
    js)   (cd "$P3/js"   && ./../target/release/score-js     "$abs") ;;
  esac
done
