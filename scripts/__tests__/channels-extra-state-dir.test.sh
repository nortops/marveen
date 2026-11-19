#!/bin/bash
# Contract tests for *_STATE_DIR exports of CHANNEL_PLUGINS_EXTRA co-listen
# providers (scripts/lib/channel-extra-state-dir.sh).
#
# ROOT CAUSE (measured): channels.sh exported *_STATE_DIR only for the
# PRIMARY provider (CHANNEL_PROVIDER); a co-listened extra (e.g. Discord
# alongside a Telegram primary, via CHANNEL_PLUGINS_EXTRA) fell back to its
# STATE_ENV_VAR default, ~/.claude/channels/<provider>/.env, which an
# install-scoped setup never writes -- so that plugin's MCP server exited
# "<PROVIDER>_BOT_TOKEN required" at startup and the bot never came online,
# even though the primary channel worked fine.
#
# Driven through channels.sh's --channel-extra-state-dirs test seam, so a
# mutant copy of the script can turn this red via CHANNELS_BIN.
# Run: bash scripts/__tests__/channels-extra-state-dir.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }
eq() { if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

extras() { bash "$CHANNELS" --channel-extra-state-dirs "$@" 2>/dev/null | tr '\n' '|' | sed 's/|$//'; }

echo "channels.sh extra-plugin *_STATE_DIR: which vars get exported"
echo "==============================================================="
eq "telegram primary + discord co-listen -> DISCORD_STATE_DIR only" \
  "DISCORD_STATE_DIR=/install/.claude/channels/discord" \
  "$(extras /install TELEGRAM_STATE_DIR 'discord@claude-plugins-official')"

eq "telegram primary + slack co-listen (our marketplace id)" \
  "SLACK_STATE_DIR=/install/.claude/channels/slack" \
  "$(extras /install TELEGRAM_STATE_DIR 'slack-channel@marveen-marketplace')"

eq "slack primary + telegram co-listen -> the other way round" \
  "TELEGRAM_STATE_DIR=/install/.claude/channels/telegram" \
  "$(extras /install SLACK_STATE_DIR 'telegram@claude-plugins-official')"

eq "two different extras -> both, in order" \
  "DISCORD_STATE_DIR=/install/.claude/channels/discord|SLACK_STATE_DIR=/install/.claude/channels/slack" \
  "$(extras /install TELEGRAM_STATE_DIR 'discord@claude-plugins-official' 'slack-channel@marveen-marketplace')"

eq "the same provider listed twice as an extra -> exported once" \
  "DISCORD_STATE_DIR=/install/.claude/channels/discord" \
  "$(extras /install TELEGRAM_STATE_DIR 'discord@claude-plugins-official' 'discord@claude-plugins-official')"

eq "an extra that is ALSO the primary provider -> skipped (primary's own export already covers it)" \
  "" \
  "$(extras /install TELEGRAM_STATE_DIR 'telegram@claude-plugins-official')"

eq "gromzo as an extra -> skipped (GROMZONOPROVIDER1108: no channel state dir)" \
  "" \
  "$(extras /install TELEGRAM_STATE_DIR 'gromzo-channel@gromzo-local')"

eq "gromzo plus a real extra -> only the real one" \
  "SLACK_STATE_DIR=/install/.claude/channels/slack" \
  "$(extras /install TELEGRAM_STATE_DIR 'gromzo-channel@gromzo-local' 'slack-channel@marveen-marketplace')"

eq "no extras at all -> nothing" \
  "" \
  "$(extras /install TELEGRAM_STATE_DIR)"

eq "googlechat as an extra -> GOOGLECHAT_STATE_DIR (a provider the OLD primary-only case statement never named; the plain upper-case rule still gets it right)" \
  "GOOGLECHAT_STATE_DIR=/install/.claude/channels/googlechat" \
  "$(extras /install TELEGRAM_STATE_DIR 'googlechat@claude-channel-googlechat')"

eq "a provider name outside [a-z0-9] (malformed CHANNEL_PLUGINS_EXTRA entry) -> skipped rather than handed to export as an invalid identifier" \
  "" \
  "$(extras /install TELEGRAM_STATE_DIR 'something-unknown@some-marketplace')"

echo ""
echo "channels.sh extra-plugin *_STATE_DIR: wired into the main launch"
echo "=================================================================="
SRC="$CHANNELS"
# Both new-session launch sites (the normal boot and the EPERM /tmp fallback)
# must carry EXTRA_STATE_DIR_ENV in the command string they build, and must
# -u every extra's var out of the `env` call that creates them (TMUXSERVERREAP929's
# reasoning extended to the extras: a new-session that happens to create the
# shared tmux server must not leak an extra's state dir into its global env
# either).
launch_lines="$(grep -n 'new-session -d -s "\$SESSION"' "$SRC" | cut -d: -f1)"
nlaunch="$(printf '%s\n' "$launch_lines" | grep -c .)"
eq "exactly two new-session launch sites (primary boot + /tmp EPERM fallback)" "2" "$nlaunch"

for ln in $launch_lines; do
  env_ln=$((ln))
  cmd_ln=$((ln + 1))
  env_line="$(sed -n "${env_ln}p" "$SRC")"
  cmd_line="$(sed -n "${cmd_ln}p" "$SRC")"
  case "$env_line" in
    *'$EXTRA_STATE_UNSET_FLAGS'*) pass "new-session at line $ln: env -u carries EXTRA_STATE_UNSET_FLAGS" ;;
    *) fail "new-session at line $ln: env -u carries EXTRA_STATE_UNSET_FLAGS" "\$EXTRA_STATE_UNSET_FLAGS in the env line" "$env_line" ;;
  esac
  case "$cmd_line" in
    *'${EXTRA_STATE_DIR_ENV}'*) pass "new-session at line $ln: launch command carries EXTRA_STATE_DIR_ENV" ;;
    *) fail "new-session at line $ln: launch command carries EXTRA_STATE_DIR_ENV" "\${EXTRA_STATE_DIR_ENV} in the command line" "$cmd_line" ;;
  esac
done

# start-server, too (same TMUXSERVERREAP929 class: it also may be what forks
# the shared server, under `set -g exit-empty off`).
startserver_line="$(grep -n '\$TMUX start-server' "$SRC" | head -1)"
case "$startserver_line" in
  *'$EXTRA_STATE_UNSET_FLAGS'*) pass "start-server also -u's every extra's state-dir var" ;;
  *) fail "start-server -u's every extra's state-dir var" "\$EXTRA_STATE_UNSET_FLAGS present" "$startserver_line" ;;
esac

# The primary-only -g -u cleanup must stay primary-only: extending it to the
# extras would undo their export on every relaunch (the regression this fix
# is for would come right back). Exactly one occurrence, and it names only
# $STATE_ENV_VAR, never an EXTRA_* variable.
gu_lines="$(grep -n 'set-environment -g -u "\$STATE_ENV_VAR"' "$SRC")"
ngu="$(printf '%s\n' "$gu_lines" | grep -c .)"
eq "exactly one -g -u cleanup of \$STATE_ENV_VAR" "1" "$ngu"
case "$gu_lines" in
  *EXTRA*) fail "the -g -u cleanup stays scoped to the primary" "no EXTRA_* in that line" "$gu_lines" ;;
  *) pass "the -g -u cleanup stays scoped to the primary (no EXTRA_* reference)" ;;
esac

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
