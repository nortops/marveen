# Architekturális terv: Per-agent workspace + Per-agent skill-scoping

Készítette: Daidalosz | 2026-07-23 | TERV FÁZIS — NEM implementálva

> **Norbert kategorikus megkötése (2026-07-23):**
> - Ágensek munkafájlait SOHA nem töröljük, csak helyezzük át (`mv`) a scratch-space-be
> - `store/` takarításnál (bak fájlok, logok) a törlés CSAK Norbert explicit jóváhagyásával mehet; a terv listázza a jelölteket, de nem töröl semmit magától
> - `agents/hestia/store/` különösen érzékeny (`vault.json`, `claudeclaw.db`): csak elemezzük, nem nyúlunk hozzá döntés nélkül
> - Minden fájlmigráció `mv`-alapú és rollback-elhető

---

## 1. Per-agent lokális workspace + repo-takarítás

### 1.1 Jelenlegi helyzet (tényszerű leltár)

| Ágens | Munkafájlok az `agents/<name>/` repo-ban |
|-------|------------------------------------------|
| hermes | `drafts/`, `inbox/`, `relaxter-current.jpeg`, `relaxter-fixed.jpeg`, `relaxter-fixed2.jpeg`, `relaxter-fixed3.jpeg`, `relaxter-fixed4.jpeg` |
| prometheus | `drafts/`, `inbox/`, `.playwright-mcp/` (Playwright MCP cache: 15+ yml/log fájl) |
| hestia | `store/` (a fő `store/` teljes tükrének tűnik: `claudeclaw.db`, `vault.json`, `vault-bindings.json`, `autonomy-config.json`, `agents-desired.json`, 30+ fájl) |
| daidalosz | Nincs szemét (külön marveen-dev workspace van) |
| irisz | Tiszta (eddig) |
| atlas | Nincs home `agents/`-ban |
| `store/` (fő) | `server.ts.bak-permrouting`, `server.ts.bak-permrouting-0.0.6-20260624-1640`, `server.ts.bak-permrouting-20260617-212436` (elavult backup fájlok) |

**Kritikus eset: `agents/hestia/store/` elemzése**

A tartalom azonos fájlneveket tartalmaz mint a fő `store/` (claudeclaw.db, vault.json, vault-bindings.json, autonomy-config.json, agents-desired.json, stb. — összesen 30+ fájl).

Érzékeny fájlok benne: `vault.json`, `vault-bindings.json`, `claudeclaw.db` (SQLite adatbázis). Ezekhez **nem nyúlunk** döntés nélkül.

Lehetséges státuszok:

| Státusz | Jelei | Teendő |
|---------|-------|--------|
| Elavult maradvány (senki nem írja) | `claudeclaw.db` mtime régi, nem nő | `mv` → `~/.marveen/scratch/hestia/store-backup/` + git-ből törlés |
| Aktívan szinkronizált tükör (valamilyen Hestia logika vagy szimlink-ekvivalens) | `claudeclaw.db` mtime friss, egyezik a fő store-éval | Nem migrálható amíg a szinkron mechanizmus nincs megértve és leállítva |
| Valaha szimlink volt, mára valódi könyvtár | `ls -la` nem mutat `->` jelölést, de tartalom azonos | `mv` → backup helyre, ellenőrzés után döntés |

**Javasolt diagnózis (kód nélkül, csak read-only):**
```bash
# Mtime összehasonlítás a fő store claudeclaw.db-vel:
stat agents/hestia/store/claudeclaw.db store/claudeclaw.db
# Szimlink-e?
ls -la agents/hestia/store
# Méret egyezik-e?
du -sh agents/hestia/store/claudeclaw.db store/claudeclaw.db
```

**Ez a pont döntést igényel Norberttől mielőtt bármilyen migráció történik. A jelenlegi tervben ez a könyvtár érintetlen marad.**

---

