# Fixtures

OrcaSlicer-Profile (Version 2.4.2) für Entwicklung und Tests des Profil-Imports und Slicer-Workers.

- `user/` – exportierte Benutzer-Presets (K1, Ender 3 S1 Plus). Felder `print_host*`/`printhost_*`
  (Drucker-Adresse, API-Key) wurden entfernt. Der Profil-Import entfernt diese Felder ebenso.
- `system/` – System-Profile aus OrcaSlicer (`resources/profiles`), benötigt zum Auflösen der
  `inherits`-Ketten. Quelle: https://github.com/SoftFever/OrcaSlicer, Lizenz AGPL-3.0.
