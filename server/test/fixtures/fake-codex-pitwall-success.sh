#!/usr/bin/env bash
# Fake codex CLI: finds --output-last-message <path> in argv and writes a
# fixed valid pitwall analysis JSON there, then exits 0.
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
  "statusSummary": "1周目、順調に走行中。",
  "change": "特になし。",
  "question": "燃料残量は確認済みですか？",
  "proposal": "次のピットで確認してはどうでしょうか。",
  "confidence": "medium",
  "needsReview": true,
  "facts": ["1周目を走行中"],
  "warnings": ["燃料量は聞き取れませんでした"]
}
EOF
fi

exit 0
