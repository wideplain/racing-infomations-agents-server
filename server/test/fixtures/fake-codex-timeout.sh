#!/usr/bin/env bash
# Fake codex CLI: sleeps far longer than any test timeout, to exercise the
# SIGTERM -> 5s -> SIGKILL path in CodexProvider.
cat >/dev/null
sleep 300
exit 0
