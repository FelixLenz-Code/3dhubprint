# PrintHub

Selbst gehostete PWA zur Überwachung und Verwaltung von Klipper/Moonraker-3D-Druckern
(Fluidd/Mainsail), mit Slicing über OrcaSlicer, Auftragsverwaltung, Statistik und Kosten.

## Stand

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Spike: Moonraker-Anbindung, OrcaSlicer-CLI mit eigenen Profilen | erledigt |
| 1 | Gerüst, Login mit 2FA, Drucker verwalten, Live-Dashboard, Webcam, PWA | erledigt |
| 2 | Steuerung (Pause/Abbruch/Not-Aus, Temperaturen, Bewegen, Makros, Objekte ausschließen), Konsole, G-Code-Upload, Verlauf | erledigt |
| 3 | Orca-Profilimport + Zuordnung, Modell-Bibliothek (STL/3MF/OBJ), Slicen mit OrcaSlicer, Aufträge, Schnelldruck | erledigt |
| 4 | Warteschlange mit „Bett frei“-Bestätigung, Druckende erkennen, Web-Push | erledigt |
| 5 | Thingiverse-Suche und -Import in die Modell-Bibliothek | erledigt |
| 6 | Spoolman, Statistiken, Kosten | **erledigt** |

## Slicen

PrintHub enthält OrcaSlicer 2.4.2 (im Docker-Image, headless). Ablauf:

1. **Einstellungen → Slicer → Profile importieren:** In OrcaSlicer *Datei → Exportieren →
   Preset-Bundle exportieren* (`.orca_printer`/`.orca_filament`) oder die JSON-Dateien aus
   `OrcaSlicer/user/default/{machine,process,filament}` hochladen. PrintHub löst die Vererbung
   gegen die Orca-System-Profile auf und entfernt Drucker-Adressen und API-Keys. Geänderte
   Profile erhalten beim erneuten Import eine neue Version; Aufträge merken sich die genutzte.
2. **Zuordnung:** Jedem Drucker ein Druckerprofil zuweisen. Prozess- und Filamentprofile sind
   automatisch auf die passenden beschränkt (`compatible_printers`), lassen sich aber auch
   ausdrücklich freigeben. Außerdem die **Druckplatte** (glatte/texturierte PEI, Cool Plate …):
   Sie bestimmt, welche Betttemperatur aus dem Filamentprofil gilt.
3. **Aufträge → Neuer Auftrag** führt in vier Schritten durch den Auftrag:
   1. *Modelle & Drucker:* Modelle hochladen oder aus der Bibliothek wählen, Drucker wählen.
   2. *Druckbett:* Alle Teile in 3D auf dem Bett, mit farbigen X/Y/Z-Achsen in der Bettecke. Pro Teil:
      Stückzahl, **Einheit** (mm/cm/Zoll/m für falsch skalierte Dateien), **„Flach hinlegen“**
      (PrintHub wählt die Seite mit der größten Auflage und den wenigsten Überhängen), Drehen in
      90°-Schritten, eine Fläche selbst wählen, Größe in %. Mit ausgeschaltetem „Automatisch anordnen“ lassen sich die Teile frei
      verschieben. Überhänge, die ohne Stützen in die Luft gedruckt würden, werden pro Teil
      gemeldet und rot markiert, mit „Stützen aktivieren“.
   3. *Einstellungen:* Qualität, Druckplatte, Filament, Stützen/Brim/Skirt/Vasenmodus.
   4. *Prüfen:* PrintHub slict und zeigt die Druckbahnen in einer drehbaren 3D-Ansicht mit
      Schichtregler, dazu Druckdauer, Filament und Kosten. Dann
      *Speichern*, *Nur übertragen*, *Drucken* oder *In Warteschlange*. Erst dann erscheint
      der Auftrag in der Liste. „Zurück zum Druckbett“ verwirft das Ergebnis.
4. **Aufträge bearbeiten:** öffnet den Assistenten mit allen Einstellungen des Auftrags. Das neu
   geslicte Ergebnis ersetzt beim Speichern den bisherigen Auftrag (auch seinen Platz in der
   Warteschlange).
5. **Schnelldruck** auf jeder Druckerseite: derselbe Assistent im Dialog, mit festem Drucker und
   den zuletzt genutzten Profilen.

Vorschaubilder für Fluidd/Mainsail rendert PrintHub selbst und bettet sie in den G-Code ein
(Größen aus der Einstellung `thumbnails` des Druckerprofils, sonst 32 und 300 px).

