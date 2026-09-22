#!/bin/sh
cd "$(dirname "$0")"
ext() { case "$1" in js) echo js;; luau) echo luau;; *) echo lua;; esac; }
m=qwen3.8-flash
for lang in lua luau js; do
  out="out/${m}__${lang}.$(ext $lang)"
  echo ">>> $m / $lang"
  timeout 180 pi -p --model "oc-sdk-go/${m}" "$(cat prompt-$lang.txt)" > "$out" 2>"out/${m}__${lang}.err" || echo "FAILED $m/$lang"
done
echo "QWEN_DONE"
