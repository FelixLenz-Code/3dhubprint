# PrintHub

Selbst gehostete PWA zur Überwachung und Verwaltung von Klipper/Moonraker-3D-Druckern
(Fluidd/Mainsail), mit Slicing über OrcaSlicer und Auftragsverwaltung (in Arbeit).

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Spike: Moonraker-Anbindung, OrcaSlicer-CLI mit eigenen Profilen | erledigt |
| 1 | Gerüst, Login mit 2FA, Drucker verwalten, Live-Dashboard, Webcam, PWA | **erledigt** |
| 2 | Steuerung (Pause/Abbruch/Not-Aus, Temperaturen, Makros), G-Code-Upload, Verlauf | offen |
| 3 | Orca-Profilimport + Zuordnung, STL-Upload, Slicer-Worker, Aufträge | offen |
| 4 | Warteschlange mit „Bett frei“-Bestätigung, Web-Push | offen |
| 5 | Thingiverse-Suche | offen |
| 6 | Spoolman, Statistiken, Kosten | offen |

## Aufbau

```
apps/server     Fastify (TypeScript), SQLite, Moonraker-WebSocket-Clients, Auth
apps/web        React + Vite + Tailwind, PWA (vite-plugin-pwa)
packages/shared Gemeinsame Typen und Zod-Schemas
fixtures/       OrcaSlicer-Profile (K1, Ender 3 S1 Plus) für Entwicklung/Tests
```

Der Server hält pro Drucker eine WebSocket-Verbindung zu Moonraker
(`printer.objects.subscribe`) und verteilt den Status über `/api/ws` an die Browser.
Webcam-Streams und Thumbnails werden über den Server geleitet, damit unter HTTPS keine
Mixed-Content-Probleme entstehen und die Drucker nicht direkt erreichbar sein müssen.

## Installation

Auf einem frischen Debian 12/13 oder Ubuntu (z. B. Proxmox-VM):

```bash
curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/3dhubprint/main/install.sh | sudo bash
```

Der Installer
- installiert bei Bedarf Docker aus dem offiziellen Docker-Repository,
- fragt die öffentliche Adresse und die IP deines Reverse-Proxys ab,
- erzeugt `/opt/printhub/.env` mit zufälligem `APP_SECRET`,
- lädt das fertige Image von `ghcr.io` (Rückfall: Build aus dem Quellcode),
- startet PrintHub, wartet auf den Healthcheck und richtet das Kommando `printhub` ein.

Ohne Rückfragen, z. B. für Automatisierung:

```bash
curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/3dhubprint/main/install.sh | sudo bash -s -- \
  --yes --public-url https://drucker.example.de --trusted-proxies 192.168.1.5 --auto-update
```

Danach die Adresse öffnen, das Admin-Konto anlegen und **sofort unter Einstellungen → Sicherheit
die 2FA aktivieren**.

**Empfohlene VM:** 4 vCPU (CPU-Typ `host`), 6–8 GB RAM, 32 GB System + 100 GB Daten.
Für die reine Überwachung reichen 1 vCPU und 1 GB; die Reserve ist für das Slicen.

### Verwaltung und Updates

```bash
printhub status            # Zustand, Version, verfügbare Updates
printhub update            # Backup → neue Version → Healthcheck, bei Fehler automatischer Rollback
printhub rollback          # letztes Update rückgängig machen
printhub logs -f
printhub backup            # Daten + .env nach /opt/printhub/backups (die letzten 5 bleiben)
printhub restore [datei]
printhub channel edge      # Entwicklungsstand statt Releases (stable)
printhub auto-update on    # täglich 4–5 Uhr, mit Backup und Rollback
printhub config            # .env bearbeiten und neu starten
```

`APP_SECRET` in `/opt/printhub/.env` verschlüsselt API-Keys und 2FA-Geheimnisse. Nicht ändern;
es ist in jedem Backup enthalten. Backups also sicher aufbewahren.

### Releases

Ein Git-Tag `vX.Y.Z` baut über GitHub Actions das Image `ghcr.io/felixlenz-code/3dhubprint:X.Y.Z`
(und `latest`), jeder Push auf `main` das Image `:edge`. Der Kanal `stable` folgt den
GitHub-Releases.

### Moonraker