## Modelle & Thingiverse

Unter **Modelle** liegt die Bibliothek (Suche, Download, Mehrfachauswahl → „Auftrag anlegen“).
Der Tab **Thingiverse** zeigt Vorschläge (beliebt, neu, empfohlen), durchsucht thingiverse.com, zeigt Bilder, Lizenz, Urheber und Dateien
und übernimmt Dateien (STL/3MF/OBJ, ZIP-Archive werden entpackt) einzeln oder als Auswahl in die Bibliothek oder
direkt in einen neuen Auftrag („Slicen“),
inklusive Quelle, Lizenz und Urheber.

Einrichtung: *Einstellungen → Integrationen*. Auf thingiverse.com/developers eine App anlegen und
deren **App Token** einfügen; PrintHub prüft ihn und speichert ihn verschlüsselt. Bitte die Lizenz
der Modelle beachten (viele sind „Non-Commercial“).

Nach dem Slicen zeigt PrintHub eine **Vorschau der geslicten Platte** (aus dem G-Code gerendert:
Draufsicht des Druckbetts und 3D-Ansicht); dieselbe Ansicht wird als Vorschaubild für
Fluidd/Mainsail in den G-Code eingebettet.

## Warteschlange

Geslicte Aufträge lassen sich pro Drucker **einreihen**. PrintHub merkt sich, ob das Druckbett
frei ist: Sobald ein Druck beginnt (egal ob aus PrintHub, Fluidd oder Mainsail), gilt es als
belegt. Nach dem Druck erscheint auf Dashboard und Druckerseite **„Druckbett räumen“**; erst nach
der Bestätigung „Bett frei – starten“ beginnt der nächste Auftrag. Ist das Bett bereits als frei
bestätigt und der Drucker untätig, startet ein neu eingereihter Auftrag sofort. PrintHub verfolgt
gestartete Aufträge bis zum Ende (gedruckt, abgebrochen, fehlgeschlagen).

### Bett-Erkennung per Kamera

Optional prüft PrintHub über die Druckerkamera, ob das Bett leer ist (Einstellungen → Drucker →
Lupen-Symbol). Pro Drucker wählbar:

- **Nachfragen:** Sieht die Kamera ein leeres Bett, fragt der Banner (und eine Push-Nachricht)
  „Stimmt das?“. Erst nach „Ja“ startet der nächste Auftrag.
- **Automatisch:** Nach zwei eindeutigen „frei“-Ergebnissen hintereinander gibt PrintHub das Bett
  ohne Rückfrage frei. Ein unsicheres Ergebnis gibt nie frei.

Eingerichtet wird die Erkennung so:

1. Im Kamerabild die Druckfläche mit dem Lasso umfahren. Nur die Fläche innerhalb der Linie wird
   verglichen, Druckkopf, Rahmen und Hintergrund bleiben außen vor.
2. Mindestens ein Bild des leeren Betts speichern, am besten in der Position nach einem Druck.
   Bei mehreren Druckplatten für jede Platte ein Bild speichern.
3. Die Methode wählen (jederzeit umschaltbar):
   - **KI-Erkennung** (Standard): Ein vortrainiertes Bildmodell (DINOv2-small) beschreibt jeden
     kleinen Ausschnitt des Betts. Ein Ausschnitt gilt als belegt, wenn er keinem Ausschnitt an
     derselben Stelle der Leerbilder ähnelt. Verglichen wird nur mit den Leerbildern, die insgesamt
     am besten passen, also in der Regel mit derselben Platte. Helligkeit, Plattenfarbe und leichte
     Spiegelungen stören kaum, flache Reste werden erkannt. Das Modell (89 MB) läuft lokal auf der
     CPU, ohne Cloud, und braucht etwa 1 s pro Prüfung. Es steckt im Docker-Image; in der
     Entwicklung lädt `pnpm --filter @printhub/server model` es herunter. Fehlt es, läuft der
     Bildvergleich.
   - **Bildvergleich:** Farbe und Helligkeit des Bereichs werden mit den Leerbildern verglichen,
     Änderungen der Raumbeleuchtung herausgerechnet. Das ist sehr schnell, aber empfindlicher gegen
     Spiegelungen und andere Platten.

Jede Bestätigung „Bett ist frei“ (auch „Trotzdem frei“ nach einer falschen Belegt-Meldung) speichert
das Bild als weiteres Leerbild, bis zu 20. So lernt die Erkennung starke Lichtflecken und neue
Platten. Geprüft wird:

- **nach jedem Druck** und dann minütlich, solange das Bett als belegt gilt. So merkt PrintHub,
  wann das Teil abgenommen wurde.
- **unmittelbar vor jedem Druckstart.** Ein Auftrag aus der Warteschlange startet nur, wenn die
  Kamera in diesem Moment ein leeres Bett sieht. Sonst bleibt er wartend, das Bett gilt wieder als
  belegt, und eine Push-Nachricht meldet den angehaltenen Start. Beim Drucken von Hand (Auftrag,
  Datei, Verlauf, Schnelldruck) zeigt die Rückfrage das aktuelle Kamerabild. Sieht die Kamera
  etwas, erscheint eine Warnung mit „Trotzdem drucken“.

Die Kamera kann sich irren. Meldet sie fälschlich ein belegtes Bett, übergeht **„Trotzdem frei“**
die Warnung. Jedes von Hand bestätigte leere Bett merkt sich PrintHub als weiteres Vergleichsbild
(bis zu 10), so lernt die Erkennung typische Schatten und Positionen. Flache, sehr kleine oder
bettfarbene Reste kann die Kamera übersehen; „Nachfragen“ ist deshalb die sichere Wahl.

## Statistik & Kosten

PrintHub liest den Druckverlauf jedes Druckers aus Moonraker ein (beim Verbinden, nach jedem
Druck und alle 30 Minuten), also auch Drucke, die über Fluidd/Mainsail gestartet wurden. Die Seite
**Statistik** zeigt für 7/30/90 Tage, 12 Monate oder den gesamten Zeitraum: Anzahl und Erfolgsquote,
Druckzeit, Filament (Gewicht) und Kosten, als Verlauf je Tag/Woche/Monat sowie nach Drucker und
Material, dazu die Liste aller Drucke. Ein gelöschter Drucker behält seine Einträge.

Kosten pro Druck (*Einstellungen → Kosten*):
- **Material:** Gewicht × Preis pro kg. Der Preis kommt aus der Spoolman-Spule, sonst aus dem
  Filamentprofil (OrcaSlicer: Filament → *Kosten*), sonst aus dem Standardpreis. Er wird beim
  Einlesen des Drucks festgehalten; spätere Preisänderungen ändern alte Drucke nicht.
- **Strom:** Leistung (Standard oder pro Drucker) × Gesamtdauer × Strompreis.
- **Verschleiß** (optional): € pro Druckstunde und Drucker.

Das Gewicht stammt aus dem Verhältnis von Gewicht und Länge laut Slicer, sonst aus Durchmesser
und Dichte. Nach dem Slicen zeigt der Auftrags-Assistent die geschätzten Gesamtkosten.

## Spoolman

Optional, auf zwei Wegen:
- **Mit PrintHub installieren:** im Installer die Frage nach Spoolman bejahen (oder `--spoolman`),
  bzw. später `sudo printhub spoolman on`. Spoolman läuft dann als zweiter Container, ist in
  PrintHub automatisch verbunden und steckt in jedem `printhub backup` (Update, Rollback und
  Restore inklusive). Die Spoolman-Oberfläche ist im LAN unter `http://<server-ip>:7912`
  erreichbar. **Spoolman hat kein Login: diesen Port nicht über nginx nach außen freigeben.**
  `printhub spoolman off` entfernt den Container, die Daten bleiben in `/opt/printhub/spoolman`.
- **Eigener Spoolman-Server:** *Einstellungen → Integrationen → Spoolman* mit dessen Adresse
  (z. B. `http://192.168.1.20:7912`).

Danach:
- **Spulen anlegen** direkt in PrintHub (*Statistik → Filamentbestand → Spule anlegen* oder auf der
  Druckerseite *Neue Spule*): von einem vorhandenen oder einem neuen Filament (Hersteller, Material,
  Farbe, Gewicht, Preis), auch mehrere gleiche Spulen auf einmal. Restgewicht nach dem Nachwiegen
  eintragen und leere Spulen archivieren geht ebenfalls; alles Weitere in der Spoolman-Oberfläche.
- **Druckerseite:** aktive Spule wählen, Restmenge und Preis sehen; Warnung, wenn der laufende Druck
  mehr braucht, als auf der Spule ist.
- **Auftrags-Assistent:** Warnung, wenn die Spule nicht reicht oder ein anderes Material eingelegt ist.
- **Statistik:** Filamentbestand aller Spulen.

