#!/usr/bin/env bash
# backup.sh — one-command encrypted backup of the full Atlas fleet.
#
# Usage:
#   ./scripts/backup.sh [--dry-run] [--output-dir DIR]
#
# Output: marveen-backup-<TIMESTAMP>.tar.gz.enc  (current dir, or --output-dir)
#
# What gets packed (tar root = /home/northber):
#   .claude/              (excluding cache/, sessions/, tmp/, daemon/, daemon.lock, daemon.log)
#   .config/systemd/user/
#   Projects/marveen/store/<snapshot + vault + state files>
#   Projects/marveen/.env-for-backup   (CLAUDE_CODE_OAUTH_TOKEN row excluded)
#   Projects/marveen/homeserver.tail*.crt / .key
#   Projects/marveen/fleet.bundle      (git bundle for offline restore)
#   Projects/marveen/manifest.json     (pinned_sha, checksums, node_version, ...)
#
# Restore: extract, then run scripts/install.sh on the target machine.
#
# SECURITY: the archive contains vault keys and bot tokens. Keep it off cloud sync.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="/home/northber"
STORE_DIR="${REPO_ROOT}/store"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DRY_RUN=false
OUTPUT_DIR="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)          DRY_RUN=true ;;
    --output-dir=*)     OUTPUT_DIR="${1#--output-dir=}" ;;
    --output-dir)       shift; OUTPUT_DIR="${1:?--output-dir requires a value}" ;;
    *)                  echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Prereq check (dry-run only needs git + node for pinned_sha + size display)
# ---------------------------------------------------------------------------
MISSING=()
if $DRY_RUN; then
  for cmd in git node; do
    command -v "$cmd" >/dev/null 2>&1 || MISSING+=("$cmd")
  done
else
  for cmd in openssl git node tar; do
    command -v "$cmd" >/dev/null 2>&1 || MISSING+=("$cmd")
  done
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: missing tools: ${MISSING[*]}" >&2
  echo "Install them and retry." >&2
  exit 1
fi

echo "=== Atlas Fleet Backup ==="
echo "Timestamp : $TIMESTAMP"
echo "Repo      : $REPO_ROOT"
$DRY_RUN && echo "(DRY-RUN: no archive will be created)"
echo

# ---------------------------------------------------------------------------
# Step 1 — DB snapshot (WAL checkpoint + VACUUM INTO + integrity_check)
#          Uses better-sqlite3 (already in node_modules; no sqlite3 CLI needed)
# ---------------------------------------------------------------------------
SNAPSHOT_TMP="/tmp/claudeclaw-snapshot-${TIMESTAMP}.db"
SNAPSHOT_IN_STORE="${STORE_DIR}/claudeclaw-snapshot.db"
TAR_TMP="/tmp/marveen-backup-${TIMESTAMP}.tar.gz"
ARCHIVE_FINAL="${OUTPUT_DIR}/marveen-backup-${TIMESTAMP}.tar.gz.enc"

cleanup_temps() {
  rm -f "${SNAPSHOT_TMP}" "${SNAPSHOT_IN_STORE}" \
        "/tmp/fleet-${TIMESTAMP}.bundle" \
        "${REPO_ROOT}/fleet.bundle" \
        "${REPO_ROOT}/manifest.json" \
        "${REPO_ROOT}/.env-for-backup" \
        "${TAR_TMP}"
}