### 1.2 Javasolt megoldás: `~/.marveen/scratch/<agent>/`

**Alapelv:** az `agents/<name>/` mappa kizárólag konfigurációs terület (`CLAUDE.md`, `agent-config.json`, `.claude/`, `memory/`, `SOUL.md`, `avatar.png`). Minden futásidejű munkafájl, vázlat, cache, letöltés, média a repo-n KÍVÜLRE kerül.

**Miért nem `.gitignore` megoldás:**
- Csak a git szennyezést oldja meg, az ágensek közötti összekeveredést nem
- Pattern-ek upstream PR-ekben ütközhetnek
- Nem kommunikál szándékot az ágensek felé (nincs canonical "itt dolgozz" hely)

#### Célstruktúra

```
~/.marveen/scratch/
  hermes/
    drafts/           <- email draft, kimenő vázlat
    inbox/            <- bejövő feldolgozandó anyag
    media/            <- képek, videók (relaxter-*.jpeg stb.)
  prometheus/
    drafts/
    inbox/
    playwright-cache/ <- .playwright-mcp/ tartalma
  hestia/
    store/            <- agents/hestia/store/ tartalma (HA aktív, döntés után)
  irisz/
    drafts/
    inbox/
    media/
  daidalosz/
    (marveen-dev már megvan, scratch üres maradhat)
```

---

### 1.3 Szükséges kód- és konfigváltozások

#### A) `src/web/agent-scaffold.ts` — `scaffoldAgentDir()` bővítése

Az új ágensek scaffold-olásakor automatikusan jöjjön létre a scratch könyvtár:

```typescript
// scaffoldAgentDir() végén hozzáadni:
const scratchDir = join(homedir(), '.marveen', 'scratch', name)
mkdirSync(join(scratchDir, 'drafts'), { recursive: true })
mkdirSync(join(scratchDir, 'inbox'), { recursive: true })
mkdirSync(join(scratchDir, 'media'), { recursive: true })
```

#### B) `templates/CLAUDE.md.template` — "Munkaterület" szekció hozzáadása

Minden ágensnek egyértelművé tenni, hol tároljon munkafájlokat:

```markdown
## Munkaterület

Konfigurációs home: `agents/{{AGENT_NAME}}/` (csak konfig, ne szemetelje munkafájlokkal)
Scratch/munkaterület: `~/.marveen/scratch/{{AGENT_NAME}}/`
  - `drafts/`  — vázlatok, piszkozatok, kimenő anyag feldolgozás előtt
  - `inbox/`   — bejövő feldolgozandó fájlok
  - `media/`   — képek, videók, dokumentumok
```

Ezt az egyéni `agents/<name>/CLAUDE.md`-kbe is be kell szúrni (hermes, prometheus, irisz; hestia döntés után).

#### C) `store/` takarítás — törlési jelöltek (CSAK Norbert jóváhagyásával)

A következő fájlok törlésre javasoltak, de **nem törlünk semmit amíg Norbert explicit jóváhagyást nem ad**:

| Fájl | Miért törölhető | Kockázat |
|------|-----------------|----------|
| `store/server.ts.bak-permrouting` | Kézzel mentett backup, 2026-06-17-es dátumból | Alacsony: ez a módosítás már production-ban van |
| `store/server.ts.bak-permrouting-0.0.6-20260624-1640` | Backup 2026-06-24-ről | Alacsony |
| `store/server.ts.bak-permrouting-20260617-212436` | Backup 2026-06-17-ről | Alacsony |

Ha Norbert jóváhagyja, a törlés így néz ki (visszafordíthatatlan, ezért jóváhagyás kell):
```bash
# CSAK jóváhagyás után futtatható:
rm store/server.ts.bak-permrouting
rm store/server.ts.bak-permrouting-0.0.6-20260624-1640
rm store/server.ts.bak-permrouting-20260617-212436
```