Verbrauch buchen: Hat ein Drucker Spoolman in seiner `moonraker.conf`
(`[spoolman]` mit `server: http://<server-ip>:7912`), setzt
PrintHub die aktive Spule über Moonraker, und Moonraker bucht den Verbrauch selbst. Sonst merkt
sich PrintHub die Spule und bucht die gedruckte Filamentlänge nach jedem Druck in Spoolman. So
wird nie doppelt gezählt.

## Benachrichtigungen

*Einstellungen → Benachrichtigungen* aktiviert Web-Push für das jeweilige Gerät: Druck fertig,
Fehler/Abbruch, pausiert (z. B. Filament leer), Klipper-Fehler oder Drucker offline während
eines Drucks, Slicen fehlgeschlagen/fertig. Voraussetzung ist HTTPS (die Domain über nginx);
auf iPhone/iPad muss PrintHub zum Home-Bildschirm hinzugefügt sein (iOS 16.4+).

## Aufbau

```
apps/server     Fastify (TypeScript), SQLite, Moonraker-WebSocket-Clients, Auth
apps/web        React + Vite + Tailwind, PWA (vite-plugin-pwa)
packages/shared Gemeinsame Typen und Zod-Schemas
fixtures/       OrcaSlicer-Profile (K1, Ender 3 S1 Plus) für Entwicklung/Tests

apps/server/src/slicer/
  profiles.ts   Orca-Presets: Typ erkennen, Vererbung auflösen, bereinigen, CLI-Dateien bauen
  mesh.ts       STL/3MF/OBJ einlesen, Maße, Software-Renderer für Vorschaubilder
  orca.ts       OrcaSlicer-CLI aufrufen, G-Code-Statistik, Vorschaubilder einbetten
  service.ts    Profile (versioniert), Zuordnung, Modell-Bibliothek, Auftrags-Warteschlange
apps/server/src/stats/service.ts     Moonraker-Verlauf spiegeln, Kosten, Auswertung nach Zeitraum
apps/server/src/spoolman/service.ts  Spoolman-Anbindung, aktive Spule, Verbrauch buchen
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
  --yes --public-url https://drucker.example.de --trusted-proxies 192.168.1.5 --auto-update --spoolman
```

Danach die Adresse öffnen, das Admin-Konto anlegen und **sofort unter Einstellungen → Sicherheit
die 2FA aktivieren**.

**Empfohlene VM:** 4 vCPU (CPU-Typ `host`), 6–8 GB RAM, 32 GB System + 100 GB Daten.
Das Image ist wegen OrcaSlicer ca. 1,2 GB groß. Im Leerlauf braucht PrintHub nur wenige
hundert MB RAM; die Reserve ist für das Slicen großer Modelle.

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
printhub spoolman on       # Spoolman mitbetreiben (off: entfernen, Daten bleiben)
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

    client_max_body_size 1024M;         # G-Code-/STL-Uploads (bis 1 GB)
    proxy_request_buffering off;        # große Uploads direkt durchreichen

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

## Erkenntnisse OrcaSlicer-CLI

Getestet mit OrcaSlicer 2.4.2: Eigene Presets enthalten nur Abweichungen (`inherits`).
Für die CLI müssen sie gegen die System-Profile aufgelöst werden und `type` erhalten.
Das aufgelöste Maschinenprofil muss `inherits: <System-Druckername>` behalten, und die
Prozess-/Filamentprofile müssen diesen Namen in `compatible_printers` führen, sonst bricht
die CLI mit „printer is not compatible with the process preset“ (-17) ab.

Im Container läuft die CLI ohne Display. Die AppImage wird beim Image-Build per `unsquashfs`
entpackt (kein FUSE nötig) und per SHA-256 geprüft. Vorschaubilder erzeugt die CLI für
STL-Eingaben nicht, daher rendert PrintHub sie selbst.

Die Druckplatte (`curr_bed_type`) ist in OrcaSlicer eine GUI-/Projekteinstellung. Ohne sie slict
die CLI immer für die Cool Plate und nimmt deren Betttemperatur. PrintHub setzt sie deshalb
ausdrücklich. Mit `--arrange 0` behält die CLI die XY-Lage der Eingabedateien und legt die Teile
nur aufs Bett. Darauf beruht die manuelle Platzierung: Drehung, Skalierung und Position
werden in temporäre STL-Dateien eingerechnet.

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
| Spoolman (optionaler Container) | MIT | separates Programm, über die REST-API angesprochen |

Details zu Drittkomponenten: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

