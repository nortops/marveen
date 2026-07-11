# Backup & Restore

## Quick start

### Create a backup

```bash
./scripts/backup.sh
```

Produces `marveen-backup-<TIMESTAMP>.tar.gz.age` in the current directory.
Use `--dry-run` to preview what would be included without creating an archive.
Use `--output-dir=/path/to/dir` to write the archive elsewhere.

You will be prompted for an age passphrase. Remember it — without it, restore is impossible.

### Restore on a new machine

1. Install prerequisites: `git`, `node` (>=18), `npm`, `sqlite3`, `age`, `tmux`, `systemd --user`, and the `claude` CLI (`npm i -g @anthropic-ai/claude-code`).
2. Copy `marveen-backup-*.tar.gz.age` and `scripts/install.sh` to the new machine.
3. Run:

```bash
bash install.sh
```

The script decrypts the archive, rebuilds from the embedded git bundle, injects the vault-resolved OAuth token, starts systemd services, and prints a post-install checklist.

---

## What gets backed up

Everything is extracted relative to `/home/northber` on the target machine.

| Content | Path in archive |
|---|---|
| DB snapshot (VACUUM INTO, not live WAL) | `Projects/marveen/store/claudeclaw-snapshot.db` |
| Vault + auth | `Projects/marveen/store/vault.json`, `.vault-key`, `vault-bindings.json`, `.dashboard-token` |
| Agent state | `store/agents-desired.json`, `autonomy-config.json`, `auto-restart.json`, etc. |
| .env (OAuth token row excluded) | `Projects/marveen/.env-for-backup` |
| Homeserver certs | `Projects/marveen/homeserver.tail*.crt / .key` |
| Claude config | `.claude/` (excl. `cache/`, `sessions/`, `tmp/`, `daemon/`) |
| systemd units | `.config/systemd/user/` |
| Git bundle | `Projects/marveen/fleet.bundle` (offline clone; pinned to HEAD) |
| Manifest | `Projects/marveen/manifest.json` (SHA256, pinned_sha, versions) |

**Not backed up** (rebuilt or excluded): `node_modules/`, `dist/`, `claudeclaw.db` (live file, replaced by snapshot), `CLAUDE_CODE_OAUTH_TOKEN` (re-injected from vault on restore), `~/.local/share/claude` (managed Claude binary).

---

## Docker test harness

To verify a backup is valid in a clean environment without touching the host:

```bash
# Copy backup archive next to Dockerfile
cp marveen-backup-*.tar.gz.age ./marveen-backup.tar.gz.age

echo "your-passphrase" > passphrase.txt
docker build --secret id=age_passphrase,src=./passphrase.txt -t marveen-fleet .
rm passphrase.txt

docker run -d -p 3420:3420 --name marveen-fleet marveen-fleet
```

Wait ~3 minutes for the agent stagger, then verify:

```bash
# L1: DB
docker exec marveen-fleet sqlite3 \
  /home/northber/Projects/marveen/store/claudeclaw.db "PRAGMA integrity_check;"

# L2: dashboard
curl -s -o /dev/null -w "%{http_code}" http://localhost:3420

# L3: memories API
TOKEN=$(docker exec marveen-fleet cat /home/northber/Projects/marveen/store/.dashboard-token)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3420/api/memories?agent=atlas&q=test"
```

Clean up after the test:

```bash
docker rm -f marveen-fleet && docker rmi marveen-fleet
```

**Security:** the Docker image contains decrypted secrets in its layers. Never push it to any registry.