if $DRY_RUN; then
  PINNED_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  echo "[DRY-RUN] DB: WAL checkpoint + VACUUM INTO + integrity_check (via better-sqlite3)"
  echo "[DRY-RUN] git bundle create --branches main_atlas HEAD (pinned_sha=${PINNED_SHA:0:12}...)"
  echo "[DRY-RUN] grep -v CLAUDE_CODE_OAUTH_TOKEN .env > .env-for-backup"
  echo
  echo "Files that would be included (from ${HOME_DIR}):"
  printf "  %-62s  %s\n" "PATH" "SIZE"
  printf "  %-62s  %s\n" "$(printf '%.0s-' {1..62})" "------"

  _show() {
    local p="$1"
    local full="${HOME_DIR}/${p}"
    if [[ -e "$full" ]]; then
      local sz
      sz=$(du -sh "$full" 2>/dev/null | cut -f1)
      printf "  %-62s  %s\n" "$p" "$sz"
    fi
  }

  printf "  %-62s  %s\n" "Projects/marveen/store/claudeclaw-snapshot.db" "(generated)"
  _show "Projects/marveen/store/vault.json"
  _show "Projects/marveen/store/.vault-key"
  _show "Projects/marveen/store/vault-bindings.json"
  _show "Projects/marveen/store/.dashboard-token"
  _show "Projects/marveen/store/agents-desired.json"
  _show "Projects/marveen/store/autonomy-config.json"
  _show "Projects/marveen/store/auto-restart.json"
  _show "Projects/marveen/store/norbert-personal.json"
  _show "Projects/marveen/store/schedule-last-run.json"
  _show "Projects/marveen/store/terminal-input.json"
  _show "Projects/marveen/store/kanban-audit-state.json"
  [[ -d "${STORE_DIR}/agent-taskstate" ]] && _show "Projects/marveen/store/agent-taskstate"
  [[ -d "${STORE_DIR}/patches" ]] && _show "Projects/marveen/store/patches"
  for f in "${STORE_DIR}"/marveen-avatar.*; do
    [[ -f "$f" ]] && _show "Projects/marveen/store/${f##*/}"
  done
  printf "  %-62s  %s\n" "Projects/marveen/.env-for-backup" "(generated)"
  for f in "${REPO_ROOT}"/homeserver.tail*.crt "${REPO_ROOT}"/homeserver.tail*.key; do
    [[ -f "$f" ]] && _show "Projects/marveen/${f##*/}"
  done
  printf "  %-62s  %s\n" "Projects/marveen/fleet.bundle" "(generated)"
  printf "  %-62s  %s\n" "Projects/marveen/manifest.json" "(generated)"
  # Fleet-specific gitignored root files (dynamic scan, same skip-list as real run)
  _DR_SKIP=(
    "store" "agents" "backups" "dist" "node_modules"
    ".playwright-mcp" "DREAM.md" ".env" ".env.save"
    "scripts" ".gitnexus" "workspace" "reports" "mcp-servers"
  )
  while IFS= read -r _ig; do
    _ig="${_ig%/}"; [[ -z "${_ig}" ]] && continue
    _sk=false
    for _s in "${_DR_SKIP[@]}"; do
      [[ "${_ig}" == "${_s}" || "${_ig}" == "${_s}/"* ]] && { _sk=true; break; }
    done
    ${_sk} && continue
    [[ -e "${HOME_DIR}/Projects/marveen/${_ig}" ]] && _show "Projects/marveen/${_ig}"
  done < <(git -C "${REPO_ROOT}" status --ignored --short 2>/dev/null | awk '/^!! /{print substr($0,4)}')
  if [[ -d "${REPO_ROOT}/agents" ]]; then
    SZ=$(du -sh \
      --exclude="${HOME_DIR}/Projects/marveen/agents/*/.claude/cache" \
      --exclude="${HOME_DIR}/Projects/marveen/agents/*/.claude/sessions" \
      --exclude="${HOME_DIR}/Projects/marveen/agents/*/.claude/tmp" \
      --exclude="${HOME_DIR}/Projects/marveen/agents/*/.claude/projects" \
      --exclude="${HOME_DIR}/Projects/marveen/agents/*/.claude/daemon" \
      "${REPO_ROOT}/agents" 2>/dev/null | tail -1 | cut -f1)
    printf "  %-62s  ~%s\n" "Projects/marveen/agents/ (excl. .claude/cache/sessions/tmp/projects/daemon)" "${SZ}"
  fi
  if [[ -d "${HOME_DIR}/.claude" ]]; then
    SZ=$(du -sh \
      --exclude="${HOME_DIR}/.claude/cache" \
      --exclude="${HOME_DIR}/.claude/sessions" \
      --exclude="${HOME_DIR}/.claude/tmp" \
      --exclude="${HOME_DIR}/.claude/daemon" \
      "${HOME_DIR}/.claude" 2>/dev/null | tail -1 | cut -f1)
    printf "  %-62s  ~%s\n" ".claude/ (excl. cache/sessions/tmp/daemon)" "${SZ}"
  fi
  _show ".config/systemd/user"
  echo
  echo "[DRY-RUN] No archive created."
  exit 0
fi

# From here on: real run. Clean up temp files on exit (success or failure).
trap cleanup_temps EXIT

echo "[1/7] DB snapshot..."
REPO_ROOT="${REPO_ROOT}" \
STORE_DIR="${STORE_DIR}" \
SNAPSHOT_TMP="${SNAPSHOT_TMP}" \
node - << 'NODESCRIPT'
  const Database = require(process.env.REPO_ROOT + "/node_modules/better-sqlite3");
  const db = new Database(process.env.STORE_DIR + "/claudeclaw.db");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM INTO '" + process.env.SNAPSHOT_TMP.replace(/'/g, "''") + "'");
  db.close();
  const snap = new Database(process.env.SNAPSHOT_TMP, {readonly: true});
  const intck = snap.pragma("integrity_check", {simple: true});
  snap.close();
  if (intck !== "ok") {
    process.stderr.write("ERROR: DB integrity_check failed: " + intck + "\n");
    process.exit(1);
  }
  process.stdout.write("    snapshot OK (integrity: ok)\n");
