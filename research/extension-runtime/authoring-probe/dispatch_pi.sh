#!/bin/sh
cd "$(dirname "$0")"
ext() { case "$1" in js) echo js;; luau) echo luau;; *) echo lua;; esac; }
for m in glm-5.3-flash deepseek-v4-flash muse-spark-1.3-contributor; do
  for lang in lua luau js; do
    out="out/${m}__${lang}.$(ext $lang)"
    echo ">>> $m / $lang -> $out"
    timeout 180 pi -p --model "oc-sdk-go/${m}" "$(cat prompt-$lang.txt)" > "$out" 2>"out/${m}__${lang}.err" \
      || echo "FAILED $m/$lang (exit $?)"
  done
done
echo "PI_DISPATCH_DONE"
