#!/usr/bin/env bash
# Verifies Tailscale connectivity and that this Mac's server port is reachable
# over the tailnet. See plan section "Tailscale ネットワーク構築" steps 2-5.
set -euo pipefail

PORT="${PORT:-8787}"

echo "== tailscale status =="
tailscale status

echo
echo "== this machine's MagicDNS name / IP =="
tailscale ip -4 || true
TS_HOSTNAME="$(tailscale status --json | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
echo "DNSName: ${TS_HOSTNAME:-unknown}"

echo
echo "== local healthz check =="
curl -fsS "http://127.0.0.1:${PORT}/healthz" && echo || echo "FAILED: local healthz"

if [ -n "${TS_HOSTNAME:-}" ]; then
  echo
  echo "== tailnet healthz check (${TS_HOSTNAME%.}:${PORT}) =="
  curl -fsS "http://${TS_HOSTNAME%.}:${PORT}/healthz" && echo || echo "FAILED: tailnet healthz (check firewall / server bind)"
fi

echo
echo "Done. Open http://${TS_HOSTNAME%.}:${PORT}/ from the Pixel browser to reach the Web GUI."
