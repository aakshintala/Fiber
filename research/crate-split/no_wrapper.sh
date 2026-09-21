#!/bin/sh
# Identity rustc wrapper so this benchmark is not routed through sccache.
# Cargo invokes: $wrapper $rustc $args
exec "$@"
