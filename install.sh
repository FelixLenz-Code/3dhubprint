#!/usr/bin/env bash
# PrintHub installer.
#
#   curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/3dhubprint/main/install.sh | sudo bash
#
# Options are passed through to `printhub install`, e.g.:
#   curl -fsSL …/install.sh | sudo bash -s -- --public-url https://drucker.example.de --trusted-proxies 192.168.1.5
#
#   --channel stable|edge     Releases (default) or the latest main branch
#   --version X.Y.Z           Install a specific release
#   --port N                  Host port (default 8080)
#   --bind IP                 Listen only on this host address, e.g. the LAN IP (default: all)
#   --public-url URL          Public HTTPS address behind the reverse proxy
#   --trusted-proxies IPS     Reverse proxy IP(s), comma-separated
#   --source                  Build locally instead of pulling the prebuilt image
#   --auto-update | --no-auto-update
#   -y | --yes                Non-interactive, use defaults
#
# Re-running the installer on an existing installation keeps data and configuration.

# Everything runs inside main() so a partially downloaded script never executes.
main() {
  set -Eeuo pipefail
  local repo="FelixLenz-Code/3dhubprint"
  local ref="${PRINTHUB_REF:-main}"
  local cli="/usr/local/bin/printhub"

  if [[ $EUID -ne 0 ]]; then
    echo "Bitte als root ausführen, z. B.: curl -fsSL https://raw.githubusercontent.com/$repo/main/install.sh | sudo bash" >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl wird benötigt: apt-get install -y curl" >&2
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  echo "==> Lade PrintHub-Verwaltungsskript ($ref)…"
  curl -fsSL --retry 3 --max-time 60 "https://raw.githubusercontent.com/$repo/$ref/scripts/printhub" -o "$tmp"
  if ! bash -n "$tmp"; then
    echo "Heruntergeladenes Skript ist ungültig. Bitte später erneut versuchen." >&2
    exit 1
  fi
  install -m 0755 "$tmp" "$cli"

  exec "$cli" install "$@"
}

main "$@"
