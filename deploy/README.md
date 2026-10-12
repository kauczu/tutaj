# Wdrożenie Tutaj na VPS

Efekt: `https://<twoja-domena>` z aplikacją, SFU i serwerem TURN. Wszystko działa w Dockerze:

| Usługa | Rola | Porty |
|---|---|---|
| `tutaj` | sygnalizacja, klient (PWA), SFU (mediasoup) | 40000 tcp+udp |
| `caddy` | HTTPS z automatycznym certyfikatem Let's Encrypt | 80, 443 tcp |
| `coturn` | TURN – przekaźnik dla sieci, w których P2P nie przejdzie | 3478 tcp+udp, 49160–49200 udp |

Poniżej przykładowa domena `rozmowa.tutaj.eu.org` – podstaw własną subdomenę.

## Wymagania

- VPS z **publicznym IPv4** (bez współdzielonego adresu/CGNAT), Ubuntu 22.04+ lub Debian 12+, 1–2 vCPU, 2 GB RAM.
- Dostęp SSH z uprawnieniami `sudo`.
- Możliwość dodania rekordu DNS w strefie `tutaj.eu.org`.

## 1. Rekord DNS

U dostawcy DNS domeny `tutaj.eu.org` dodaj rekord:

| Typ | Nazwa | Wartość | TTL |
|---|---|---|---|
| A | `rozmowa` | `<IP serwera>` | 300 |

Jeśli DNS jest w **Cloudflare**, ustaw rekord jako **„DNS only” (szara chmurka)**. Proxy Cloudflare nie przepuszcza
TURN ani SFU (UDP), a aplikacja łączy się z nimi pod tą samą nazwą.

Sprawdź (z własnego komputera, po kilku minutach):

```powershell
nslookup rozmowa.tutaj.eu.org
```

## 2. Zapora u dostawcy VPS

Jeśli dostawca ma zaporę w panelu (Hetzner Cloud Firewall, OVH, Oracle Security List, AWS Security Group…), otwórz:

- `80/tcp`, `443/tcp`
- `3478/tcp` i `3478/udp`
- `40000/tcp` i `40000/udp`
- `49160-49200/udp`

Zaporę systemową (`ufw`) skrypt instalacyjny skonfiguruje sam.

## 3. Wgranie projektu na serwer

Repozytorium jest prywatne, więc najprościej przesłać paczkę z bieżącą wersją. Na swoim komputerze, w katalogu `tutaj`
(PowerShell lub Git Bash):

```powershell
git archive --format=tar.gz -o tutaj.tar.gz HEAD
scp tutaj.tar.gz uzytkownik@IP_SERWERA:~
```

`git archive` bierze zatwierdzony stan repozytorium (bez `node_modules`), więc niezatwierdzone zmiany nie trafią na serwer.

## 4. Instalacja

Na serwerze (`ssh uzytkownik@IP_SERWERA`):

```bash
mkdir -p ~/tutaj && tar -xzf ~/tutaj.tar.gz -C ~/tutaj
cd ~/tutaj/deploy
sudo bash install.sh rozmowa.tutaj.eu.org
```

Skrypt:

1. ustala publiczny IP serwera (możesz go podać jako drugi argument),
2. sprawdza, czy domena wskazuje na ten IP,
3. instaluje Dockera z oficjalnego repozytorium (jeśli go nie ma),
4. dodaje reguły `ufw` (nie włącza zapory, jeśli jest wyłączona – SSH zostaje dozwolony),
5. tworzy `deploy/.env` z losowymi sekretami TURN i sesji (tylko przy pierwszym uruchomieniu),
6. buduje i uruchamia kontenery, sprawdza aplikację i SFU.

Pierwsze budowanie trwa kilka minut. Skrypt można bezpiecznie uruchomić ponownie.

### Serwer z innymi usługami (port 80/443 zajęty)

Jeśli na VPS działa już serwer WWW (nginx, Apache, Caddy, Traefik…), skrypt **nie rusza go**:

- wbudowany Caddy nie jest uruchamiany, a Tutaj nasłuchuje tylko lokalnie na `127.0.0.1:<port>`
  (pierwszy wolny z 3000, 3001, 3080, 8300–8302 – zapisany w `deploy/.env` jako `TUTAJ_HTTP_PORT`),
- skrypt rozpoznaje serwer na porcie 80 i zapisuje gotową konfigurację w `deploy/proxy/rendered-…`
  (szablony: [nginx](proxy/nginx.conf), [Apache](proxy/apache.conf), [Caddy](proxy/Caddyfile)),
- na końcu wypisuje polecenia: skopiowanie konfiguracji, przeładowanie serwera i certyfikat (`certbot` lub automatycznie w Caddy).

Ważne w konfiguracji proxy: przekazywanie WebSocket (`Upgrade`/`Connection`) i długi timeout (rozmowa trwa godzinę → połączenie
sygnalizacji też). TURN (3478) i SFU (40000) i tak działają bezpośrednio, poza serwerem WWW – te porty muszą być wolne,
skrypt sprawdza to przed startem i powie, który proces je zajmuje.

### Klucz właściciela i limity

Na koniec instalacji skrypt wypisuje **klucz właściciela** (`OWNER_KEY` w `deploy/.env`). Wpisz go w aplikacji:
lobby → „Urządzenia i ustawienia zaawansowane” → „Klucz właściciela”. Po dołączeniu zobaczysz komunikat
„Rozpoznano klucz właściciela” – limity serwera Cię wtedy nie dotyczą.

