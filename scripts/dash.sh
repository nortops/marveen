#!/bin/bash
# Dashboard API wrapper for fleet agents.
#
# Why this exists: agents calling the dashboard API with raw
#   cd <dir> && curl ... -H "Authorization: Bearer $(cat store/.dashboard-token)" ...
# defeat Claude Code's prefix-based permission allowlist three ways:
#   1. the `cd <dir> &&` compound prefix,
#   2. the `$(cat ...)` command substitution,
#   3. varying curl flag order (GET puts -H before the URL, POST uses -X POST).
# Each variation re-prompts the owner. This wrapper is a single static command
# (token read internally, base URL hardcoded to localhost) so ONE allowlist
# entry — Bash(bash /home/northber/Projects/marveen/scripts/dash.sh:*) —
# silences the noise without granting curl-to-anywhere.
#
# Usage:
#   dash.sh GET  "/api/memories?agent=hermes&q=foo&category=warm"
#   dash.sh POST "/api/memories"  '{"agent_id":"hermes","content":"...","category":"warm","keywords":"..."}'
#   dash.sh PUT  "/api/messages/12" '{"status":"done","result":"..."}'
#
# The base URL is fixed to http://localhost:3420 — the path argument must start
# with /api/ and may not contain a scheme, so it can never be pointed off-box.

set -euo pipefail

BASE="http://localhost:3420"
TOKEN_FILE="/home/northber/Projects/marveen/store/.dashboard-token"

method="${1:-}"
path="${2:-}"
body="${3:-}"

if [[ -z "$method" || -z "$path" ]]; then
  echo "usage: dash.sh <GET|POST|PUT|DELETE> </api/...> [json-body]" >&2
  exit 2
fi

# Path safety: must be a root-relative /api/ path, no scheme, no host.
case "$path" in
  /api/*) ;;
  *) echo "dash.sh: path must start with /api/ (got: $path)" >&2; exit 2 ;;
esac
if [[ "$path" == *"://"* ]]; then
  echo "dash.sh: path must not contain a scheme/host" >&2; exit 2
fi

if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "dash.sh: token file not readable: $TOKEN_FILE" >&2; exit 1
fi
token="$(cat "$TOKEN_FILE")"

if [[ -n "$body" ]]; then
  exec curl -s -m 10 -X "$method" "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${token}" \
    -d "$body"
else
  exec curl -s -m 10 -X "$method" "${BASE}${path}" \
    -H "Authorization: Bearer ${token}"
fi
