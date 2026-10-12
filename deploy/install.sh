#!/usr/bin/env bash
# Tutaj — server setup on Ubuntu 22.04+/Debian 12+.
#
#   sudo ./install.sh rozmowa.tutaj.eu.org [PUBLIC_IP]
#
# Works next to other services: if ports 80/443 are already taken by a web server,
# the bundled Caddy is skipped and the app listens on 127.0.0.1 only; the script then
# prepares a reverse-proxy config for the existing server (nginx, Apache, Caddy).
#
# Safe to run again: it only installs what is missing, keeps the secrets in .env,
# and never enables a firewall that is currently off (it only adds rules).
set -euo pipefail

DOMAIN="${1:-}"
PUBLIC_IP="${2:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
# Never stop silently: report which command failed.
trap 'printf "\033[1;31m[x] Przerwano w linii %s: %s (kod %s)\033[0m\n" "$LINENO" "$BASH_COMMAND" "$?" >&2' ERR

# Process name(s) listening on a port; empty when free. $1: t (tcp) or u (udp), $2: port.
port_owner() {
  { ss -"$1"lnp "sport = :$2" 2>/dev/null || true; } | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | sort -u | paste -sd, - || true
}

# How the owner lifts the server's limits for themselves.
owner_hint() {
  cat <<EOT

Klucz właściciela (zdejmuje z Ciebie limity serwera, trzymaj go w tajemnicy):
  $OWNER_KEY
Wpisz go w aplikacji: lobby → "Urządzenia i ustawienia zaawansowane" → "Klucz właściciela".
Później odczytasz go poleceniem: sudo grep OWNER_KEY $ENV_FILE
EOT
}

# Set KEY=VALUE in .env, keeping everything else.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

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
  warn "Bez poprawnego rekordu A nie będzie certyfikatu HTTPS, a TURN/SFU nie będą osiągalne pod tą nazwą."
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

# --- Ports ------------------------------------------------------------------------
say "Porty"
cd "$DIR"
# Our own containers from a previous run would show up as "busy" — stop them first.
docker compose --profile caddy down --remove-orphans >/dev/null 2>&1 || true

WEB_OWNER="$(port_owner t 80)"
WEB_OWNER_443="$(port_owner t 443)"
if [[ -z "$WEB_OWNER" && -z "$WEB_OWNER_443" ]]; then
  MODE=caddy
  echo "80 i 443 wolne → wbudowany Caddy obsłuży HTTPS."
else
  MODE=proxy
  WEB_OWNER="${WEB_OWNER:-$WEB_OWNER_443}"
  echo "80/443 zajęte przez: $WEB_OWNER → Tutaj stanie za istniejącym serwerem WWW (reverse proxy)."
fi

conflicts=0
for spec in t:3478 u:3478 t:40000 u:40000; do
  proto="${spec%%:*}" port="${spec#*:}"
  owner="$(port_owner "$proto" "$port")"
  if [[ -n "$owner" ]]; then
    if [[ $proto == t ]]; then proto_name=tcp; else proto_name=udp; fi
    warn "Port $port/$proto_name jest zajęty przez: $owner"
    conflicts=1
  fi
done
[[ $conflicts -eq 0 ]] || die "Zwolnij powyższe porty (TURN: 3478, SFU: 40000) albo zmień je w docker-compose.yml i uruchom skrypt ponownie."
RELAY_BUSY="$({ ss -ulnp 2>/dev/null || true; } | awk '{n = split($4, a, ":"); p = a[n] + 0; if (p >= 49160 && p <= 49200) print p}' | paste -sd, - || true)"
[[ -z "$RELAY_BUSY" ]] || warn "W zakresie przekaźnika TURN (49160-49200/udp) zajęte są: $RELAY_BUSY — coturn użyje pozostałych."

