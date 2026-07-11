#!/usr/bin/env bash
# install.sh — interactive native restore for the Atlas fleet.
#
# Usage: bash install.sh
#
# Prerequisites (must be installed BEFORE running):
#   git, node (>=18), npm, openssl, tmux, systemd --user, claude (Claude Code CLI)
#
# The script restores from a .tar.gz.enc backup created by scripts/backup.sh:
#   1. Select backup file
#   2. Decrypt + extract to ~/
#   3. Git clone from embedded bundle, build source
#   4. Write vault-resolved OAuth token into .env
#   5. Rename DB snapshot to live DB
#   6. Rewrite home paths (only if username changed)
#   7. Enable + start systemd units
#   8. Three-level verification
#   9. Print post-install checklist

set -euo pipefail

TARGET_USER="$(whoami)"
TARGET_HOME="/home/${TARGET_USER}"
PROJECT_DIR="${TARGET_HOME}/Projects/marveen"

# ---------------------------------------------------------------------------
# Step 0 — prerequisite check
# ---------------------------------------------------------------------------
echo "=== Atlas Fleet Restore ==="
echo "Target user : ${TARGET_USER}"
echo "Target home : ${TARGET_HOME}"
echo

MISSING=()
for cmd in git npm openssl tmux; do
  command -v "$cmd" >/dev/null 2>&1 || MISSING+=("$cmd")
done

# node >= 18
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | grep -oE '[0-9]+' | head -1)"
  if [[ "${NODE_MAJOR:-0}" -lt 18 ]]; then
    MISSING+=("node>=18 (found $(node --version))")
  fi
else
  MISSING+=("node>=18")
fi

# systemd --user
if ! systemctl --user status >/dev/null 2>&1; then
  MISSING+=("systemd --user (login session required)")
fi

# claude CLI
if ! command -v claude >/dev/null 2>&1; then
  MISSING+=("claude (Claude Code CLI -- install with: npm i -g @anthropic-ai/claude-code)")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: missing prerequisites:" >&2
  for m in "${MISSING[@]}"; do echo "  - $m" >&2; done
  echo >&2
  echo "Install the above, then re-run this script." >&2
  exit 1
fi

echo "Prerequisites OK."
echo

# ---------------------------------------------------------------------------
# Step 1 — select backup file
# ---------------------------------------------------------------------------
select_backup_file() {
  local path
  read -rp "Backup file path (.tar.gz.enc): " path
  path="${path/#\~/${HOME}}"   # expand leading ~
  if [[ ! -f "$path" ]]; then
    echo "ERROR: file not found: $path" >&2
    exit 1
  fi
  echo "$path"
}

BACKUP_FILE="$(select_backup_file)"
echo "Using: ${BACKUP_FILE}"
echo

# ---------------------------------------------------------------------------
# Step 2+3 — decrypt + extract
#   openssl reads passphrase from stdin; tar reads decrypted stream from pipe.
# ---------------------------------------------------------------------------
echo "[1/8] Decrypting and extracting..."

mkdir -p "${TARGET_HOME}/Projects"

read -rsp "Archive passphrase: " PASS
echo

if ! printf '%s\n' "${PASS}" \
    | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "${BACKUP_FILE}" -pass stdin \
    | tar -xzpC "${TARGET_HOME}"; then
  unset PASS
  echo "ERROR: Decryption or extraction failed (wrong passphrase or corrupt archive)." >&2
  exit 1
fi
unset PASS

echo "    Extracted to ${TARGET_HOME}"