Moonraker muss Anfragen der VM erlauben. Entweder die IP der VM in `moonraker.conf` unter
`[authorization] trusted_clients` eintragen oder in PrintHub beim Drucker einen API-Key
hinterlegen (Fluidd/Mainsail → Einstellungen → Authorization).

### nginx (auf dem Reverse-Proxy-Server)

```nginx
server {
    listen 443 ssl http2;
    server_name drucker.example.de;
    # ssl_certificate ... (wie bei deinen anderen Seiten)

    client_max_body_size 500M;          # STL/3MF-Uploads (ab Phase 3)

    location / {
        proxy_pass http://<VM-IP>:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # WebSocket für Live-Daten
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;

        # MJPEG-Webcam ohne Pufferung durchreichen
        proxy_buffering off;
    }
}

# einmalig im http-Block:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

Hinweise:
- PWA-Installation, Login-Cookies (`Secure`) und später Push funktionieren nur über HTTPS.
  Für Zugriff im LAN am besten Split-DNS: die Domain intern auf den nginx auflösen.
- `TRUSTED_PROXIES` muss die IP des nginx enthalten, sonst sieht PrintHub die falsche
  Client-IP und das Protokoll (Rate-Limits, Origin-Prüfung).
- Wer ohne Proxy per `http://<VM-IP>:8080` anmelden will, braucht `COOKIE_SECURE=false`
  (der Installer fragt das ab).

## Sicherheit

- Passwörter: argon2id (OWASP-Parameter), mindestens 12 Zeichen
- Sessions: zufälliges Token im `HttpOnly; Secure; SameSite=Strict`-Cookie (`__Host-`-Präfix),
  in der DB nur als SHA-256; gleitende Laufzeit 30 Tage; einzeln widerrufbar
- 2FA: TOTP mit Replay-Schutz und 10 Einmal-Wiederherstellungscodes
- Brute-Force: Sperre nach 5 Fehlversuchen für 15 Minuten, Rate-Limit 10/min auf Login-Routen
- CSRF: Pflicht-Header `x-printhub-request` + Origin-Prüfung für alle schreibenden Anfragen
- CSP und weitere Header über helmet; Audit-Log für Anmeldungen und Sicherheitsänderungen
- Drucker-API-Keys AES-256-GCM-verschlüsselt

## Entwicklung

```bash
pnpm install
# pnpm 10.0 überspringt native Builds; einmalig:
(cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run install)
cp .env.example .env   # APP_SECRET setzen, COOKIE_SECURE=false, PORT=8090
# alternativ ohne Node: docker compose up --build (nutzt docker-compose.yml)
pnpm dev               # Server :8090, Web :5173 (Proxy auf /api)
pnpm test
pnpm typecheck
```

## Erkenntnisse OrcaSlicer-CLI (für Phase 3)

Getestet mit OrcaSlicer 2.4.2: Eigene Presets enthalten nur Abweichungen (`inherits`).
Für die CLI müssen sie gegen die System-Profile aufgelöst werden und `type` erhalten.
Das aufgelöste Maschinenprofil muss `inherits: <System-Druckername>` behalten, und die
Prozess-/Filamentprofile müssen diesen Namen in `compatible_printers` führen, sonst bricht
die CLI mit „printer is not compatible with the process preset“ (-17) ab.

## Lizenz

PrintHub steht unter der [GNU Affero General Public License v3.0 oder neuer](LICENSE)
(`AGPL-3.0-or-later`). Kurz: Du darfst PrintHub frei nutzen, ändern und weitergeben. Wer eine
geänderte Version anderen über das Netzwerk anbietet, muss deren Quellcode ebenfalls unter der
AGPL bereitstellen.

Die Lizenz wurde gewählt, weil sie zu allen verwendeten Komponenten passt:

| Komponente | Lizenz | Verhältnis zu PrintHub |
|---|---|---|
| npm-Abhängigkeiten (Fastify, React, better-sqlite3, Drizzle, …) | MIT, ISC, BSD, Apache-2.0, BlueOak | permissiv, mit AGPL kompatibel |
| OrcaSlicer-Profile (`fixtures/`, ab Phase 3 im Image) | AGPL-3.0 | gleiche Lizenzfamilie |
| OrcaSlicer (Slicer-Worker, ab Phase 3) | AGPL-3.0 | separates Programm, per CLI aufgerufen |
| Klipper, Moonraker | GPL-3.0 | nur über die Netzwerk-API angesprochen |

Details zu Drittkomponenten: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

