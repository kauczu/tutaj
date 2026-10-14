#!/usr/bin/env bash
# Tutaj — update the server to the newest version (also used by install.sh to start it).
#
#   sudo ./update.sh            # deploy files from git, newest image from ghcr.io, restart
#   sudo ./update.sh --no-git   # only image + restart (also: a copy of the project without git)
#
# The image is ready-made (GHCR, amd64 + arm64); TUTAJ_VERSION in .env pins a release.
# With COMPOSE_FILE=…:docker-compose.build.yml in .env (install.sh with TUTAJ_BUILD=1)
# the image is built here from the source instead. Secrets in .env are never touched.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"
GIT=1
[[ "${1:-}" == "--no-git" ]] && GIT=0

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
trap 'printf "\033[1;31m[x] Przerwano w linii %s: %s (kod %s)\033[0m\n" "$LINENO" "$BASH_COMMAND" "$?" >&2' ERR

[[ $EUID -eq 0 ]] || die "Uruchom jako root: sudo ./update.sh"
[[ -f "$ENV_FILE" ]] || die "Brak $ENV_FILE — najpierw zainstaluj: sudo ./install.sh <domena>"
cd "$DIR"

# --- Deploy files (compose, scripts, proxy templates) ------------------------------
if [[ $GIT -eq 1 ]] && git -C "$DIR/.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "Pliki wdrożenia (git pull)"
  # The checkout belongs to the user who cloned it, not root.
  owner="$(stat -c %U "$DIR/..")"
  if ! sudo -u "$owner" git -C "$DIR/.." pull --ff-only; then
    warn "git pull się nie udał (lokalne zmiany?) — kontynuuję z obecnymi plikami."
  fi
fi

# --- Image and restart ---------------------------------------------------------------
HTTP_PORT="$(grep -oP '^TUTAJ_HTTP_PORT=\K.*' "$ENV_FILE" || echo 3000)"
before="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/api/info" 2>/dev/null | grep -oP '"version":"\K[^"]+' || true)"

if grep -q '^COMPOSE_FILE=.*docker-compose.build.yml' "$ENV_FILE"; then
  say "Budowanie obrazu na serwerze (pierwszy raz kilka minut)"
  [[ -f "$DIR/../Dockerfile" ]] || die "Brak kodu źródłowego obok deploy/ — usuń COMPOSE_FILE z .env, żeby pobierać gotowy obraz."
  docker compose up -d --build --remove-orphans
else
  say "Pobieranie obrazu z ghcr.io"
  if docker compose pull tutaj; then
    docker compose up -d --remove-orphans
  else
    # Registry unreachable or the image not published: build from the source next to us, once.
    [[ -f "$DIR/../Dockerfile" ]] || die "Nie udało się pobrać obrazu, a obok nie ma kodu źródłowego do zbudowania."
    warn "Nie udało się pobrać obrazu — buduję na serwerze (kilka minut)."
    docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --remove-orphans
  fi
fi
# Old image layers (each update leaves the previous image behind).
docker image prune -f >/dev/null || true

# --- Check -----------------------------------------------------------------------------
say "Sprawdzanie"
info=""
for _ in $(seq 1 30); do
  info="$(curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/api/info" 2>/dev/null || true)"
  [[ -n "$info" ]] && break
  sleep 2
done
if [[ -n "$info" ]]; then
  version="$(grep -oP '"version":"\K[^"]+' <<<"$info" || echo '?')"
  if [[ -n "$before" && "$before" != "$version" ]]; then echo "Aplikacja: działa, wersja $before → $version"; else echo "Aplikacja: działa, wersja $version"; fi
else
  warn "Aplikacja nie odpowiada — sprawdź: cd $DIR && docker compose logs tutaj"
fi
if docker compose logs tutaj 2>/dev/null | grep -qE 'SFU +[0-9]'; then
  echo "SFU: działa ($(docker compose logs tutaj | grep -oE 'SFU +[0-9.:]+' | tail -1 | tr -s ' '))"
else
  warn "SFU nie wystartowało — sprawdź: cd $DIR && docker compose logs tutaj"
fi
