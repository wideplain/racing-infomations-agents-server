#!/usr/bin/env bash
# Fake codex CLI: always fails with a non-zero exit code, no output file written.
cat >/dev/null
echo "fake codex: simulated failure" >&2
exit 1