**Logfájlok** (`store/*.log`): a futó rendszer folyamatosan írja ezeket, nem érintjük.

---

### 1.4 Migrációs lépések (PR-ben, fázisosan)

**Előfeltételek:**
- Hestia store státusza tisztázva (Norbert döntés)
- store/ bak fájlok törlése Norbert által jóváhagyva

**SZABÁLY: minden lépés `mv`-alapú, semmi sem törlődik, rollback mindig lehetséges.**

```bash
# 1. Scratch könyvtárak létrehozása (idempotens, biztonságos)
mkdir -p ~/.marveen/scratch/hermes/{drafts,inbox,media}
mkdir -p ~/.marveen/scratch/prometheus/{drafts,inbox,playwright-cache}
mkdir -p ~/.marveen/scratch/irisz/{drafts,inbox,media}
mkdir -p ~/.marveen/scratch/hestia  # hestia/store csak döntés után

# 2. Hermes munkafájlok áthelyezése (mv, nem rm)
mv /home/northber/Projects/marveen/agents/hermes/relaxter-current.jpeg ~/.marveen/scratch/hermes/media/
mv /home/northber/Projects/marveen/agents/hermes/relaxter-fixed.jpeg ~/.marveen/scratch/hermes/media/
mv /home/northber/Projects/marveen/agents/hermes/relaxter-fixed2.jpeg ~/.marveen/scratch/hermes/media/
mv /home/northber/Projects/marveen/agents/hermes/relaxter-fixed3.jpeg ~/.marveen/scratch/hermes/media/
mv /home/northber/Projects/marveen/agents/hermes/relaxter-fixed4.jpeg ~/.marveen/scratch/hermes/media/
# drafts/ és inbox/ tartalma:
[ -d /home/northber/Projects/marveen/agents/hermes/drafts ] && \
  mv /home/northber/Projects/marveen/agents/hermes/drafts ~/.marveen/scratch/hermes/
[ -d /home/northber/Projects/marveen/agents/hermes/inbox ] && \
  mv /home/northber/Projects/marveen/agents/hermes/inbox ~/.marveen/scratch/hermes/

# 3. Prometheus munkafájlok áthelyezése (mv, nem rm)
[ -d /home/northber/Projects/marveen/agents/prometheus/drafts ] && \
  mv /home/northber/Projects/marveen/agents/prometheus/drafts ~/.marveen/scratch/prometheus/
[ -d /home/northber/Projects/marveen/agents/prometheus/inbox ] && \
  mv /home/northber/Projects/marveen/agents/prometheus/inbox ~/.marveen/scratch/prometheus/
[ -d /home/northber/Projects/marveen/agents/prometheus/.playwright-mcp ] && \
  mv /home/northber/Projects/marveen/agents/prometheus/.playwright-mcp \
     ~/.marveen/scratch/prometheus/playwright-cache

# 4. Hestia store (CSAK Norbert döntése után, kommentelve hagyva):
# mv /home/northber/Projects/marveen/agents/hestia/store ~/.marveen/scratch/hestia/store-backup

# 5. Store bak fájlok áthelyezése (CSAK Norbert törlési jóváhagyása után,
#    de ha csak archiválni kell, mv is elegendő):
# mv /home/northber/Projects/marveen/store/server.ts.bak-permrouting \
#    ~/.marveen/scratch/store-archive/
# mv /home/northber/Projects/marveen/store/server.ts.bak-permrouting-0.0.6-20260624-1640 \
#    ~/.marveen/scratch/store-archive/
# mv /home/northber/Projects/marveen/store/server.ts.bak-permrouting-20260617-212436 \
#    ~/.marveen/scratch/store-archive/
```

### 1.5 Rollback

