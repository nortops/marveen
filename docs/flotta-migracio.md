# Flotta migráció (export / import)

> Egyetlen hordozható JSON a teljes flottáról, amivel gépek között lehet átköltözni anélkül, hogy minden ügynököt és memóriát kézzel kellene újrakonfigurálni.

---

## Mit csinál a teljes flotta migráció?

Egyetlen hordozható JSON-t készít a teljes flottáról, amit egy friss telepítésre be lehet tölteni. Segítségével gépek között lehet átköltözni anélkül, hogy az összes ügynököt és memóriát kézzel kellene újrakonfigurálni.

## Mit visz magával az export?

- Fő ügynök persona: CLAUDE.md, SOUL.md, agent-config.json, beállítások, csatorna-párosítás
- Al-ügynökök: teljes konfiguráció, személyiség, csatornák, képek
- Memóriák: az összes ügynök memóriabejegyzése (fő ügynök és al-ügynökök)
- Napi napló bejegyzések
- Skillek: globális és ügynök-szintű
- Ütemezett feladatok (szüneteltetve: enabled=false érkeznek)
- Kanban tábla: kártyák, kommentek, címkék
- Ötletláda (idea box)
- Dashboard beállítások (autonómia, auto-restart, preferenciák)
- Vault (opcionális, jelszóval titkosítva): MCP-titkok, bot-tokenek

## Mit NEM visz magával?

- Google/Gmail/Calendar OAuth bejelentkezések: a célgépen újra kell hitelesíteni
- Dashboard-token: a célgép saját tokenjét kell használni
- Forráskód és build-eredmények: a normál telepítésből jönnek (npm ci, npm run build)
- Telemetria, session-logok, conversation-history

## Dry-run biztonság

Az "Ellenőrzés" gomb csak beolvassa a fájlt és megmutatja, mi jönne létre, de nem ír semmit a rendszerbe. Az "Apply" gomb csak a dry-run után érhető el, és egy megerősítési lépéssel véd a véletlen felülírás ellen.

## Vault jelszó szerepe

Ha az exportnál megadsz jelszót, az MCP-titkok és bot-tokenek titkosítva kerülnek a JSON-ba (scrypt+AES-256-GCM). Importáláskor ugyanezt a jelszót kell megadni a visszafejtéshez. Jelszó nélkül a titkok kimaradnak, az ügynökök indulás után manuális token-beállítást igényelnek.

## Lépéssor

1. A régi gépen: Export, opcionálisan vault jelszóval. Mentsd el a JSON-t.
2. Az új gépen: telepítsd a dashboardot (git clone, npm ci, npm run build, indítás).
3. Tallózd be a JSON-t, add meg a vault jelszót (ha volt), futtasd az Ellenőrzést.
4. Ellenőrizd a dry-run összefoglalót: ügynökök, memóriák, kanban számai helyesek-e.
5. Végrehajtás (apply): az ügynökök, memóriák és beállítások beírva. A vault-titkok visszafejtve.
6. Indítsd újra a dashboardot, hitelesítsd újra az OAuth-kapcsolatokat.
