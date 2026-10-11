# Tutaj

Wideorozmowy WebRTC dla 2–4 osób, inspirowane funkcjami [MiroTalk](https://github.com/miroslavpejic85/mirotalk).
Media płyną **bezpośrednio między uczestnikami (P2P mesh)**. Serwer jest potrzebny tylko do pierwszego „przedstawienia się”
(sygnalizacji) i może nim być sama aplikacja desktopowa jednej z osób. Gdy mesh nie daje rady (3–4 osoby i słabe łącze,
przeciążony procesor albo ruch przez TURN), pokój **automatycznie przechodzi na SFU** (mediasoup) i wraca do P2P, gdy zostaną 2 osoby.

| Tryb | Czego potrzeba | Dla kogo |
|---|---|---|
| **Desktop – host w LAN** | nic poza aplikacją | spotkania w jednej sieci (dom, biuro) |
| **Własny serwer** | VPS + domena (Docker) | rozmowy przez internet, z TURN dla trudnych sieci |
| **Dev** | Node.js 22+ | rozwój |

## Funkcje

- wideo + audio w siatce do 4 osób, wskaźnik mówiącego, przypinanie kafelka, pełny ekran (dwuklik)
- udostępnianie ekranu (w desktopie: wybór ekranu/okna)
- czat i **przesyłanie plików P2P** (DataChannel, do 2 GB, z kontrolą przepływu; przeciągnij-upuść)
- podnoszenie ręki, wyciszanie, wyłączanie kamery (zwalnia urządzenie), wybór mikrofonu/kamery/głośnika
- **nagrywanie lokalne** całej rozmowy (kompozycja kafelków + miks audio → plik `.webm`)
- statystyki połączenia (RTT, straty, P2P/TURN) i wskaźnik jakości na kafelkach
- hasło pokoju, link z zaproszeniem, skróty klawiszowe (M, V, S, H, C)
- **rozmowa przetrwa awarię serwera** – trwające połączenia P2P działają dalej, klient sam wraca i wznawia sesję
- **hybryda P2P/SFU** – automatyczne przełączanie (lub ręczne: Ustawienia → Tryb mediów), simulcast, wskaźnik P2P/SFU na pasku
- PWA (instalowalna, działa offline jako „powłoka”), aplikacja desktopowa (Electron)

## Szybki start (dev)

```bash
npm install
npm run dev          # serwer :3000 + Vite :5173 (proxy /ws)
```

Otwórz http://localhost:5173 w dwóch kartach i dołącz do tego samego pokoju.

Wersja produkcyjna lokalnie:

```bash
npm run build
npm start            # http://localhost:3000 (tylko P2P)
node packages/server/dist/index.js --sfu   # z SFU na porcie 40000 (udp+tcp)
```

Testy (sygnalizacja, polityka trybu, SFU z prawdziwym workerem mediasoup): `npm test -w @tutaj/server`.

## Aplikacja desktopowa (host bez zewnętrznego serwera)

```bash
npm run desktop
```

Aplikacja uruchamia wbudowany serwer i pokazuje w lobby adresy, pod którymi inni w tej samej sieci mogą dołączyć:

- **z przeglądarki**: `https://<IP-hosta>:3443` – przy pierwszym wejściu trzeba zaakceptować certyfikat (self-signed,
  generowany i zapamiętywany przez aplikację). HTTPS jest konieczny, bo przeglądarki udostępniają kamerę tylko w bezpiecznym kontekście.
- **z drugiej aplikacji desktopowej**: w „Ustawieniach zaawansowanych” wpisz `<IP-hosta>:3000` jako serwer sygnalizacji.

Host ma też wbudowane SFU (port 40000 udp+tcp) dla pokoi 3–4 osób, w których mesh nie daje rady.

Zmienne: `TUTAJ_PORT` (3000), `TUTAJ_HTTPS_PORT` (3443), `TUTAJ_LAN=0` (tylko ta maszyna),
`TUTAJ_SFU=0` (bez SFU), `TUTAJ_SFU_PORT` (40000).
Windows zapyta o zgodę zapory na połączenia przychodzące – trzeba ją dać dla sieci prywatnych.

> Jeśli `npm run desktop` zgłasza brak pliku binarnego Electrona: `node node_modules/electron/install.js`.

## Własny serwer (internet)

`deploy/` zawiera gotowy zestaw: Tutaj + Caddy (automatyczny HTTPS) + coturn (TURN).

```bash
cd deploy
cp .env.example .env   # DOMAIN, PUBLIC_IP, TURN_SECRET, SESSION_SECRET
docker compose up -d
```

Porty: 80/443 tcp, 3478 tcp+udp, 5349 tcp, 40000 tcp+udp (SFU), 49160–49200 udp.

### Zmienne środowiskowe serwera

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | nasłuch HTTP + WebSocket (`/ws`) |
| `HTTPS_PORT` | – | włącza HTTPS (certyfikat z `TLS_KEY`/`TLS_CERT` lub self-signed w `CERT_DIR`) |
| `PUBLIC_URL` | z nagłówka Host | adres używany w linkach zaproszeń |
| `MAX_PEERS` | `4` | limit osób w pokoju |
| `STUN_URLS` | Google + Cloudflare | lista po przecinku |
| `TURN_URLS` | – | np. `turn:meet.example.com:3478` |
| `TURN_SECRET` | – | wspólny sekret z coturn (`use-auth-secret`) – poświadczenia ważne `TURN_TTL` s |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | alternatywnie stałe poświadczenia |
| `SESSION_SECRET` | losowy | podpis tokenów wznowienia sesji; ustaw, by rozmowy przeżywały restart serwera bez renegocjacji |
| `CLIENT_DIR` | `packages/client/dist` | katalog z klientem |
| `SFU` (lub flaga `--sfu`) | wyłączone | włącza SFU (mediasoup) |
| `SFU_PORT` | `40000` | jeden port UDP+TCP dla wszystkich mediów SFU |
| `SFU_ANNOUNCED_ADDRESS` | pierwszy adres LAN | publiczny IP/host, pod którym klienci łączą się z SFU (za NAT/Dockerem) |
| `SFU_LISTEN_IP` | `0.0.0.0` | interfejs nasłuchu SFU |

## Architektura

```
packages/
  shared/    protocol.d.ts – typy protokołu sygnalizacji (klient ⇄ serwer)
  server/    Node + ws: pokoje, przekazywanie sygnałów, poświadczenia TURN, hosting klienta, HTTPS self-signed,
             SFU (mediasoup) i polityka wyboru trybu mesh/SFU
  client/    TypeScript + Vite (bez frameworka), PWA
  desktop/   Electron: wbudowany serwer + okno aplikacji + wybór źródła ekranu
```

**Sygnalizacja** (WebSocket, JSON): `join` → `welcome` (lista uczestników, ICE servers, token wznowienia),
`peer-joined` / `peer-left`, `signal` (SDP/ICE do konkretnej osoby), `relay` (wiadomości aplikacji, zapas gdy DataChannel nie jest jeszcze otwarty),
`quality` / `set-mode` / `mode` (wybór trybu mediów), `sfu` → `sfu-response` + `sfu-notify` (zapytania do SFU).

**Negocjacja bez kolizji**: ofertę zawsze wysyła osoba dołączająca; druga strona tylko odpowiada. Po zestawieniu połączenia nic
nie jest renegocjowane – przełączanie kamery, urządzeń i ekranu odbywa się przez `replaceTrack`. Kanały danych są
pre-negocjowane (`negotiated: true`): `app` (stan, czat) i `file` (pliki).

**Mesh i przepustowość**: przy 4 osobach każdy wysyła 3 strumienie, więc limit bitrate wideo na połączenie maleje z liczbą
osób (1,5 → 1,0 → 0,7 Mb/s).

**Odporność**: utrata WebSocketu nie zrywa P2P. Klient łączy się ponownie z tokenem wznowienia (HMAC id+pokój), dostaje to samo
id, a zdrowe połączenia zostają. Każde `RTCPeerConnection` ma `sid`, więc nową sesję drugiej strony da się odróżnić od starej.

## SFU: kiedy i jak

Mesh jest optymalny dla 2 osób (i zwykle 3). Serwer (`policy.ts`) przełącza pokój na SFU w trybie **automatycznym**, gdy są ≥3 osoby i:

- ktoś przez ~15 s ma ograniczone wysyłanie wideo przez łącze (`qualityLimitationReason = bandwidth`) albo jego szacowany upload
  jest mniejszy niż (N−1) × 350 kb/s,
- ktoś ma przeciążony procesor (`qualityLimitationReason = cpu`),
- połączenia mesh idą przez TURN (SFU odciąża wtedy i klienta, i przekaźnik).

Raporty jakości klienci wysyłają co 5 s (tylko w trybie mesh, po 10 s „rozgrzewki” połączeń). Na SFU pokój zostaje, dopóki są
≥3 osoby (bez „migotania”), i wraca do P2P przy 2. Każdy może też wybrać tryb ręcznie: Auto / P2P / SFU.

**Przełączanie bez przerwy (make-before-break)**: przy przejściu na SFU klient najpierw zestawia transporty mediasoup i zaczyna
wysyłać, a dopiero potem wyłącza media na połączeniach mesh; kafelek pokazuje strumień z SFU, gdy ten już dociera.
Połączenia mesh zostają otwarte jako kanały danych – czat i pliki nadal idą P2P. Przy powrocie do P2P media mesh są
wznawiane przed zamknięciem SFU. Jeśli serwer (a więc SFU) zniknie, klienci natychmiast wracają do P2P.

**SFU w szczegółach**: jeden worker mediasoup, jeden `WebRtcServer` (wszystkie media na jednym porcie UDP+TCP), router na pokój,
simulcast kamery (3 warstwy od 540p, 2 poniżej – SFU wybiera warstwę dla każdego odbiorcy), Opus z DTX/FEC.
Moduł `mediasoup-client` jest ładowany leniwie – pobiera się dopiero, gdy pokój użyje SFU.

## Wygląd

Motyw opiera się na obrazie [welcome-background1.png](https://jest.tutaj.eu.org/images/welcome-background1.png)
(Ziemia o świcie i Księżyc): granat kosmosu jako tło, błękit atmosfery (`#4d9aca`) jako akcent, poświata horyzontu
(`#a8c4d8`) na wyróżnieniach, szklane panele nad sceną. Obraz jest dołączony do aplikacji jako WebP
(`packages/client/public/background.webp` 1920 px i `background-mobile.webp` 1080 px), więc działa też offline.
Kolory są zmiennymi CSS na początku `packages/client/src/style.css`.

## Ograniczenia

- ~10–20% sieci (NAT symetryczny, firmowe firewalle) wymaga TURN – w trybie LAN/desktop go nie ma.
- Certyfikat self-signed w trybie LAN wymaga jednorazowej akceptacji w przeglądarce.
- Czat i stan nie są przechowywane – kto dołączy później, nie widzi historii.
