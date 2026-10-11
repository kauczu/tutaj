#!/usr/bin/env bash
# Tutaj — first-time server setup on Ubuntu 22.04+/Debian 12+.
#
#   sudo ./install.sh rozmowa.tutaj.eu.org [PUBLIC_IP]
#
# Safe to run again: it only installs what is missing, keeps an existing .env,
# and never enables a firewall that is currently off (it only adds rules).
set -euo pipefail

DOMAIN="${1:-}"
PUBLIC_IP="${2:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$DOMAIN" ]] || die "Podaj domenę, np.: sudo ./install.sh rozmowa.tutaj.eu.org"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || die "Nieprawidłowa domena: $DOMAIN"
[[ $EUID -eq 0 ]] || die "Uruchom jako root: sudo ./install.sh $DOMAIN"
[[ -f "$DIR/docker-compose.yml" && -f "$DIR/../Dockerfile" ]] || die "Uruchom skrypt z katalogu deploy/ rozpakowanego projektu."

# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == "ubuntu" || "$ID" == "debian" ]] || die "Obsługiwane systemy: Ubuntu, Debian (wykryto: $ID)."

# --- Public IP ------------------------------------------------------------------
say "Adres IP serwera"
if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4fsS --max-time 5 https://api.ipify.org || true)"
fi
[[ "$PUBLIC_IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "Nie udało się ustalić publicznego IPv4. Podaj go: sudo ./install.sh $DOMAIN <IP>"
echo "Publiczny IPv4: $PUBLIC_IP"
if ! ip -4 addr | grep -qw "$PUBLIC_IP"; then
  warn "Ten adres nie jest przypisany do interfejsu sieciowego (serwer jest za NAT 1:1, np. AWS/Oracle)."
  warn "To działa, o ile dostawca przekazuje WSZYSTKIE potrzebne porty (także UDP) na ten serwer."
fi

# --- DNS --------------------------------------------------------------------------
say "Rekord DNS dla $DOMAIN"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ "$RESOLVED" == "$PUBLIC_IP" ]]; then
  echo "OK: $DOMAIN → $PUBLIC_IP"
else
  warn "$DOMAIN wskazuje na '${RESOLVED:-nic}', a powinien na $PUBLIC_IP."
  warn "Bez poprawnego rekordu A Caddy nie dostanie certyfikatu HTTPS (spróbuje ponownie sam, gdy DNS zacznie działać)."
  read -r -p "Kontynuować mimo to? [t/N] " ans
  [[ "$ans" =~ ^[tTyY]$ ]] || die "Przerwano. Dodaj rekord A i uruchom skrypt ponownie."
fi

# --- Docker -----------------------------------------------------------------------
say "Docker"
if docker compose version >/dev/null 2>&1; then
  docker --version
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker --version
fi

# --- Firewall ---------------------------------------------------------------------
say "Zapora (ufw)"
SSH_PORT="$(ss -tlnpH 2>/dev/null | awk '/sshd/ {sub(/.*:/, "", $4); print $4; exit}')"
SSH_PORT="${SSH_PORT:-22}"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$SSH_PORT/tcp" comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'Tutaj HTTP' >/dev/null
  ufw allow 443/tcp comment 'Tutaj HTTPS' >/dev/null
  ufw allow 3478 comment 'Tutaj TURN' >/dev/null
  ufw allow 40000 comment 'Tutaj SFU' >/dev/null
  ufw allow 49160:49200/udp comment 'Tutaj TURN relay' >/dev/null
  if ufw status | grep -q 'Status: active'; then
    echo "Reguły dodane do aktywnej zapory ufw."
  else
    warn "ufw jest wyłączony — dodałem reguły, ale go NIE włączam (SSH na porcie $SSH_PORT jest dozwolony, gdybyś chciał: ufw enable)."
  fi
else
  warn "Brak ufw — upewnij się, że porty są otwarte w zaporze systemu."
fi
warn "Jeśli dostawca VPS ma własną zaporę (panel: Hetzner Cloud Firewall, OVH, Oracle Security List…),"
warn "otwórz tam: 80/tcp, 443/tcp, 3478/tcp+udp, 40000/tcp+udp, 49160-49200/udp."

# --- .env -------------------------------------------------------------------------
say "Konfiguracja (.env)"
ENV_FILE="$DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "Zostawiam istniejący $ENV_FILE (aktualizuję tylko DOMAIN i PUBLIC_IP)."
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/; s/^PUBLIC_IP=.*/PUBLIC_IP=$PUBLIC_IP/" "$ENV_FILE"
else
  (
    umask 077 # secrets: readable by root only
    cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
PUBLIC_IP=$PUBLIC_IP
TURN_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
EOF
  )
  echo "Utworzono $ENV_FILE z losowymi sekretami."
fi

# --- Start ------------------------------------------------------------------------
say "Budowanie i uruchamianie (pierwszy raz kilka minut)"
cd "$DIR"
docker compose up -d --build
docker compose ps

say "Sprawdzanie"
healthy=0
for _ in $(seq 1 30); do
  if docker compose exec -T tutaj node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ $healthy -eq 1 ]]; then echo "Aplikacja: działa"; else warn "Aplikacja nie odpowiada — sprawdź: docker compose logs tutaj"; fi
if docker compose logs tutaj 2>/dev/null | grep -qE 'SFU +[0-9]'; then
  echo "SFU: działa ($(docker compose logs tutaj | grep -oE 'SFU +[0-9.:]+' | tail -1))"
else
  warn "SFU nie wystartowało — sprawdź: docker compose logs tutaj"
fi

cat <<EOF

Gotowe. Otwórz:  https://$DOMAIN
Zdrowie:         curl https://$DOMAIN/api/health
Logi:            cd $DIR && docker compose logs -f
Aktualizacja:    wgraj nową wersję projektu i uruchom: cd $DIR && docker compose up -d --build

Pierwsze wejście może potrwać kilkanaście sekund — Caddy pobiera wtedy certyfikat Let's Encrypt.
EOF