NODESCRIPT
cp "${SNAPSHOT_TMP}" "${SNAPSHOT_IN_STORE}"

# ---------------------------------------------------------------------------
# Step 2 — git bundle
# ---------------------------------------------------------------------------
echo "[2/7] Git bundle..."
BUNDLE_TMP="/tmp/fleet-${TIMESTAMP}.bundle"
git -C "${REPO_ROOT}" bundle create "${BUNDLE_TMP}" --branches main_atlas HEAD
PINNED_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
cp "${BUNDLE_TMP}" "${REPO_ROOT}/fleet.bundle"
echo "    bundle OK, pinned_sha: ${PINNED_SHA}"

# ---------------------------------------------------------------------------
# Step 3 — .env-for-backup (OAuth token row excluded)
# ---------------------------------------------------------------------------
echo "[3/7] Preparing .env-for-backup..."
grep -v 'CLAUDE_CODE_OAUTH_TOKEN' "${REPO_ROOT}/.env" > "${REPO_ROOT}/.env-for-backup" || true
echo "    .env-for-backup written (CLAUDE_CODE_OAUTH_TOKEN excluded)"

# ---------------------------------------------------------------------------
# Step 4 — manifest.json
# ---------------------------------------------------------------------------
echo "[4/7] Writing manifest.json..."
ORIGINAL_USER="${HOME_DIR##*/}"
NODE_VERSION="$(node --version)"
HOSTNAME_VAL="$(hostname)"
MANIFEST_PATH="${REPO_ROOT}/manifest.json"

REPO_ROOT="${REPO_ROOT}" \
PINNED_SHA="${PINNED_SHA}" \
NODE_VERSION="${NODE_VERSION}" \
TIMESTAMP="${TIMESTAMP}" \
HOME_DIR="${HOME_DIR}" \
ORIGINAL_USER="${ORIGINAL_USER}" \
HOSTNAME_VAL="${HOSTNAME_VAL}" \
node -e "
const { createHash } = require('crypto');
const { readFileSync, existsSync } = require('fs');
const path = require('path');

const repoRoot = process.env.REPO_ROOT;
const KEY_FILES = [
  'store/vault.json',
  'store/.vault-key',
  'store/vault-bindings.json',
  'store/.dashboard-token',
  'store/claudeclaw-snapshot.db',
  '.env-for-backup'
];
const checksums = {};
for (const f of KEY_FILES) {
  const full = path.join(repoRoot, f);
  checksums[f] = existsSync(full)
    ? createHash('sha256').update(readFileSync(full)).digest('hex')
    : 'missing';
}
const manifest = {
  pinned_sha: process.env.PINNED_SHA,
  branch: 'main_atlas',
  node_version: process.env.NODE_VERSION,
  timestamp: process.env.TIMESTAMP,
  original_home: process.env.HOME_DIR,
  original_user: process.env.ORIGINAL_USER,
  hostname: process.env.HOSTNAME_VAL,
  checksums
};
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
" > "${MANIFEST_PATH}"
echo "    manifest.json written"

# ---------------------------------------------------------------------------
# Step 5 — build tar file list (explicit includes, minimal excludes)
# ---------------------------------------------------------------------------
echo "[5/7] Building tar archive..."

INCLUDE=()

# Store: explicit files only (skip logs, pid, etc.)
for rel in \
  "Projects/marveen/store/claudeclaw-snapshot.db" \
  "Projects/marveen/store/vault.json" \
  "Projects/marveen/store/.vault-key" \
  "Projects/marveen/store/vault-bindings.json" \
  "Projects/marveen/store/.dashboard-token" \
  "Projects/marveen/store/agents-desired.json" \
  "Projects/marveen/store/autonomy-config.json" \
  "Projects/marveen/store/auto-restart.json" \
  "Projects/marveen/store/norbert-personal.json" \
  "Projects/marveen/store/schedule-last-run.json" \
  "Projects/marveen/store/terminal-input.json" \
  "Projects/marveen/store/kanban-audit-state.json"
do
  [[ -e "${HOME_DIR}/${rel}" ]] && INCLUDE+=("$rel")
done

# Optional dirs
[[ -d "${STORE_DIR}/agent-taskstate" ]] && INCLUDE+=("Projects/marveen/store/agent-taskstate")
[[ -d "${STORE_DIR}/patches" ]]         && INCLUDE+=("Projects/marveen/store/patches")

