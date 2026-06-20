#!/bin/bash
# Install OAuth Token Master systemd service + timer

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

echo "Installing OAuth Token Master..."

# Make python script executable
chmod +x "${SCRIPT_DIR}/oauth-token-master.py"

# Create systemd user directory if not exists
mkdir -p "${SYSTEMD_USER_DIR}"

# Link service + timer
ln -sf "${SCRIPT_DIR}/systemd/marveen-oauth-token-master.service" \
  "${SYSTEMD_USER_DIR}/marveen-oauth-token-master.service"
ln -sf "${SCRIPT_DIR}/systemd/marveen-oauth-token-master.timer" \
  "${SYSTEMD_USER_DIR}/marveen-oauth-token-master.timer"

# Reload systemd user daemon
systemctl --user daemon-reload

# Enable timer (starts on boot)
systemctl --user enable marveen-oauth-token-master.timer

# Start immediately
systemctl --user start marveen-oauth-token-master.timer

echo "✓ OAuth Token Master installed and started"
echo ""
echo "Commands:"
echo "  systemctl --user status marveen-oauth-token-master.timer"
echo "  systemctl --user status marveen-oauth-token-master.service"
echo "  journalctl --user-unit marveen-oauth-token-master -f"
echo ""
echo "Enable in dashboard: echo '{\"shared_session_mode\": true}' > ~/.claude/.dashboard-config.json"
