#!/usr/bin/env bash
# Fake codex CLI: finds --output-last-message <path> in argv and writes a
# fixed valid analysis JSON there, then exits 0. Mirrors real `codex exec`
# contract used by CodexProvider (answer read from the tmpfile, not stdout).
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
  "summary": "テストの要約です。",
  "interpretation": "テストの解釈です。",
  "advice": ["アドバイス1", "アドバイス2"],
  "suggested_response": "テストの返答案です。",
  "confidence": 0.8,
  "notes": null
}
EOF
fi

exit 0