# Main agent avatar (gitignored; all extensions, e.g. .png / .jpg)
for f in "${STORE_DIR}"/marveen-avatar.*; do
  [[ -f "$f" ]] && INCLUDE+=("Projects/marveen/store/${f##*/}")
done

# .env-for-backup + certs (existence guard)
[[ -f "${REPO_ROOT}/.env-for-backup" ]] && INCLUDE+=("Projects/marveen/.env-for-backup")
for f in "${REPO_ROOT}"/homeserver.tail*.crt "${REPO_ROOT}"/homeserver.tail*.key; do
  [[ -f "$f" ]] && INCLUDE+=("Projects/marveen/${f##*/}")
done

# Git artifacts + manifest
INCLUDE+=("Projects/marveen/fleet.bundle" "Projects/marveen/manifest.json")

# Sub-agent directories: config, persona, Telegram channel, memory, MCP
# (.claude/cache, sessions, tmp, daemon, projects match via suffix and are excluded below)
[[ -d "${REPO_ROOT}/agents" ]] && INCLUDE+=("Projects/marveen/agents")

# Fleet-specific gitignored files at repo root (CLAUDE.md, SOUL.md, agent-config.json, etc.)
# Derived dynamically so future additions are picked up without modifying this script.
# Items already handled above (store/, agents/, certs, .env) are skipped.
_IGNORE_SKIP=(
  "store" "agents" "backups" "dist" "node_modules"
  ".playwright-mcp" "DREAM.md" ".env" ".env.save"
  "scripts" ".gitnexus" "workspace" "reports"
  "mcp-servers"
)
while IFS= read -r _ig; do
  _ig="${_ig%/}"   # strip trailing slash
  [[ -z "${_ig}" ]] && continue
  _skip=false
  for _s in "${_IGNORE_SKIP[@]}"; do
    if [[ "${_ig}" == "${_s}" || "${_ig}" == "${_s}/"* ]]; then
      _skip=true; break
    fi
  done
  ${_skip} && continue
  [[ -e "${HOME_DIR}/Projects/marveen/${_ig}" ]] && INCLUDE+=("Projects/marveen/${_ig}")
done < <(git -C "${REPO_ROOT}" status --ignored --short 2>/dev/null | awk '/^!! /{print substr($0,4)}')

# .claude/ and systemd units are included as whole trees with exclusions applied below
INCLUDE+=(".claude" ".config/systemd/user")

# Exclusion list: paths relative to HOME_DIR.
# GNU tar suffix-matches patterns containing a slash, so these cover both
# the top-level .claude/ and any nested agents/*/.claude/ directories.
EXCLUDES=(
  ".claude/cache"
  ".claude/sessions"
  ".claude/tmp"
  ".claude/projects"
  ".claude/daemon"
  ".claude/daemon.lock"
  ".claude/daemon.log"
  ".claude-config"
  "Projects/marveen/node_modules"
  "Projects/marveen/dist"
  ".local/share/claude"
  ".env.save"
)

EXCLUDE_ARGS=()
for ex in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=("--exclude=${ex}")
done

cd "${HOME_DIR}"
tar -czpf "${TAR_TMP}" "${EXCLUDE_ARGS[@]}" "${INCLUDE[@]}"
echo "    tar: ${TAR_TMP} ($(du -sh "${TAR_TMP}" | cut -f1))"

# ---------------------------------------------------------------------------
# Step 6 — openssl AES-256-CBC encryption (passphrase from stdin)
# ---------------------------------------------------------------------------
echo "[6/7] Encrypting with openssl (AES-256-CBC, PBKDF2, 200 000 iterations)..."
echo "(Enter a passphrase for the archive. You will need it to restore.)"
read -rsp "Passphrase: " PASS
echo
read -rsp "Confirm:    " PASS2
echo
if [[ "${PASS}" != "${PASS2}" ]]; then
  echo "ERROR: passphrases do not match" >&2
  unset PASS PASS2
  exit 1
fi
unset PASS2

printf '%s\n' "${PASS}" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "${TAR_TMP}" -out "${ARCHIVE_FINAL}" -pass stdin
unset PASS
rm -f "${TAR_TMP}"
echo "    Encrypted: ${ARCHIVE_FINAL} ($(du -sh "${ARCHIVE_FINAL}" | cut -f1))"

# Temp files cleaned by trap EXIT

echo
echo "[7/7] Cleanup done (temp files removed)."
echo
echo "=== BACKUP COMPLETE ==="
echo "Archive : ${ARCHIVE_FINAL}"
echo "Transfer to new machine + run: bash install.sh"
echo
echo "WARNING: archive contains vault keys and bot tokens -- keep it off cloud-sync folders."