Domyślne limity dla pozostałych (zmienisz je w `deploy/.env`, potem `sudo docker compose up -d`):

| Zmienna | Domyślnie | Co ogranicza |
|---|---|---|
| `MAX_CONNECTIONS_PER_IP` | 20 | jednoczesne połączenia z jednego IP |
| `MAX_ROOMS_PER_IP` | 5 | pokoje otwarte jednocześnie przez jedno IP |
| `JOINS_PER_MINUTE` | 30 | próby dołączenia na minutę z jednego IP |
| `TURN_TTL` / `OWNER_TURN_TTL` | 14400 / 86400 | ważność poświadczeń TURN w sekundach |
| `TURN_MAX_BPS` | 625000 | przepustowość jednej sesji TURN, bajty/s w każdą stronę (~5 Mbit/s) |
| `TURN_BPS_CAPACITY` | 0 | łączna przepustowość TURN serwera, bajty/s (0 = bez limitu) |
| `TURN_USER_QUOTA` / `TURN_TOTAL_QUOTA` | 12 / 300 | alokacje TURN na uczestnika / łącznie |
| `TRUSTED_IPS` | – | adresy bez żadnych limitów, np. stały adres domowy |
| `ALLOWED_ORIGINS` | `https://<domena>` | strony, z których wolno łączyć się z sygnalizacją |

Limity coturn są ustawione daleko powyżej potrzeb rozmowy 4 osób – chronią przed użyciem serwera jako darmowego
przekaźnika, a nie ograniczają zwykłych rozmów.

### Własna domena

Domena pochodzi wyłącznie z argumentu `install.sh` (i `deploy/.env`) – nic nie jest przypięte do `o.tutaj.eu.org`.
Aplikacja desktopowa łączy się z innym serwerem przez „Zmień serwer…” w lobby. Publiczna instancja pod własną
nazwą powinna też mieć własną markę – zob. [NOTICE.md](../NOTICE.md).

## 5. Sprawdzenie

1. Otwórz `https://rozmowa.tutaj.eu.org` – powinna być kłódka (pierwsze wejście może potrwać kilkanaście sekund).
2. Dołącz z komputera i z **telefonu na danych komórkowych** (wyłączone Wi-Fi) – to wymusza drogę przez internet.
3. W **Ustawieniach** zobacz tabelę połączeń: „Trasa” = `P2P` albo `TURN` (gdy sieć wymaga przekaźnika).
4. Z trzema osobami ustaw **Tryb mediów → SFU** – znaczek na pasku zmieni się na „SFU”, obraz ma działać dalej.

Z serwera:

```bash
curl -s https://rozmowa.tutaj.eu.org/api/health      # {"ok":true,"rooms":…,"clients":…}
cd ~/tutaj/deploy && docker compose logs -f          # logi wszystkich usług
```

## Aktualizacja

Na komputerze: `git archive …` i `scp …` jak w kroku 3. Na serwerze:

```bash
rm -rf ~/tutaj.new && mkdir ~/tutaj.new && tar -xzf ~/tutaj.tar.gz -C ~/tutaj.new
cp ~/tutaj/deploy/.env ~/tutaj.new/deploy/.env
rm -rf ~/tutaj.old && mv ~/tutaj ~/tutaj.old && mv ~/tutaj.new ~/tutaj
cd ~/tutaj/deploy && sudo docker compose up -d --build
```

`.env` przenosi się ze starej wersji – sekrety się nie zmieniają, a dzięki `SESSION_SECRET` trwające rozmowy
po restarcie wracają bez renegocjacji. Poprzednia wersja zostaje w `~/tutaj.old` (cofnięcie: zamień katalogi i `up -d --build`).

## Gdy coś nie działa

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| Brak kłódki / błąd certyfikatu | Rekord A nie wskazuje na serwer albo port 80/443 zamknięty. Z wbudowanym Caddy: `docker compose logs caddy`; z własnym serwerem WWW: sprawdź, czy `certbot` się powiódł |
| 502 Bad Gateway z własnego nginx/Apache | Proxy wskazuje zły port – porównaj z `TUTAJ_HTTP_PORT` w `deploy/.env`; test: `curl http://127.0.0.1:<port>/api/health` |
| Strona działa, ale „Nie można połączyć z serwerem sygnalizacji” | Proxy nie przepuszcza WebSocket – brak nagłówków `Upgrade`/`Connection` (nginx) lub `upgrade=websocket` (Apache) |
| Strona działa, ale osoby z różnych sieci się nie widzą | TURN niedostępny: otwórz 3478 i 49160–49200/udp, sprawdź `docker compose logs coturn` |
| Po przełączeniu na SFU brak obrazu i powrót do P2P | Port 40000 zamknięty u dostawcy lub `PUBLIC_IP` w `deploy/.env` jest błędny. `docker compose logs tutaj` |
| `SFU disabled` w logach | Worker mediasoup nie wystartował (np. port 40000 zajęty). Szczegóły w logu |
| Serwer za NAT 1:1 (AWS, Oracle) | Podaj publiczny IP ręcznie: `sudo bash install.sh <domena> <publiczny-IP>` i przekieruj wszystkie porty |

Sekrety są w `deploy/.env` (uprawnienia 600) – nie kopiuj go do repozytorium.
