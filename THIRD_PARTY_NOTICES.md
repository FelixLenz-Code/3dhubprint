# Hinweise zu Drittkomponenten

PrintHub selbst steht unter `AGPL-3.0-or-later` (siehe [LICENSE](LICENSE)).

## OrcaSlicer-Profile

`fixtures/orca-2.4.2/system/` enthält unveränderte System-Profile aus OrcaSlicer 2.4.2
(`resources/profiles`), `fixtures/orca-2.4.2/user/` daraus abgeleitete Benutzer-Profile.

- Projekt: https://github.com/SoftFever/OrcaSlicer
- Lizenz: GNU Affero General Public License v3.0

## OrcaSlicer (ab Phase 3)

Der Slicer-Worker ruft die OrcaSlicer-Kommandozeile als eigenständiges Programm auf. Wird
OrcaSlicer mit einem PrintHub-Image ausgeliefert, gilt dafür dessen AGPL-3.0; der Quellcode ist
unter obiger Adresse verfügbar.

## npm-Pakete

Die im Docker-Image enthaltenen npm-Pakete stehen unter permissiven Lizenzen (MIT, ISC,
BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0). Ihre Lizenztexte liegen jeweils im
Paketverzeichnis unter `node_modules`. Übersicht erzeugen:

```bash
pnpm --filter @printhub/server licenses list --prod
pnpm --filter @printhub/web licenses list --prod
```

## Klipper und Moonraker

PrintHub enthält keinen Code aus Klipper oder Moonraker (beide GPL-3.0), sondern kommuniziert
ausschließlich über die dokumentierte Moonraker-API.
