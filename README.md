<p align="center">
  <img src="brand/social-preview.jpg" alt="Tutaj.eu.org by Lorem Ipsum" width="720" />
</p>

<p align="center">
  <b>Spójna platforma komunikacyjna.</b><br />
  <a href="https://o.tutaj.eu.org">o.tutaj.eu.org</a> · autor: <a href="https://tutaj.eu.org">Lorem Ipsum</a> · licencja kodu: <a href="LICENSE">AGPL-3.0</a>
</p>

> **Wersja wczesna (alpha).** Działa i jest testowana, ale interfejsy i konfiguracja mogą się jeszcze zmieniać.

# Tutaj

Wideorozmowy WebRTC dla 2–4 osób, inspirowane funkcjami [MiroTalk](https://github.com/miroslavpejic85/mirotalk).
Media płyną **bezpośrednio między uczestnikami (P2P mesh)**. Serwer jest potrzebny tylko do pierwszego „przedstawienia się”
(sygnalizacji) i może nim być sama aplikacja desktopowa jednej z osób. Gdy mesh nie daje rady (3–4 osoby i słabe łącze,
przeciążony procesor albo ruch przez TURN), pokój **automatycznie przechodzi na SFU** (mediasoup) i wraca do P2P, gdy zostaną 2 osoby.

| Tryb | Czego potrzeba | Dla kogo |
|---|---|---|
| **Desktop** | instalator `.exe` | domyślnie klient `o.tutaj.eu.org`; tryb lokalny: host w sieci LAN bez internetu |
| **Własny serwer** | VPS + domena (Docker) | rozmowy przez internet, z TURN dla trudnych sieci |
| **Dev** | Node.js 22+ | rozwój |

## Funkcje

- wideo + audio w siatce do 4 osób, wskaźnik mówiącego, przypinanie kafelka, pełny ekran (dwuklik)
- udostępnianie ekranu (w desktopie: wybór ekranu/okna)
- czat i **przesyłanie plików P2P** (DataChannel, do 2 GB, z kontrolą przepływu; przeciągnij-upuść)
- **reakcje** (👍 ❤️ 😂 😮 👏 🎉 – przycisk lub R, potem 1–6) unoszące się nad kafelkiem, także na nakładce w grze
- podnoszenie ręki, wyciszanie, wyłączanie kamery (zwalnia urządzenie), wybór mikrofonu/kamery/głośnika
- **nagrywanie lokalne** całej rozmowy (kompozycja kafelków + miks audio → plik `.webm`)
- statystyki połączenia (RTT, straty, P2P/TURN) i wskaźnik jakości na kafelkach
- **gospodarz pokoju** (👑, założyciel pokoju): wycisz kogoś / wszystkich, usuń z pokoju (powrót zablokowany na 10 min –
  po id sesji i adresie IP), przekaż rolę, zablokuj pokój dla nowych osób; egzekwowane przez serwer
- hasło pokoju, link z zaproszeniem, skróty klawiszowe (M, V, S, H, C, R)
- **rozmowa przetrwa awarię serwera** – trwające połączenia P2P działają dalej, klient sam wraca i wznawia sesję
- **hybryda P2P/SFU** – automatyczne przełączanie (lub ręczne: Ustawienia → Tryb mediów), simulcast, wskaźnik P2P/SFU na pasku
- **nakładka na grę** (aplikacja desktopowa) – małe kamery współgraczy nad grą, skróty działające w grze
- **szyfrowanie end-to-end także przez SFU** – serwer przekazuje obraz i dźwięk, których nie może odczytać; kody bezpieczeństwa
- **profil jakości „Gra”** – dźwięk studyjny, kamera 1080p, sprzętowe kodowanie i limit wysyłania (zob. niżej)
- **Pomoc** – skrócona instrukcja obsługi: Ustawienia → Pomoc, stopka lobby albo klawisz F1
- PWA (instalowalna, działa offline jako „powłoka”), aplikacja desktopowa (Electron) z automatycznymi aktualizacjami

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

### Testy

```bash
npm test             # serwer: sygnalizacja, polityka trybu, SFU z prawdziwym workerem mediasoup
npm run build && npm run test:e2e   # end-to-end w Chromium (Playwright)
```

Testy end-to-end (`packages/e2e`) uruchamiają prawdziwy serwer i kilku uczestników w osobnych kontekstach Chromium
z fałszywą kamerą i mikrofonem (`--use-fake-device-for-media-stream`). Sprawdzają m.in. wideo w obie strony, czat,
przesłanie pliku (SHA-256), mesh 3 osób, przełączanie P2P ⇄ SFU, automatyczne przejście na SFU i powrót do P2P,
oraz awarię serwera w trakcie rozmowy SFU. Drogę mediów weryfikują po statystykach `getStats()` każdego
`RTCPeerConnection` (połączenie z SFU rozpoznają po `ice-lite` w SDP).
Pierwsze uruchomienie wymaga przeglądarki: `npx playwright install chromium`.

CI (`.github/workflows/ci.yml`): typecheck, build, testy serwera i E2E na Linuksie, testy serwera na Windowsie,
budowanie i test dymny obrazu Dockera.

## Aplikacja desktopowa

```bash
npm run desktop
```

Aplikacja ma dwa tryby, przełączane w lobby (wybór jest zapamiętywany, aplikacja uruchamia się ponownie):

**Serwer `o.tutaj.eu.org` (domyślny)** – okno aplikacji to klient serwera Tutaj: interfejs pochodzi z serwera, więc
po jego aktualizacji aplikacja od razu ma nową wersję. Aplikacja dodaje natywny wybór ekranu/okna do udostępniania,
uprawnienia do kamery bez pytań i otwieranie linków w przeglądarce. Gdy serwer jest nieosiągalny, pokazuje ekran
„Brak połączenia” z ponowieniem (także automatycznie po powrocie internetu) i przejściem do trybu lokalnego.

**Tryb lokalny (sieć LAN, bez internetu)** – aplikacja sama jest serwerem (sygnalizacja + SFU) i pokazuje w lobby adresy,
pod którymi inni w tej samej sieci mogą dołączyć:

- **z przeglądarki**: `https://<IP-hosta>:3443` – przy pierwszym wejściu trzeba zaakceptować certyfikat (self-signed,
  generowany i zapamiętywany przez aplikację). HTTPS jest konieczny, bo przeglądarki udostępniają kamerę tylko w bezpiecznym kontekście.
- **z drugiej aplikacji desktopowej** (też w trybie lokalnym): w „Ustawieniach zaawansowanych” wpisz `<IP-hosta>:3000` jako serwer.

Windows zapyta o zgodę zapory na połączenia przychodzące – trzeba ją dać dla sieci prywatnych.

**Inny serwer** – aplikacja nie jest przywiązana do `o.tutaj.eu.org`: w lobby (tryb serwera) jest „Zmień serwer…”,
a na ekranie „Brak połączenia” – „Zmień serwer”. Kto buduje własny instalator dla swojej domeny, ustawia
`tutaj.defaultServer` w `packages/desktop/package.json`.

Zmienne (dla zaawansowanych i testów): `TUTAJ_MODE` (`remote`/`lan`), `TUTAJ_SERVER_URL` (domyślnie `https://o.tutaj.eu.org`),
`TUTAJ_USER_DATA` (osobny profil), w trybie lokalnym `TUTAJ_PORT` (3000), `TUTAJ_HTTPS_PORT` (3443),
`TUTAJ_LAN=0` (tylko ta maszyna), `TUTAJ_SFU=0` (bez SFU), `TUTAJ_SFU_PORT` (40000).

> Jeśli `npm run desktop` zgłasza brak pliku binarnego Electrona: `node node_modules/electron/install.js`.

Wersje: interfejs aplikacji desktopowej (w trybie serwera) pochodzi z serwera, a sama aplikacja to osobny program –
stopka lobby pokazuje obie wersje („serwer v… · aplikacja v…”). Ustawienia serwera i tryb LAN są w zwijanym bloku
„Serwer i sieć” (w trybie LAN rozwiniętym).

### Instalator Windows (.exe)

```bash
npm run desktop:dist     # → packages/desktop/release/Tutaj-Setup-<wersja>.exe (~120 MB)
```

Instalator NSIS (x64, po polsku): wybór katalogu, skrót na pulpicie i w menu Start, instalacja dla bieżącego
użytkownika (bez uprawnień administratora). Klient WWW jest dołączony jako zasób, a `mediasoup-worker.exe` leży
poza `app.asar`, bo musi być uruchamiany jako osobny proces.

Wydanie na GitHubie: wypchnięcie tagu (`git tag v0.1.0 && git push origin v0.1.0`) uruchamia workflow
`release.yml`, który buduje instalator i publikuje go w Releases. Ręczne uruchomienie workflow zapisuje
instalator tylko jako artefakt.

Instalator nie jest podpisany – Windows SmartScreen przy pierwszym uruchomieniu pokaże ostrzeżenie
(„Więcej informacji” → „Uruchom mimo to”). Usunie je dopiero certyfikat do podpisywania kodu.

### Aktualizacje aplikacji desktopowej

Od wersji 0.3.1 aplikacja kilka sekund po starcie sprawdza najnowsze wydanie na GitHubie (`electron-updater`,
pliki `latest.yml` i `.blockmap` publikowane obok instalatora). Gdy jest nowsza wersja, pyta: **Aktualizuj** /
**Później** / **Pomiń tę wersję**. Po zgodzie pobiera ją z okienkiem postępu (procent, MB, prędkość; „Ukryj” –
pobieranie trwa w tle z postępem na ikonie na pasku zadań, „Anuluj”), sprawdza sumę
SHA-512, instaluje po cichu i uruchamia się ponownie – a jeśli trwa rozmowa, najpierw pyta, czy ją przerwać
(albo instaluje przy zamknięciu aplikacji). Ręcznie: menu (Alt) → „Sprawdź aktualizacje…”.

Własna kompilacja z innego repozytorium: zmień `build.publish` (owner/repo) w `packages/desktop/package.json`.
Test bez publikowania: `TUTAJ_UPDATE_FEED=http://…/` (katalog z `latest.yml` i instalatorem) – aplikacja pokaże
ofertę i pobierze plik, ale go nie zainstaluje.

Aplikacja pamięta też rozmiar, położenie i maksymalizację okna (`settings.json`; jeśli monitor zniknął, okno wraca
na główny), a lobby – ostatnie imię i pokój.

## Własny serwer (internet)

`deploy/` zawiera gotowy zestaw: Tutaj + Caddy (automatyczny HTTPS) + coturn (TURN) oraz skrypt instalacyjny.
Instrukcja krok po kroku (DNS, zapora, wgranie, instalacja, sprawdzenie, aktualizacja): **[deploy/README.md](deploy/README.md)**.

```bash
sudo bash deploy/install.sh rozmowa.tutaj.eu.org
```

Porty: 80/443 tcp, 3478 tcp+udp (TURN), 40000 tcp+udp (SFU), 49160–49200 udp (przekaźnik TURN).

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
| `OWNER_KEY` | – | klucz właściciela: zdejmuje limity, dłuższe poświadczenia TURN (zob. niżej) |
| `TRUSTED_IPS` | – | adresy/podsieci IPv4 bez limitów, np. `203.0.113.7,198.51.100.0/24` |
| `ALLOWED_ORIGINS` | origin z `PUBLIC_URL` | strony, które mogą łączyć się z sygnalizacją; `*` wyłącza kontrolę |
| `TRUST_PROXY` | – | `1` = prawdziwe IP klienta z `X-Forwarded-For` (za reverse proxy) |
| `LIMITS` | włączone przy `NODE_ENV=production` | `0` wyłącza limity na IP |
| `MAX_CONNECTIONS_PER_IP` / `MAX_ROOMS_PER_IP` / `JOINS_PER_MINUTE` | 20 / 5 / 30 | limity na adres IP |
| `TURN_TTL` / `OWNER_TURN_TTL` | 14400 / 86400 s | ważność poświadczeń TURN (zwykli użytkownicy / właściciel) |

### Ochrona serwera publicznego

Publiczny serwer z darmowym TURN i SFU łatwo nadużyć. Domyślnie (w obrazie Dockera) działają więc:

- **lista dozwolonych originów** – sygnalizacji nie użyje cudza strona,
- **limity na adres IP** – połączenia, otwarte pokoje, dołączenia na minutę,
- **krótko ważne poświadczenia TURN** (4 h) oraz **limity coturn** – przepustowość na sesję, liczba alokacji.

**Właściciel nie jest ograniczany.** Instalator generuje `OWNER_KEY` i wypisuje go na koniec. Wpisany w lobby
(„Urządzenia i ustawienia zaawansowane” → „Klucz właściciela”) zdejmuje limity pokoi i dołączeń i daje poświadczenia
TURN ważne 24 h. Pełne zwolnienie, także z limitu połączeń, zapewnia `TRUSTED_IPS` (np. stały adres domowy).
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

## Jakość i profil „Gra”

Ustawienia jakości są w lobby („Urządzenia, jakość i ustawienia zaawansowane”) i w trakcie rozmowy (Ustawienia). Zmiany działają
od razu, bez ponownego łączenia (w trybie SFU kodek obrazu zmienia się przy następnym przełączeniu trybu).

| | Rozmowa (domyślny) | Gra |
|---|---|---|
| Dźwięk | Opus 64 kb/s, redukcja echa, szumów i automatyczne wzmocnienie | **studyjny**: Opus stereo 160 kb/s, bez filtrów – wymaga słuchawek |
| Kamera | 720p, 30 kl/s | 1080p, 30 kl/s (jeśli kamera pozwala) |
| Limit wysyłania | brak (decyduje estymacja pasma) | 4 Mb/s – rozmowa nie zapcha łącza i nie podniesie pingu w grze |

Wspólne dla obu profili:

- **RED** (redundantne audio) w P2P i **FEC** Opusa – zgubiony pakiet nie powoduje dziury w dźwięku;
- **kodowanie sprzętowe**: gdy karta graficzna koduje H.264, obraz idzie w H.264 (procesor zostaje dla gry); można też
  wybrać H.264 lub VP8 ręcznie. Wykrywanie to krótka próba kodowania przez lokalne połączenie (Chromium zgłasza
  `mediaCapabilities.powerEfficient = false` nawet przy działającym NVENC). Kodek wybiera każdy nadawca osobno
  (`RTCRtpEncodingParameters.codec`), niezależnie od preferencji rozmówcy;
- przy przeciążeniu kamera traci rozdzielczość, a nie płynność (`degradationPreference: maintain-framerate`);
- w aplikacji desktopowej okno rozmowy w tle (za grą) nie jest spowalniane przez Chromium;
- „Wysyłasz: …” w Ustawieniach pokazuje bieżącą rozdzielczość, kodek (sprzętowo/programowo) i przepływności;
  znacznik **GPU** / **CPU** obok P2P/SFU na pasku rozmowy mówi, który koder faktycznie koduje teraz obraz kamery.

Gdy ktoś wysyła w wysokiej jakości (dźwięk studyjny lub 1080p), pokój z ≥3 osobami od razu przechodzi na SFU –
N−1 strumieni 1080p z jednego łącza to zbyt wiele dla typowego uploadu i dla pingu w grze.

Stereo i wysoki bitrate Opusa w P2P wymagają parametrów `stereo=1`/`maxaveragebitrate` w SDP (`tuneOpusSdp`); docelowa
przepływność jest ustawiana per nadawca (`RTCRtpSender.setParameters`), więc zmienia się bez renegocjacji.

### Nakładka na grę (aplikacja desktopowa)

Małe kamery współgraczy w rogu ekranu, nad grą: nazwa, podświetlenie mówiącego, znacznik wyciszenia; osoba z wyłączoną
kamerą zajmuje tylko wąski pasek. Gdy Twój mikrofon jest wyciszony, nad kafelkami świeci czerwony znacznik.

- przycisk nakładki w pasku rozmowy; opcja „pokazanie nakładki minimalizuje okno rozmowy, ukrycie je przywraca”
  (działa przy ręcznym przełączaniu, nie przy automatycznym otwarciu nakładki na początku rozmowy);
- **skróty działające w grze** (aktywne tylko w trakcie rozmowy): domyślnie **Ctrl+Shift+O** – pokaż/ukryj nakładkę,
  **Ctrl+Shift+M** – wycisz/włącz mikrofon (krótki sygnał dźwiękowy potwierdza zmianę), **Ctrl+Shift+H** –
  zminimalizuj/przywróć okno rozmowy. Można je zmienić w Ustawieniach:
  kliknij skrót i naciśnij nową kombinację (Ctrl, Alt lub Win z klawiszem albo sam klawisz F1–F24; skrót zajęty przez
  inny program jest odrzucany);
- ustawienia (Ustawienia → Nakładka na grę): monitor, róg ekranu, rozmiar, krycie; zapamiętywane;
- nakładka to osobne okno: przezroczyste, zawsze na wierzchu, **nie przechwytuje myszy ani klawiatury** i nigdy nie
  zabiera grze fokusu; okno ma dokładnie rozmiar swojej zawartości;
- **nie ingeruje w proces gry** (żadnego wstrzykiwania do DirectX/Vulkan), więc nie koliduje z systemami anti-cheat;
  ceną jest to, że widać ją nad grami w trybie **„pełny ekran w oknie” (bez ramek)**, a nie w wyłącznym pełnym ekranie;
- pokazuje te same strumienie co okno rozmowy (popup tej samej strony) – bez dodatkowego dekodowania i ruchu sieciowego.
  Każdy strumień jest dekodowany raz, niezależnie od liczby okien, które go wyświetlają; samo rysowanie obrazu w oknie
  rozmowy schowanym za grą to ok. 0,5% CPU (pomiar: 3 osoby).

## Szyfrowanie end-to-end

W trybie **P2P** media i kanały danych szyfruje sam WebRTC (DTLS-SRTP) – bezpośrednio między uczestnikami.
W trybie **SFU** serwer przekazuje strumienie, więc Tutaj szyfruje dodatkowo **każdą zakodowaną klatkę** obrazu i dźwięku
(WebRTC Encoded Transform, `RTCRtpScriptTransform`), zanim trafi do serwera:

- każdy uczestnik losuje własny klucz AES-256-GCM i przekazuje go pozostałym **kanałem danych P2P** (DTLS, poza
  serwerem); klucz nigdy nie idzie przez sygnalizację – wiadomości z kluczem przekazane przez serwer są ignorowane;
- gdy ktoś wychodzi, pozostali zmieniają klucze (stary jeszcze przez chwilę odszyfrowuje klatki w drodze);
- w klatce zostają jawne tylko bajty, których potrzebuje SFU: nagłówek VP8, nagłówki NAL H.264 do pierwszego wycinka
  (reszta po zaszyfrowaniu jest „escapowana”, żeby nie powstał kod startu), bajt TOC Opusa – i one też są
  uwierzytelniane (AAD), więc nie da się ich podmienić; każda klatka ma losowy IV;
- odbiorca odrzuca każdą klatkę, której nie da się odszyfrować i uwierzytelnić – nic niezaszyfrowanego nie trafi do
  dekodera;
- **nic niezaszyfrowanego nie wyjdzie do serwera**: nadajnik startuje na wyłączonej kopii ścieżki, a prawdziwa kamera
  i mikrofon idą dopiero, gdy worker potwierdzi, że klatki faktycznie przechodzą przez szyfrowanie. Chromium po cichu
  pomija transformację przypisaną po negocjacji połączenia, dlatego Tutaj podpina ją wewnątrz negocjacji
  mediasoup-client (`addTransceiver` / zdarzenie `track`) i to weryfikuje; gdy się nie da – pokój wraca do P2P;
- klient bez obsługi szyfrowania (np. stara przeglądarka) trzyma pokój w P2P – serwer nie wybierze wtedy SFU.

**Kod bezpieczeństwa** (Ustawienia → tabela połączeń): skrót obu odcisków certyfikatów DTLS danego połączenia P2P.
Serwer sygnalizacji teoretycznie mógłby podstawić własne certyfikaty (atak „man in the middle”) – wtedy kody po obu
stronach się różnią. Zgodny kod, porównany głosem, potwierdza, że klucze dotarły do właściwej osoby.

Testy: `packages/client/test/frame.test.ts` (format klatki, ucieczka H.264, odrzucanie złych kluczy i zmian) oraz
`e2e/tests/e2ee.spec.ts` (uczestnik bez kluczy nie widzi obrazu, rotacja, klient bez E2EE, kody, awaria szyfrowania).

## SFU: kiedy i jak

Mesh jest optymalny dla 2 osób (i zwykle 3). Serwer (`policy.ts`) przełącza pokój na SFU w trybie **automatycznym**, gdy są ≥3 osoby i:

- ktoś przez ~15 s ma ograniczone wysyłanie wideo przez łącze (`qualityLimitationReason = bandwidth`) albo jego szacowany upload
  jest mniejszy niż (N−1) × 350 kb/s,
- ktoś ma przeciążony procesor (`qualityLimitationReason = cpu`),
- połączenia mesh idą przez TURN (SFU odciąża wtedy i klienta, i przekaźnik),
- (warunek konieczny) wszyscy uczestnicy obsługują szyfrowanie end-to-end klatek – inaczej pokój zostaje w P2P,
- ktoś wysyła w wysokiej jakości (profil „Gra”) – wtedy bez czekania.

Raporty jakości klienci wysyłają co 5 s (tylko w trybie mesh, po 10 s „rozgrzewki” połączeń). Na SFU pokój zostaje, dopóki są
≥3 osoby (bez „migotania”), i wraca do P2P przy 2. Każdy może też wybrać tryb ręcznie: Auto / P2P / SFU.

**Przełączanie bez przerwy (make-before-break)**: przy przejściu na SFU klient najpierw zestawia transporty mediasoup i zaczyna
wysyłać, a dopiero potem wyłącza media na połączeniach mesh; kafelek pokazuje strumień z SFU, gdy ten już dociera.
Połączenia mesh zostają otwarte jako kanały danych – czat i pliki nadal idą P2P. Przy powrocie do P2P media mesh są
wznawiane przed zamknięciem SFU. Jeśli serwer (a więc SFU) zniknie, klienci natychmiast wracają do P2P.

**SFU w szczegółach**: jeden worker mediasoup, jeden `WebRtcServer` (wszystkie media na jednym porcie UDP+TCP), router na pokój,
simulcast kamery (3 warstwy od 540p, 2 poniżej – SFU wybiera warstwę dla każdego odbiorcy, suma mieści się w limicie wysyłania),
Opus stereo z FEC.
Moduł `mediasoup-client` jest ładowany leniwie – pobiera się dopiero, gdy pokój użyje SFU.

## Wygląd

Motyw opiera się na grafice autora (Ziemia o świcie i Księżyc, `brand/background.jpg`): granat kosmosu jako tło,
błękit atmosfery (`#4d9aca`) jako akcent, poświata horyzontu (`#a8c4d8`) na wyróżnieniach, szklane panele nad sceną
i logo „Tutaj.eu.org by Lorem Ipsum”. Grafika jest dołączona do aplikacji jako WebP
(`packages/client/public/background.webp` 1920 px, `background-mobile.webp` 1080 px), więc działa też offline.
Kolory są zmiennymi CSS na początku `packages/client/src/style.css`.

## Licencja i marka

Kod: © 2026 Lorem Ipsum, [AGPL-3.0](LICENSE). Nazwa „Tutaj”, pseudonim „Lorem Ipsum”, logo, ikony i grafika tła
**nie są objęte licencją kodu** – wszelkie prawa zastrzeżone. Własna instancja lub fork musi mieć własną markę;
co dokładnie zmienić, opisuje [NOTICE.md](NOTICE.md).

## Ograniczenia

- ~10–20% sieci (NAT symetryczny, firmowe firewalle) wymaga TURN – w trybie LAN/desktop go nie ma.
- Certyfikat self-signed w trybie LAN wymaga jednorazowej akceptacji w przeglądarce.
- Czat i stan nie są przechowywane – kto dołączy później, nie widzi historii.