# Local port where the app listens on 127.0.0.1 (for the reverse proxy and health checks).
HTTP_PORT=""
CURRENT_PORT="$(grep -oP '^TUTAJ_HTTP_PORT=\K[0-9]+' "$ENV_FILE" 2>/dev/null || true)"
for candidate in $CURRENT_PORT 3000 3001 3080 8300 8301 8302; do
  if [[ -z "$(port_owner t "$candidate")" ]]; then HTTP_PORT="$candidate"; break; fi
done
[[ -n "$HTTP_PORT" ]] || die "Nie znalazłem wolnego portu lokalnego dla aplikacji (próbowałem 3000, 3001, 3080, 8300-8302)."
echo "TURN 3478 i SFU 40000 wolne. Aplikacja lokalnie: 127.0.0.1:$HTTP_PORT"

# --- Firewall ---------------------------------------------------------------------
say "Zapora (ufw)"
# Best effort: the SSH port only matters for the ufw rule; fall back to 22.
SSH_PORT="$({ ss -tlnp 2>/dev/null || true; } | awk '/sshd/ && !found {n = split($4, a, ":"); print a[n]; found = 1}')"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || SSH_PORT=22
RULES=("$SSH_PORT/tcp" 3478 40000 49160:49200/udp)
if [[ $MODE == caddy ]]; then RULES+=(80/tcp 443/tcp); fi
if command -v ufw >/dev/null 2>&1; then
  for rule in "${RULES[@]}"; do
    ufw allow "$rule" >/dev/null 2>&1 || warn "Nie udało się dodać reguły ufw: $rule"
  done
  echo "Reguły ufw: ${RULES[*]}"
  if ufw status 2>/dev/null | grep -q 'Status: active'; then
    echo "Zapora ufw jest aktywna — reguły obowiązują."
  else
    warn "ufw jest wyłączony — dodałem reguły, ale go NIE włączam (SSH na porcie $SSH_PORT jest dozwolony, gdybyś chciał: ufw enable)."
  fi
else
  warn "Brak ufw — upewnij się, że porty są otwarte w zaporze systemu."
fi
PANEL_PORTS="3478/tcp+udp, 40000/tcp+udp, 49160-49200/udp"
if [[ $MODE == caddy ]]; then PANEL_PORTS+=", 80/tcp, 443/tcp"; fi
warn "Jeśli dostawca VPS ma własną zaporę w panelu, otwórz tam: $PANEL_PORTS."

# --- .env -------------------------------------------------------------------------
say "Konfiguracja (.env)"
if [[ ! -f "$ENV_FILE" ]]; then
  (
    umask 077 # secrets: readable by root only
    cat > "$ENV_FILE" <<EOF
TURN_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
EOF
  )
  echo "Utworzono $ENV_FILE z losowymi sekretami."
else
  echo "Zostawiam sekrety z istniejącego $ENV_FILE."
fi
# Secrets added in later versions are generated once if missing.
for key in TURN_SECRET SESSION_SECRET OWNER_KEY; do
  if ! grep -q "^$key=." "$ENV_FILE"; then
    set_env "$key" "$(openssl rand -hex 32)"
    echo "Dodano brakujący sekret: $key"
  fi
done
OWNER_KEY="$(grep -oP '^OWNER_KEY=\K.*' "$ENV_FILE")"
set_env DOMAIN "$DOMAIN"
set_env PUBLIC_IP "$PUBLIC_IP"
set_env TUTAJ_HTTP_PORT "$HTTP_PORT"
if [[ $MODE == caddy ]]; then set_env COMPOSE_PROFILES caddy; else set_env COMPOSE_PROFILES ""; fi

# --- Start ------------------------------------------------------------------------
say "Budowanie i uruchamianie (pierwszy raz kilka minut)"
docker compose up -d --build --remove-orphans
docker compose ps

