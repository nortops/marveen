#!/bin/bash
# Contract tests for main-agent-custom-provider.mjs
#
# Why this exists: channels.sh gains customProvider support for the main agent
# so Atlas can run on LiteLLM/OpenCode (or any Anthropic-compatible custom
# endpoint) rather than the standard Anthropic Claude API.
#
# Key invariants:
#   1. No customProvider -> no output (no-op for existing installs).
#   2. customProvider set but definition missing -> no output + stderr warning.
#   3. customProvider set, no model in agent-config -> no output + stderr warning.
#   4. Valid authHeader=none -> env line with ANTHROPIC_AUTH_TOKEN=ollama.
#   5. Env line always starts with "unset CLAUDE_CODE_OAUTH_TOKEN &&".
#   6. ANTHROPIC_MODEL is single-quoted (shell-safe) in the output.
#   7. Valid Bearer provider -> ANTHROPIC_AUTH_TOKEN=<key>.
#
# Run: bash scripts/__tests__/channels-custom-provider.test.sh
#
# Note: tests run against the REAL install dir and temporarily create
# agents/marveen/ + store/custom-providers.json fixtures, then restore.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$INSTALL_DIR/scripts/main-agent-custom-provider.mjs"

if [ ! -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then
  echo "SKIP: dist/ not built (run 'npm run build' first)"
  exit 0
fi

# Temp agent dir fixture (main agent = marveen in this clone)
AGENT_DIR="$INSTALL_DIR/agents/marveen"
AGENT_CFG="$AGENT_DIR/agent-config.json"
PROVIDERS_PATH="$INSTALL_DIR/store/custom-providers.json"
PROVIDERS_BAK="${PROVIDERS_PATH}.test-bak"

# Cleanup on exit
cleanup() {
  rm -f "$AGENT_CFG" 2>/dev/null
  rmdir "$AGENT_DIR" 2>/dev/null || true
  [ -f "$PROVIDERS_BAK" ] && mv "$PROVIDERS_BAK" "$PROVIDERS_PATH" || rm -f "$PROVIDERS_PATH"
}
trap cleanup EXIT

# Save existing providers file
[ -f "$PROVIDERS_PATH" ] && cp "$PROVIDERS_PATH" "$PROVIDERS_BAK"

NONE_PROVIDER='{"providers":[{"id":"litellm-local","label":"LiteLLM Local","baseUrl":"http://127.0.0.1:4010","authHeader":"none","vaultKey":null}]}'

echo "main-agent-custom-provider.mjs"

# 1. No customProvider (no agent-config.json at all) -> empty output
rm -f "$AGENT_CFG" 2>/dev/null; rmdir "$AGENT_DIR" 2>/dev/null || true
rm -f "$PROVIDERS_PATH"
got="$(node "$HELPER" 2>/dev/null)"
if [ -z "$got" ]; then
  pass "no customProvider -> no output"
else
  fail "no customProvider -> no output" "(empty)" "$got"
fi

# 2. customProvider set but missing from providers store -> no output + stderr
mkdir -p "$AGENT_DIR"
printf '{"customProvider":"ghost-provider","model":"oc/test"}\n' > "$AGENT_CFG"
printf '{"providers":[]}\n' > "$PROVIDERS_PATH"
got="$(node "$HELPER" 2>/dev/null)"
if [ -z "$got" ]; then
  pass "missing provider definition -> no output"
else
  fail "missing provider definition -> no output" "(empty)" "$got"
fi
got_err="$(node "$HELPER" 2>&1 >/dev/null)"
if printf '%s' "$got_err" | grep -q "not found in store"; then
  pass "missing provider definition -> stderr warning"
else
  fail "missing provider definition -> stderr warning" "not found in store" "$got_err"
fi

# 3. customProvider + no explicit model -> output uses distribution default
# readAgentModel() always returns a non-empty model (falls back to
# DISTRIBUTION_DEFAULT_AGENT_MODEL), so the helper always produces output
# when the provider definition is valid.
printf '{"customProvider":"litellm-local"}\n' > "$AGENT_CFG"
printf '%s\n' "$NONE_PROVIDER" > "$PROVIDERS_PATH"
got="$(node "$HELPER" 2>/dev/null)"
if [ -n "$got" ]; then
  pass "no explicit model -> output still produced (default model fallback)"
else
  fail "no explicit model -> output still produced (default model fallback)" "(non-empty)" "(empty)"
fi

# 4-8. Valid authHeader=none provider with explicit model
printf '{"customProvider":"litellm-local","model":"oc/gpt-5.6-luna"}\n' > "$AGENT_CFG"
printf '%s\n' "$NONE_PROVIDER" > "$PROVIDERS_PATH"
got="$(node "$HELPER" 2>/dev/null)"

if [ -n "$got" ]; then
  pass "valid none-auth provider -> non-empty output"
else
  fail "valid none-auth provider -> non-empty output" "(non-empty)" "(empty)"
fi

# 5. Starts with unset CLAUDE_CODE_OAUTH_TOKEN
if printf '%s' "$got" | grep -q '^unset CLAUDE_CODE_OAUTH_TOKEN &&'; then
  pass "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN"
else
  fail "env line starts with unset CLAUDE_CODE_OAUTH_TOKEN" "starts with 'unset CLAUDE_CODE_OAUTH_TOKEN &&'" "$got"
fi

# 6. ANTHROPIC_MODEL single-quoted
if printf '%s' "$got" | grep -q "ANTHROPIC_MODEL='oc/gpt-5.6-luna'"; then
  pass "ANTHROPIC_MODEL is single-quoted"
else
  fail "ANTHROPIC_MODEL is single-quoted" "ANTHROPIC_MODEL='oc/gpt-5.6-luna'" "$got"
fi

# 7. authHeader=none -> ANTHROPIC_AUTH_TOKEN=ollama, no ANTHROPIC_API_KEY
if printf '%s' "$got" | grep -q 'ANTHROPIC_AUTH_TOKEN=ollama'; then
  pass "authHeader=none -> ANTHROPIC_AUTH_TOKEN=ollama"
else
  fail "authHeader=none -> ANTHROPIC_AUTH_TOKEN=ollama" "ANTHROPIC_AUTH_TOKEN=ollama" "$got"
fi
if printf '%s' "$got" | grep -q 'ANTHROPIC_API_KEY'; then
  fail "authHeader=none -> no ANTHROPIC_API_KEY in output" "(absent)" "ANTHROPIC_API_KEY present"
else
  pass "authHeader=none -> no ANTHROPIC_API_KEY leak"
fi

# 8. ANTHROPIC_BASE_URL matches the configured baseUrl
if printf '%s' "$got" | grep -q 'ANTHROPIC_BASE_URL="http://127.0.0.1:4010"'; then
  pass "ANTHROPIC_BASE_URL matches provider baseUrl"
else
  fail "ANTHROPIC_BASE_URL matches provider baseUrl" 'ANTHROPIC_BASE_URL="http://127.0.0.1:4010"' "$got"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
