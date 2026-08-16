#!/usr/bin/env bash
# Fake codex CLI: finds --output-last-message <path> in argv and writes a
# fixed valid driver analysis JSON there, then exits 0.
set -euo pipefail

out_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out_path="$arg"
  fi
  prev="$arg"
done

# Drain stdin (the prompt) so the parent's stdin.end() doesn't hang.
cat >/dev/null

if [ -n "$out_path" ]; then
  cat > "$out_path" <<'EOF'
{
  "headline": "1周目を走行中",
  "action": "点検のタイミングを確認",
  "watch": null,
  "urgency": "low"
}
EOF
fi

exit 0