```bash
mv ~/.marveen/scratch/hermes/drafts /home/northber/Projects/marveen/agents/hermes/
mv ~/.marveen/scratch/hermes/inbox /home/northber/Projects/marveen/agents/hermes/
mv ~/.marveen/scratch/hermes/media/relaxter-*.jpeg /home/northber/Projects/marveen/agents/hermes/
mv ~/.marveen/scratch/prometheus/drafts /home/northber/Projects/marveen/agents/prometheus/
mv ~/.marveen/scratch/prometheus/inbox /home/northber/Projects/marveen/agents/prometheus/
mv ~/.marveen/scratch/prometheus/playwright-cache /home/northber/Projects/marveen/agents/prometheus/.playwright-mcp
```

### 1.6 Hatás a futó ágensekre

- **Marveen szerver nem olvas** `drafts/`/`inbox/`/`.playwright-mcp/` könyvtárakból, nincs service restart szükséges
- **Playwright MCP cache** regenerálódik automatikusan az első Playwright-híváskor
- **Hermes/Prometheus ágensek CLAUDE.md** frissítése szükséges, hogy az új scratch helyre írjanak (különben tovább fognak a régi helyre írni)
- **Hestia store** migráció külön döntést igényel

---

## 2. Per-agent skill-scoping

### 2.1 Jelenlegi helyzet

- **76 globális skill** `~/.claude/skills/`-ban, shared HOME-on keresztül minden ágensnek egyformán látható
- **Per-ágensspecifikus** `.claude/skills/` mappák üresek (infrastruktúra megvan, tartalom nincs)
- `agent-config.json`-ban **nincs skill-szűrési mező**
- `skill-index.sh` már **tud `AGENT_DIR` módban** merged indexet generálni (globális + ágensspecifikus, Scope oszloppal)
- A skill-index a `~/<agent-home>/.claude/skills/.skill-index.md`-be íródik és onnan kerül az ágensek kontextusába

### 2.2 Javasolt megoldás

**Minimális változás elve:** a meglévő infrastruktúrára épít, nem vezet be új rétegeket. Két komponens:

1. **`skillAllowlist` mező az `agent-config.json`-ban** — opcionális lista, ami megmondja melyik globális skill-eket lássa az ágens
2. **`scripts/skill-index.sh` szűrési ág** — ha van allowlist, csak a listán szereplő globális skill-ek kerülnek az indexbe

#### Séma (agent-config.json)

```json
{
  "model": "claude-sonnet-4-6",
  "displayName": "Hermes",
  "skillAllowlist": [
    "check-email-gmail",
    "send-email-gmail",
    "outbound-email-via-hermes",
    "gmail-calendar-mcp-oauth-setup",
    "webshop-order-browser",
    "notion-mcp-auth",
    "notion-page-rebuild",
    "shopify-store-connect",
    "budaura-shopify-ops"
  ]
}
```

**Backward compatibility:** ha a mező hiányzik (`undefined`), a jelenlegi viselkedés marad (minden 76 globális skill látszik). Fokozatosan lehet bevezetni.

---

### 2.3 Megvalósítás részletei

#### A) `scripts/skill-index.sh` módosítása (~15 sor)

Az `AGENT_DIR` módban, mielőtt a globális skill-eket indexeli, beolvassa az allowlist-et:

```bash
# Az AGENT_DIR ág elejére (a MERGED=1 blokk után):
ALLOWLIST=""
if [ "$MERGED" = "1" ] && [ -f "$AGENT_DIR/agent-config.json" ]; then
  # jq elérhető, használjuk; ha nem: python3 fallback
  if command -v jq &>/dev/null; then
    ALLOWLIST=$(jq -r '.skillAllowlist // [] | .[]' "$AGENT_DIR/agent-config.json" 2>/dev/null | tr '\n' '|' | sed 's/|$//')
  else
    ALLOWLIST=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print('|'.join(d.get('skillAllowlist', [])))
" "$AGENT_DIR/agent-config.json" 2>/dev/null)
  fi
fi
```

Az `index_skills_dir()` függvénybe szűrési feltétel a globális ághoz:

