# Backup & Visszaállítás

## Gyors indítás

### Backup létrehozása

```bash
./scripts/backup.sh
```

Létrehoz egy `marveen-backup-<TIMESTAMP>.tar.gz.enc` fájlt az aktuális könyvtárban.
A `--dry-run` kapcsolóval megtekinthető, mi kerülne az archívumba, anélkül hogy ténylegesen létrehozná.
A `--output-dir=/path/to/dir` kapcsolóval megadható a célkönyvtár.

A script jelszót kér. Jegyezd meg, nélküle a visszaállítás lehetetlen.

### Visszaállítás új gépre

1. Telepítsd az előfeltételeket: `git`, `node` (>=18), `npm`, `openssl`, `tmux`, `systemd --user`, és a `claude` CLI (`npm i -g @anthropic-ai/claude-code`).
2. Másold a `marveen-backup-*.tar.gz.enc` fájlt és a `scripts/install.sh` scriptet az új gépre.
3. Futtasd:

```bash
bash install.sh
```

A script visszafejti az archívumot, újraépíti a beágyazott git bundle-ból, beinjektálja a vault-feloldott OAuth tokent, elindítja a systemd szolgáltatásokat, és kiír egy telepítés utáni ellenőrzőlistát.

---

## Mi kerül mentésbe

Minden az `/home/northber` könyvtárhoz képest relatív elérési úttal kerül a célgépre.

| Tartalom | Elérési út az archívumban |
|---|---|
| DB pillanatkép (VACUUM INTO, nem élő WAL) | `Projects/marveen/store/claudeclaw-snapshot.db` |
| Vault + hitelesítés | `Projects/marveen/store/vault.json`, `.vault-key`, `vault-bindings.json`, `.dashboard-token` |
| Ágens állapot | `store/agents-desired.json`, `autonomy-config.json`, `auto-restart.json`, stb. |
| .env (OAuth token sor kizárva) | `Projects/marveen/.env-for-backup` |
| Homeserver tanúsítványok | `Projects/marveen/homeserver.tail*.crt / .key` |
| Claude konfig | `.claude/` (kivéve: `cache/`, `sessions/`, `tmp/`, `daemon/`) |
| systemd unitok | `.config/systemd/user/` |
| Git bundle | `Projects/marveen/fleet.bundle` (offline klón, HEAD-re rögzítve) |
| Manifest | `Projects/marveen/manifest.json` (SHA256, pinned_sha, verziók) |

**Nem kerül mentésbe** (újraépül vagy kizárva): `node_modules/`, `dist/`, `claudeclaw.db` (élő fájl, a pillanatképpel helyettesítve), `CLAUDE_CODE_OAUTH_TOKEN` (visszaállításkor vault-ból injektálva), `~/.local/share/claude` (Claude bináris, kezelten), `.claude/cache`, `.claude/sessions`, `.claude/projects` (átmeneti session adatok).

**Megjegyzés:** az ütemezett feladatok (`~/.claude/scheduled-tasks/`) visszaállítódnak, de **letiltva** (`enabled: false`). A telepítés ellenőrzése után manuálisan engedélyezd őket a dashboardon.

---

## Docker tesztállomás

Egy backup érvényességének ellenőrzéséhez tiszta környezetben, anélkül hogy az éles gépet érintenéd:

```bash
# Másold a backup archívumot a Dockerfile mellé
cp marveen-backup-*.tar.gz.enc ./marveen-backup.tar.gz.enc

echo "your-passphrase" > passphrase.txt
docker build --secret id=passphrase,src=./passphrase.txt -t marveen-fleet .
rm passphrase.txt

docker run -d -p 3420:3420 --name marveen-fleet marveen-fleet
```

Várj ~3 percet az ágensek sorba indulására, majd ellenőrizd:

```bash
# L1: DB (better-sqlite3 már megvan a node_modules-ban)
docker exec marveen-fleet node -e \
  "const d=require('/home/northber/Projects/marveen/node_modules/better-sqlite3'); \
   const db=d('/home/northber/Projects/marveen/store/claudeclaw.db',{readonly:true}); \
   console.log(db.pragma('integrity_check',{simple:true})); db.close()"

# L2: dashboard
curl -s -o /dev/null -w "%{http_code}" http://localhost:3420

# L3: memories API
TOKEN=$(docker exec marveen-fleet cat /home/northber/Projects/marveen/store/.dashboard-token)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3420/api/memories?agent=atlas&q=test"
```

Takarítás a teszt után:

```bash
docker rm -f marveen-fleet && docker rmi marveen-fleet
```

**Biztonság:** a Docker image visszafejtett titkokat tartalmaz a rétegeiben. Soha ne töltsd fel semmilyen registry-be.