# Disable all scheduled tasks restored from backup so they don't fire on a
# new machine before the operator explicitly re-enables them.
SCHED_DIR="${TARGET_HOME}/.claude/scheduled-tasks"
DISABLED_COUNT=0
for cfg in "${SCHED_DIR}"/*/task-config.json; do
  [[ -f "$cfg" ]] || continue
  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      d.enabled = false;
      fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    } catch(e) { process.stderr.write('WARNING: could not disable ' + p + ': ' + e.message + '\n'); }
  " "$cfg"
  DISABLED_COUNT=$(( DISABLED_COUNT + 1 ))
done
[[ $DISABLED_COUNT -gt 0 ]] && echo "    Scheduled tasks disabled (${DISABLED_COUNT}): re-enable manually after verifying the install." \
  || echo "    No scheduled tasks found."

# ---------------------------------------------------------------------------
# Step 4 — parse pinned_sha from manifest, git clone bundle, checkout
# ---------------------------------------------------------------------------
echo "[2/8] Cloning from bundle..."

MANIFEST_PATH="${PROJECT_DIR}/manifest.json"
BUNDLE_PATH="${PROJECT_DIR}/fleet.bundle"

if [[ ! -f "${MANIFEST_PATH}" ]]; then
  echo "ERROR: manifest.json not found at ${MANIFEST_PATH}" >&2
  exit 1
fi
if [[ ! -f "${BUNDLE_PATH}" ]]; then
  echo "ERROR: fleet.bundle not found at ${BUNDLE_PATH}" >&2
  exit 1
fi

PINNED_SHA="$(node -e "process.stdout.write(require('${MANIFEST_PATH}').pinned_sha)")"
ORIGINAL_USER="$(node -e "process.stdout.write(require('${MANIFEST_PATH}').original_user)")"

if [[ -z "${PINNED_SHA}" ]]; then
  echo "ERROR: could not read pinned_sha from manifest.json" >&2
  exit 1
fi

echo "    pinned_sha: ${PINNED_SHA}"

SRC_DIR="/tmp/marveen-src-$$"
rm -rf "${SRC_DIR}"
git clone "${BUNDLE_PATH}" "${SRC_DIR}"
git -C "${SRC_DIR}" checkout "${PINNED_SHA}"
echo "    Cloned and checked out ${PINNED_SHA:0:12}"

# ---------------------------------------------------------------------------
# Step 5 — npm ci + npm run build + overlay source onto project dir
# ---------------------------------------------------------------------------
echo "[3/8] Building..."
cd "${SRC_DIR}"
npm ci --silent
npm run build --silent
mkdir -p "${PROJECT_DIR}"
cp -a "${SRC_DIR}/." "${PROJECT_DIR}/"
cd "${PROJECT_DIR}"
rm -rf "${SRC_DIR}"
echo "    Build OK, source overlaid onto ${PROJECT_DIR}"

# ---------------------------------------------------------------------------
# Step 6 — .env + vault-resolved OAuth token
# ---------------------------------------------------------------------------
echo "[4/8] Configuring .env..."

ENV_BACKUP="${PROJECT_DIR}/.env-for-backup"
ENV_FILE="${PROJECT_DIR}/.env"

if [[ ! -f "${ENV_BACKUP}" ]]; then
  echo "ERROR: .env-for-backup not found in backup" >&2
  exit 1
fi

mv "${ENV_BACKUP}" "${ENV_FILE}"

if echo "CLAUDE_CODE_OAUTH_TOKEN=CLAUDE_CODE_OAUTH_TOKEN" \
    | node "${PROJECT_DIR}/scripts/vault-resolve.mjs" >> "${ENV_FILE}"; then
  echo "    OAuth token resolved from vault and appended to .env"
else
  echo "WARNING: vault-resolve failed for CLAUDE_CODE_OAUTH_TOKEN -- token may be missing" >&2
fi

# ---------------------------------------------------------------------------
# Step 7 — rename snapshot DB to live DB
# ---------------------------------------------------------------------------
SNAPSHOT_DB="${PROJECT_DIR}/store/claudeclaw-snapshot.db"
LIVE_DB="${PROJECT_DIR}/store/claudeclaw.db"

if [[ -f "${SNAPSHOT_DB}" ]]; then
  [[ -f "${LIVE_DB}" ]] && mv "${LIVE_DB}" "${LIVE_DB}.bak-restore-$(date +%Y%m%d-%H%M%S)"
  mv "${SNAPSHOT_DB}" "${LIVE_DB}"
  echo "    DB snapshot renamed to claudeclaw.db"
fi

# Clean up bundle (large, no longer needed post-clone)
rm -f "${PROJECT_DIR}/fleet.bundle"

# ---------------------------------------------------------------------------
# Step 8 — path rewrite (only if username changed)
# ---------------------------------------------------------------------------
if [[ "${TARGET_USER}" != "${ORIGINAL_USER}" ]]; then
  echo "[5/8] Rewriting paths (${ORIGINAL_USER} -> ${TARGET_USER})..."

  _rewrite_file() {
    local f="$1"
    [[ -f "$f" ]] && sed -i "s|/home/${ORIGINAL_USER}|/home/${TARGET_USER}|g" "$f"
  }

  for f in "${TARGET_HOME}/.config/systemd/user"/*.service; do
    _rewrite_file "$f"
  done
  for f in "${TARGET_HOME}/.claude/scheduled-tasks"/*/task-config.json; do
    _rewrite_file "$f"
  done
  _rewrite_file "${TARGET_HOME}/.claude/settings.json"
  # .claude.json: projects dict keys + mcpServers paths contain /home/<user>
  _rewrite_file "${TARGET_HOME}/.claude.json"
  # .bashrc: vault-resolve path references /home/<user>/Projects/marveen/...
  _rewrite_file "${TARGET_HOME}/.bashrc"

  # Rewrite absolute symlinks inside agents/ that point to the old home path
  while IFS= read -r -d '' lnk; do
    old_target="$(readlink "$lnk")"
    if [[ "$old_target" == *"/home/${ORIGINAL_USER}"* ]]; then
      new_target="${old_target/\/home\/${ORIGINAL_USER}/\/home\/${TARGET_USER}}"
      ln -sf "$new_target" "$lnk"
    fi
  done < <(find "${PROJECT_DIR}/agents" -type l -print0 2>/dev/null)

  echo "    Path rewrite done"