```bash
index_skills_dir() {
  local dir="$1"
  local scope="$2"
  for skill_dir in "$dir"/*/; do
    [ -d "$skill_dir" ] || continue
    local skill_md="$skill_dir/SKILL.md"
    [ -f "$skill_md" ] || continue
    local name
    name=$(grep -m1 "^name:" "$skill_md" 2>/dev/null | sed 's/^name: *//' | tr -d '"' | tr -d "'")
    [ -z "$name" ] && name=$(basename "$skill_dir")

    # Szűrés: globális skill-eknél ha van allowlist, csak benne szereplők mehetnek
    if [ "$scope" = "global" ] && [ -n "$ALLOWLIST" ]; then
      echo "$name" | grep -qE "^($ALLOWLIST)$" || continue
    fi

    local desc
    desc=$(grep -m1 "^description:" "$skill_md" 2>/dev/null | sed 's/^description: *//' | tr -d '"' | tr -d "'" | cut -c1-120)
    [ -z "$desc" ] && desc="(nincs leírás)"
    # ... rest unchanged
  done
}
```

#### B) `src/web/agent-scaffold.ts` — scaffoldAgentDir() melletti skill-allowlist export

Opcionális: ha az `agent-config.json`-ban van `skillAllowlist`, a scaffold kiírja egy `.skill-allowlist` fájlba is (bash-barát formátum). Ez csak kényelmi lépés, a `jq`/`python3` megoldás nélkül is működik.

#### C) `src/web/routes/skills.ts` — opcionális dashboard szűrő

A `/api/skills?agent=hermes` query param alapján a dashboard is tudjon szűrve megjeleníteni. Ez alacsonyabb prioritású, scope-on kívülre lehet venni az első PR-ből.

---

### 2.4 Javasolt allowlistek (76 skill → ágensekre)

Az összes 76 skill alapján kategorizálva:

#### Atlas (orkesztrációs főágens)
**Javasolt:** nincs `skillAllowlist` (minden látszik). Indok: Atlas orkesztrál, delegál, bármilyen témában kell eligazodnia. Ha mégis szűrni kellene, a fleet-ops + admin + minden delegáló skill kell neki.

#### Daidalosz (fejlesztés, code review, PR)
```json
"skillAllowlist": [
  "adversarial-pr-review-loop",
  "contribute-feature-upstream",
  "git-push-target-preflight",
  "github-auth-vault-rewire",
  "github-pr-rebase-merge",
  "marveen-deploy-branch-setup",
  "marveen-update",
  "weekly-upstream-integration",
  "skill-factory",
  "skill-management",
  "headless-screenshot-html-review",
  "multi-round-design-with-dev-agent",
  "dashboard-staging-preview",
  "fleet-agent-security-profile",
  "diagnose-fleet-restart"
]
```

#### Hermes (email, webshop, external comms)
```json
"skillAllowlist": [
  "check-email-gmail",
  "send-email-gmail",
  "outbound-email-via-hermes",
  "gmail-calendar-mcp-oauth-setup",
  "webshop-order-browser",
  "notion-mcp-auth",
  "notion-page-rebuild",
  "shopify-store-connect",
  "budaura-shopify-ops"
]
```

#### Hestia (monitoring, backup, scheduling)
```json
"skillAllowlist": [
  "verify-fleet-backup-safely",
  "verify-scheduler-loop-alarm",
  "diagnose-fleet-restart",
  "diagnose-port-exposure",
  "diagnose-external-url-unreachable",
  "diagnose-usb-disk-hot-idle",
  "clear-via-fleet-restart",
  "fleet-helper",
  "duplicate-scheduled-task",
  "reggeli-napindito",
  "create-voice-briefing-task",
  "manage-egress-allowlist",
  "marveen-update",
  "env-var-token-drift-fix"
]
```

