#!/usr/bin/env bash
# Fake codex CLI: exits 0 but writes nothing (or an empty file) to
# --output-last-message, to exercise the empty-output retry path.
set -euo pipefail

out_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out_path="$arg"
  fi
  prev="$arg"
done

cat >/dev/null

if [ -n "$out_path" ]; then
  : > "$out_path"
fi

exit 0