else
  echo "[5/8] Path rewrite: same username (${TARGET_USER}), skipped"
fi

# ---------------------------------------------------------------------------
# Step 9 — enable + start systemd units
# ---------------------------------------------------------------------------
echo "[6/8] Starting systemd services..."

systemctl --user daemon-reload
for unit in atlas-dashboard atlas-channels; do
  if systemctl --user list-unit-files "${unit}.service" >/dev/null 2>&1; then
    systemctl --user enable "${unit}.service" 2>/dev/null || true
    systemctl --user start  "${unit}.service" || true
  else
    echo "  WARNING: ${unit}.service not found, skipping"
  fi
done

loginctl enable-linger "${TARGET_USER}" 2>/dev/null || \
  echo "  NOTE: loginctl enable-linger failed (may need sudo or already enabled)"

echo "    Services started. Waiting 30s for dashboard to come up..."
sleep 30

# ---------------------------------------------------------------------------
# Step 10 — three-level verification
# ---------------------------------------------------------------------------
echo "[7/8] Verification..."

FAIL=0

# L1: DB integrity via better-sqlite3 (no sqlite3 CLI required)
if PROJECT_DIR="${PROJECT_DIR}" LIVE_DB="${LIVE_DB}" node -e '
  const Database = require(process.env.PROJECT_DIR + "/node_modules/better-sqlite3");
  const db = new Database(process.env.LIVE_DB, {readonly: true});
  const r = db.pragma("integrity_check", {simple: true});
  db.close();
  process.exit(r === "ok" ? 0 : 1);
' 2>/dev/null; then
  echo "    L1 DB integrity_check: OK"
else
  echo "    L1 DB integrity_check: FAIL" >&2
  FAIL=1
fi

# L2: dashboard HTTP 200
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3420 2>/dev/null || echo 000)"
if [[ "$HTTP_CODE" == "200" ]]; then
  echo "    L2 dashboard HTTP: OK (200)"
else
  echo "    L2 dashboard HTTP: FAIL (got ${HTTP_CODE})" >&2
  FAIL=1
fi

# L3: memories API returns non-empty response
TOKEN="$(cat "${PROJECT_DIR}/store/.dashboard-token" 2>/dev/null || echo '')"
MEM_RESP="$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:3420/api/memories?agent=atlas&q=test" 2>/dev/null || echo '')"
if [[ -n "${MEM_RESP}" && "${MEM_RESP}" != "[]" && "${MEM_RESP}" != '{"error"'* ]]; then
  echo "    L3 memories API: OK"
else
  echo "    L3 memories API: may need a moment (response: ${MEM_RESP:0:80})" >&2
fi

# Agent sessions (informational)
echo
echo "Active tmux sessions:"
tmux ls 2>/dev/null || echo "  (none yet -- agents start ~15s after dashboard)"

if [[ $FAIL -ne 0 ]]; then
  echo
  echo "WARNING: verification checks failed -- inspect journalctl and logs before assuming failure." >&2
fi

# ---------------------------------------------------------------------------
# Step 11 — post-install checklist
# ---------------------------------------------------------------------------
echo
echo "=== POST-INSTALL CHECKLIST (manual steps) ==="
echo
echo "1. Verify vault-resolved OAuth token:"
echo "   bash -c 'source ~/.bashrc && echo \$CLAUDE_CODE_OAUTH_TOKEN' | head -c 20 && echo ..."
echo
echo "2. Re-authenticate Gmail MCP (token may have expired):"
echo "   Run /check-email-gmail skill or re-auth via dashboard"
echo
echo "3. Re-authenticate Google Drive MCP:"
echo "   Run the relevant MCP auth flow"
echo
echo "4. Test Telegram bot:"
echo "   Send a message to your bot -- it should respond within ~30s (15s stagger)"
echo
echo "5. Open dashboard: http://localhost:3420"
echo
echo "6. (Optional) Verify Tailscale connectivity:"
echo "   tailscale status"
echo
if [[ $FAIL -eq 0 ]]; then
  echo "=== RESTORE COMPLETE ==="
else
  echo "=== RESTORE FINISHED WITH WARNINGS -- review output above ==="
fi