#### Irisz (marketing, kreatív, Shopify)
```json
"skillAllowlist": [
  "kling-cli-setup",
  "kling-ugc-video-prompt-iteration",
  "canva-design-generation",
  "budaura-shopify-ops",
  "shopify-store-connect",
  "notion-mcp-auth",
  "notion-page-rebuild",
  "research-to-notion",
  "n8n-automation-via-api",
  "dream-engine",
  "headless-screenshot-html-review"
]
```

#### Prometheus (kutatás, research, web)
```json
"skillAllowlist": [
  "deep-research",
  "research-to-notion",
  "notion-mcp-auth",
  "notion-page-rebuild",
  "webshop-order-browser",
  "markdown-to-pdf-headless-chrome",
  "headless-screenshot-html-review",
  "screen-control-display-1"
]
```

---

### 2.5 Illeszkedés a progressive-disclosure rendszerhez

| Szint | Változás |
|-------|----------|
| Level 0 (`.skill-index.md`) | Szűrt index → kevesebb zaj, gyorsabb trigger-match az ágensek kontextusában |
| Level 1 (teljes SKILL.md betöltés) | Változatlan |
| Level 2 (scripts/, references/) | Változatlan |
| Ágensspecifikus `.claude/skills/` | MINDIG benne van az indexben, allowlist-től függetlenül |

**Token-hatás becslés:** 76 skill indexe kb. 76 × 2 sor = ~150 sor. Hermes 9 skill-lel → ~18 sor. Prometheus 8-cal → ~16 sor. Nem drámai megtakarítás soronként, de a triggerek pontossága nő (kevesebb false-positive skill-invokáció).

---

## 3. Összefoglalás és döntési pontok

### Amit Atlas/Norbert döntése kell

1. **Hestia `agents/hestia/store/` státusza:** elavult maradvány (törölhető) vagy aktívan írja valami? Ha aktív, ki írja és mire kell?
2. **Atlas allowlist:** legyen-e atlas-nak is szűrése, vagy maradjon szűrés nélkül (minden 76 skill látszik)?
3. **Skill-allowlistek jóváhagyása:** a 2.4-es javasolt listák megfelelők, vagy módosítandók?
4. **PR fázisok:** egy PR-ban megy minden, vagy két külön (workspace + takarítás, skill-scoping)?

### Változások összefoglalója

| Komponens | Változás típusa |
|-----------|-----------------|
| `src/web/agent-scaffold.ts` | Kód: scratch dir létrehozás + (opcionálisan) skill-allowlist export |
| `scripts/skill-index.sh` | Kód: ~15 sor szűrési ág hozzáadása |
| `agents/*/agent-config.json` | Konfig: `skillAllowlist` mező hozzáadása (5 ágensben, atlas kivételével) |
| `agents/*/CLAUDE.md` | Szöveg: "Munkaterület" szekció (hermes, prometheus, irisz; hestia döntés után) |
| `templates/CLAUDE.md.template` | Szöveg: workspace szekció az új ágenseknek |
| Fájlmigráció | One-time: `agents/hermes/`, `agents/prometheus/` munkafájlok → `~/.marveen/scratch/` |
| `store/` takarítás | One-time: 3 db `server.ts.bak-*` törlése |
| `agents/hestia/store/` | Döntés után |

**Amit most azonnal lehet csinálni (Norbert jóváhagyásával, PR nélkül):**
- Hermes és Prometheus munkafájlok `mv` a scratch-be (nincs kódváltozás, service restart sem kell)
- CLAUDE.md frissítése hermes/prometheus-nál (hogy az ágensek az új helyre írjanak)

**Amit kódváltozás nélkül NEM lehet:** scaffolding (új ágenseknél automatikus scratch létrehozás), skill-index.sh szűrés.

**Törlés semmi sem történik** amíg Norbert explicit jóváhagyást nem ad. A bak fájlokat archivációval (mv) is el lehet távolítani a repo-ból törlés helyett.
