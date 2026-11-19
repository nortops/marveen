# shellcheck shell=bash
# <PROVIDER>_STATE_DIR for the main session's CO-LISTEN channel plugins
# (CHANNEL_PLUGINS_EXTRA), install-scoped like the primary's (see #915 in
# scripts/channels.sh).
#
# ROOT CAUSE (measured): channels.sh exported *_STATE_DIR only for the PRIMARY
# provider (CHANNEL_PROVIDER). A co-listened extra provider's plugin server
# then fell back to its STATE_ENV_VAR default, ~/.claude/channels/<provider>/.env
# -- which an install-scoped setup never writes -- and exited
# "<PROVIDER>_BOT_TOKEN required" at startup. The bot never came online: the
# running session's env carried e.g. TELEGRAM_STATE_DIR but not
# DISCORD_STATE_DIR. An existing tmux -g export of the extra's STATE_DIR
# papers over this until the next reboot, when the global env is gone again.
#
# Sourced by scripts/channels.sh, AFTER scripts/lib/channel-net-wait.sh (needs
# its channel_provider_of_plugin).

# The *_STATE_DIR env var a provider's channel plugin reads: <PROVIDER>_STATE_DIR,
# upper-cased. Same rule as channelStateDirEnvVar() in src/channel-provider.ts
# (the canonical source every TS reader of this var agrees with) -- no
# per-provider table, and no "unknown -> telegram" default: unlike the PRIMARY
# provider (which can be absent from .env and then defaults to telegram), an
# extra plugin id always names its provider explicitly, so there is nothing to
# default FROM.
#
# A provider string with anything outside [a-z0-9] (not one of the known
# providers -- a malformed CHANNEL_PLUGINS_EXTRA entry) would upper-case into
# an invalid shell identifier; channel_extra_state_dirs skips it rather than
# hand `export` a string it will refuse.
channel_state_dir_var_for_provider() {
  printf '%s_STATE_DIR\n' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
}

# channel_extra_state_dirs <install_dir> <primary_state_var> [extra plugin id...]
#
# Prints "VAR=dir" one per line, one per distinct extra provider. Skips:
#   - gromzo (GROMZONOPROVIDER1108: no channel state dir, no token to isolate);
#   - a provider name outside [a-z0-9] (see above);
#   - any extra whose var equals <primary_state_var> (the same provider listed
#     as both primary and an extra plugin id -- the primary's own export
#     already covers it; a second path here would just as easily point
#     somewhere else and fight it).
channel_extra_state_dirs() {
  local install_dir="$1" primary_var="$2"; shift 2
  local p var seen=" "
  for p in $(for x in "$@"; do channel_provider_of_plugin "$x"; done); do
    case "$seen" in *" $p "*) continue ;; esac
    seen="$seen$p "
    [ "$p" = "gromzo" ] && continue
    case "$p" in *[!a-z0-9]*|'') continue ;; esac
    var="$(channel_state_dir_var_for_provider "$p")"
    [ "$var" = "$primary_var" ] && continue
    printf '%s=%s\n' "$var" "$install_dir/.claude/channels/$p"
  done
}