say "Sprawdzanie"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [[ $healthy -eq 1 ]]; then echo "Aplikacja: działa (http://127.0.0.1:$HTTP_PORT)"; else warn "Aplikacja nie odpowiada — sprawdź: docker compose logs tutaj"; fi
if docker compose logs tutaj 2>/dev/null | grep -qE 'SFU +[0-9]'; then
  echo "SFU: działa ($(docker compose logs tutaj | grep -oE 'SFU +[0-9.:]+' | tail -1 | tr -s ' '))"
else
  warn "SFU nie wystartowało — sprawdź: docker compose logs tutaj"
fi

if [[ $MODE == caddy ]]; then
  cat <<EOF

Gotowe. Otwórz:  https://$DOMAIN
$(owner_hint)
Pierwsze wejście może potrwać kilkanaście sekund — Caddy pobiera wtedy certyfikat Let's Encrypt.
Logi:            cd $DIR && docker compose logs -f
EOF
  exit 0
fi

# --- Reverse proxy for the existing web server ----------------------------------------
say "Reverse proxy dla istniejącego serwera WWW ($WEB_OWNER)"
render() { sed "s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$HTTP_PORT/g" "$DIR/proxy/$1"; }
case "$WEB_OWNER" in
  *nginx*)
    render nginx.conf > "$DIR/proxy/rendered-nginx.conf"
    cat <<EOF
Przygotowałem: $DIR/proxy/rendered-nginx.conf

Włącz go i dodaj certyfikat HTTPS:

  sudo cp $DIR/proxy/rendered-nginx.conf /etc/nginx/sites-available/tutaj
  sudo ln -sf /etc/nginx/sites-available/tutaj /etc/nginx/sites-enabled/tutaj
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx -d $DOMAIN

(Jeśli nginx nie używa sites-enabled, skopiuj plik do /etc/nginx/conf.d/tutaj.conf.
 Brak certbota: sudo apt install certbot python3-certbot-nginx)
EOF
    ;;
  *apache*|*httpd*)
    render apache.conf > "$DIR/proxy/rendered-apache.conf"
    cat <<EOF
Przygotowałem: $DIR/proxy/rendered-apache.conf

Włącz go i dodaj certyfikat HTTPS:

  sudo cp $DIR/proxy/rendered-apache.conf /etc/apache2/sites-available/tutaj.conf
  sudo a2enmod proxy proxy_http proxy_wstunnel headers
  sudo a2ensite tutaj
  sudo apache2ctl configtest && sudo systemctl reload apache2
  sudo certbot --apache -d $DOMAIN

(Brak certbota: sudo apt install certbot python3-certbot-apache)
EOF
    ;;
  *caddy*)
    render Caddyfile > "$DIR/proxy/rendered-Caddyfile"
    cat <<EOF
Przygotowałem: $DIR/proxy/rendered-Caddyfile

Dopisz blok do konfiguracji swojego Caddy (HTTPS zrobi sam):

  sudo sh -c 'cat $DIR/proxy/rendered-Caddyfile >> /etc/caddy/Caddyfile'
  sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
EOF
    ;;
  *)
    render nginx.conf > "$DIR/proxy/rendered-nginx.conf"
    cat <<EOF
Port 80/443 zajmuje: $WEB_OWNER (np. kontener Dockera z Traefikiem / nginx-proxy).
Dodaj w nim trasę dla $DOMAIN → http://127.0.0.1:$HTTP_PORT z obsługą WebSocket
(nagłówki Upgrade/Connection, długi timeout). Przykład dla nginx: $DIR/proxy/rendered-nginx.conf
Jeśli proxy działa w kontenerze, zamiast 127.0.0.1 użyj adresu hosta (np. host.docker.internal / 172.17.0.1).
EOF
    ;;
esac

cat <<EOF

$(owner_hint)

Sprawdzenie lokalne (już teraz):  curl http://127.0.0.1:$HTTP_PORT/api/health
Po skonfigurowaniu proxy otwórz:  https://$DOMAIN
Logi:                             cd $DIR && docker compose logs -f
EOF
