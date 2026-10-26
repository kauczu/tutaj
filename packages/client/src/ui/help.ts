import { lang } from '../i18n';
import { $, h } from './dom';
import { formatAccelerator, type Hotkeys } from './hotkeys';
import { PipWindow } from './pip';

type Block = HTMLElement | string;

const section = (title: string, ...body: Block[]) => h('section', {}, h('h3', { text: title }), ...body);
const p = (...parts: Block[]) => h('p', {}, ...parts);
const list = (...items: Block[][]) => h('ul', {}, ...items.map((parts) => h('li', {}, ...parts)));
const steps = (...items: Block[][]) => h('ol', { class: 'steps' }, ...items.map((parts) => h('li', {}, ...parts)));
const code = (text: string) => h('code', { text });
const b = (text: string) => h('strong', { text });
const kbd = (text: string) => h('kbd', { text });

function keys(rows: [string, string][]): HTMLTableElement {
  return h('table', { class: 'keys' }, h('tbody', {}, ...rows.map(([k, what]) => h('tr', {}, h('td', {}, kbd(k)), h('td', { text: what })))));
}

/** What the guide shows: desktop-only parts (overlay, global shortcuts, menu) appear in the app only. */
interface Context {
  hotkeys: Hotkeys | null;
  desktop: boolean;
}

function polish({ hotkeys, desktop }: Context): HTMLElement[] {
  return [
    section(
      'Jak zacząć',
      steps(
        ['Wpisz swoje ', b('imię'), '. Nazwę ', b('pokoju'), ' zostaw wylosowaną (↻ losuje nową) albo wpisz własną — np. umówioną ze znajomymi.'],
        ['Kliknij ', b('Dołącz'), '. Przeglądarka zapyta o dostęp do kamery i mikrofonu — zezwól.'],
        ['Zaproś innych: przycisk ', b('Kopiuj zaproszenie'), ' (na telefonie pod „⋯”) kopiuje link — wyślij go komunikatorem. Kto go otworzy, trafi do Twojego pokoju; może też wpisać tę samą nazwę pokoju.'],
        ['Rozmawiajcie. Koniec rozmowy — czerwony przycisk ze słuchawką.'],
      ),
      p(b('Dobrze wiedzieć:')),
      list(
        ['Do pokoju może wejść każdy, kto zna jego nazwę — dlatego losowa jest trudna do zgadnięcia. Możesz też ustawić ', b('hasło pokoju'), ' (lobby → „Urządzenia, jakość i ustawienia zaawansowane”; ustala je pierwsza osoba).'],
        ['W pokoju mogą być ', b('maks. 4 osoby'), '. Imię i ostatni pokój są zapamiętywane.'],
        ['Kamera i mikrofon włączają się dopiero po dołączeniu i wyłączają po rozłączeniu. Przyciski pod podglądem wybierają, z czym dołączysz (wybór jest zapamiętywany); „Włącz podgląd” pozwala wcześniej sprawdzić obraz i dźwięk.'],
        ['Język interfejsu zmienisz w ustawieniach zaawansowanych lobby. Ta pomoc jest zawsze pod klawiszem ', kbd('F1'), ' i w Ustawieniach.'],
      ),
    ),
    section(
      'W trakcie rozmowy',
      keys([
        ['M', 'mikrofon włącz/wyłącz'],
        ['V', 'kamera włącz/wyłącz'],
        ['S', 'udostępnianie ekranu'],
        ['H', 'podnieś/opuść rękę'],
        ['C', 'czat'],
        ['R', 'reakcja — potem 1–6 (👍 ❤️ 😂 😮 👏 🎉)'],
        ...(PipWindow.supported() ? ([['P', 'obraz w obrazie — małe okno z kamerami zawsze na wierzchu']] as [string, string][]) : []),
        ['F1', 'ta pomoc'],
      ]),
      list(
        ['Kliknięcie kafelka powiększa osobę, dwuklik — pełny ekran.'],
        [b('Na telefonie'), ' rozmówca zajmuje cały ekran, a Twoja kamera to małe okienko w rogu — przeciągnij je w inny róg albo dotknij, żeby zamienić widoki. Pasek przycisków chowa się sam; dotknij obrazu, żeby go przywrócić. Pozostałe opcje (ręka, ustawienia, zaproszenie, przełączenie kamery przód/tył) są pod „⋯”.'],
        ...(PipWindow.supported()
          ? [[b('Obraz w obrazie'), ' (przycisk lub P) otwiera się też sam, gdy przejdziesz do innej karty — rozmowa zostaje na wierzchu, z przyciskami mikrofonu, kamery i rozłączenia.'] as Block[]]
          : []),
        ['Kropka przy imieniu to jakość połączenia (zielona — dobra, żółta — średnia, czerwona — słaba).'],
        ['Czat przesyła też ', b('pliki'), ' (do 2 GB) — bezpośrednio między uczestnikami; przeciągnij plik do czatu lub użyj spinacza.'],
        [b('Nagrywanie'), ' zapisuje rozmowę na Twoim komputerze (plik .webm); pozostali dostają informację w czacie.'],
      ),
    ),
    section(
      'Gospodarz pokoju 👑',
      list(
        ['Gospodarzem jest osoba, która założyła pokój; gdy wyjdzie, rola przechodzi na kolejną osobę (albo gospodarz ją przekazuje).'],
        ['Gospodarz ma na kafelkach innych menu ', b('⋮'), ': wycisz mikrofon, przekaż rolę gospodarza, usuń z pokoju.'],
        ['Usunięta osoba nie wróci do pokoju przez 10 minut (dotyczy też innych osób z tego samego adresu internetowego).'],
        ['Ustawienia → Pokój → ', b('Zablokuj pokój'), ' — nikt nowy nie dołączy; ', b('Wycisz wszystkich'), '. Wyciszony uczestnik może sam włączyć mikrofon z powrotem.'],
      ),
    ),
    section(
      'Jakość obrazu i dźwięku',
      list(
        ['Ustawienia → Jakość → ', b('Profil jakości'), ': „Rozmowa” (domyślny) albo „Gra” — dźwięk studyjny, kamera 1080p, limit wysyłania 4 Mb/s.'],
        [b('Dźwięk studyjny'), ' jest bez redukcji echa i szumów — najlepiej na słuchawkach. Grasz na głośnikach? Zaznacz „Usuwanie echa”: zostaje stereo i bez innych filtrów, a rozmówcy nie usłyszą siebie (dźwięk gry z głośników nadal mogą słyszeć).'],
        ['Znacznik ', b('GPU'), ' / ', b('CPU'), ' na pasku: czy obraz koduje karta graficzna (lepiej podczas gry), czy procesor.'],
        [b('P2P'), ' — obraz płynie bezpośrednio między uczestnikami; ', b('SFU'), ' — przez serwer (przy 3–4 osobach lub słabym łączu). Przełącza się samo; można wybrać ręcznie w Ustawieniach → Połączenie.'],
      ),
    ),
    section(
      'Prywatność i szyfrowanie',
      list(
        ['Rozmowy są ', b('szyfrowane end-to-end'), ' (znacznik ', b('E2EE'), ' na pasku): w trybie P2P robi to WebRTC, w trybie SFU każda klatka obrazu i dźwięku jest dodatkowo szyfrowana kluczami, które znają tylko uczestnicy — serwer przekazuje dane, których nie może odczytać.'],
        ['Klucze wymieniacie bezpośrednio między sobą; po wyjściu kogoś z pokoju zmieniają się, więc ta osoba nie zobaczy dalszej części rozmowy.'],
        [b('Kod bezpieczeństwa'), ': Ustawienia → Połączenie, kolumna „Kod”. Porównajcie go głosem — jeśli u obu jest taki sam, nikt (także serwer) nie podsłuchuje.'],
        ['Czat i pliki płyną bezpośrednio między uczestnikami, też szyfrowane.'],
      ),
    ),
    ...(hotkeys
      ? [
          section(
            'Gra: nakładka i skróty',
            p('Nakładka pokazuje małe kamery współgraczy w rogu ekranu, nad grą. Nie przechwytuje myszy ani klawiatury.'),
            list(
              ['Włączysz ją przyciskiem z ikoną ekranu na pasku rozmowy, skrótem albo w Ustawieniach → „Nakładka i skróty” (tam też monitor, róg, rozmiar, krycie).'],
              ['Gra musi działać w trybie ', b('„pełny ekran w oknie” / bez ramek'), ' — nad wyłącznym pełnym ekranem żadne okno się nie pokaże.'],
            ),
            p('Skróty działające także w grze (tylko w trakcie rozmowy; zmienisz je w Ustawieniach → Nakładka i skróty):'),
            keys([
              [formatAccelerator(hotkeys.overlay), 'pokaż/ukryj nakładkę'],
              [formatAccelerator(hotkeys.mute), 'wycisz/włącz mikrofon (z sygnałem dźwiękowym)'],
              [formatAccelerator(hotkeys.window), 'zminimalizuj/przywróć okno rozmowy'],
            ]),
          ),
        ]
      : []),
    section(
      'Klucz właściciela serwera',
      p('Dotyczy tylko osoby, która prowadzi serwer Tutaj (np. postawiła go u siebie). Zwykli uczestnicy go nie potrzebują — rozmowy działają bez niego.'),
      list(
        [b('Skąd go wziąć'), ': skrypt instalacyjny serwera wypisuje go na końcu instalacji. Jest też zapisany na serwerze w pliku ', code('deploy/.env'), ' (zmienna ', code('OWNER_KEY'), '), np. ', code('grep OWNER_KEY ~/tutaj/deploy/.env'), '. Na o.tutaj.eu.org ma go tylko właściciel tego serwera.'],
        [b('Gdzie wpisać'), ': w lobby, przed dołączeniem — „Urządzenia, jakość i ustawienia zaawansowane” → „Klucz właściciela serwera”. Zostaje zapamiętany w tej przeglądarce lub aplikacji. Po dołączeniu zobaczysz komunikat „Rozpoznano klucz właściciela”; błędny klucz niczego nie psuje — po prostu nic nie zmienia.'],
        [b('Co daje'), ': zdejmuje limity, którymi serwer chroni się przed nadużyciem — liczbę otwartych pokoi z jednego adresu (domyślnie 5) i dołączeń na minutę (30) — oraz wydłuża ważność dostępu do przekaźnika TURN z 4 do 24 godzin, więc długie rozmowy w trudnych sieciach się nie urwą.'],
        [b('Kiedy warto'), ': gdy zobaczysz „Masz już otwartą maksymalną liczbę pokoi” albo „Za dużo prób” (np. kilka osób z jednej sieci domowej, testy) albo przed rozmową dłuższą niż 4 godziny.'],
        [b('Czego nie daje'), ': nie czyni Cię gospodarzem pokoju, nie omija hasła, blokady pokoju, limitu 4 osób ani usunięcia z pokoju i nie daje dostępu do cudzych rozmów (są szyfrowane end-to-end). Nie zdejmuje też limitu jednoczesnych połączeń z jednego adresu (20) — to robi wpis ', code('TRUSTED_IPS'), ' na serwerze.'],
        [b('Ostrożnie'), ': nie wpisuj go na cudzym komputerze. Jeśli wycieknie, zmień ', code('OWNER_KEY'), ' w ', code('deploy/.env'), ' i uruchom ', code('sudo docker compose up -d'), ' w katalogu ', code('deploy'), '.'],
      ),
    ),
    section(
      'Gdy coś nie działa',
      list(
        [b('Brak obrazu z kamery / „urządzenie zajęte”'), ' — zamknij inne programy, które jej używają (Teams, Discord, OBS).'],
        [b('Brak dostępu do kamery lub mikrofonu'), ' — Windows: Ustawienia → Prywatność i zabezpieczenia → Kamera / Mikrofon (zezwól aplikacjom).'],
        [b('Rozmówcy słyszą echo'), ' — załóż słuchawki, zaznacz „Usuwanie echa” albo wybierz dźwięk „Rozmowa” w Ustawieniach → Jakość.'],
        [b('Ktoś się nie łączy'), ' — sprawdź kropkę jakości i tabelę w Ustawieniach → Połączenie; w sieciach firmowych połączenie idzie przez serwer TURN i może trwać dłużej.'],
        ...(desktop
          ? [[b('Aplikacja'), ': klawisz ', kbd('Alt'), ' pokazuje menu — zmiana serwera, tryb sieci lokalnej (bez internetu), sprawdzenie aktualizacji.'] as Block[]]
          : []),
      ),
    ),
  ];
}

function english({ hotkeys, desktop }: Context): HTMLElement[] {
  return [
    section(
      'Getting started',
      steps(
        ['Enter your ', b('name'), '. Keep the random ', b('room'), ' name (↻ draws a new one) or type your own — e.g. one agreed with your friends.'],
        ['Click ', b('Join'), '. The browser asks for the camera and microphone — allow them.'],
        ['Invite others: ', b('Copy invitation'), ' (on a phone under “⋯”) copies a link — send it via a messenger. Whoever opens it lands in your room; they can also type the same room name.'],
        ['Talk. To end the call, use the red button with the handset.'],
      ),
      p(b('Good to know:')),
      list(
        ['Anyone who knows a room’s name can enter it — that is why the random one is hard to guess. You can also set a ', b('room password'), ' (lobby → “Devices, quality and advanced settings”; the first person sets it).'],
        ['A room holds ', b('up to 4 people'), '. Your name and the last room are remembered.'],
        ['The camera and microphone turn on only when you join and off when you hang up. The buttons under the preview choose what you join with (the choice is remembered); “Start preview” lets you check picture and sound first.'],
        ['The interface language is in the lobby’s advanced settings. This help is always under ', kbd('F1'), ' and in the Settings.'],
      ),
    ),
    section(
      'During a call',
      keys([
        ['M', 'microphone on/off'],
        ['V', 'camera on/off'],
        ['S', 'share the screen'],
        ['H', 'raise/lower your hand'],
        ['C', 'chat'],
        ['R', 'reaction — then 1–6 (👍 ❤️ 😂 😮 👏 🎉)'],
        ...(PipWindow.supported() ? ([['P', 'picture-in-picture — a small always-on-top window with the cameras']] as [string, string][]) : []),
        ['F1', 'this help'],
      ]),
      list(
        ['Click a tile to enlarge that person, double-click for full screen.'],
        [b('On a phone'), ' the other person fills the screen and your camera is a small window in a corner — drag it to another corner or tap it to swap the views. The button bar hides by itself; tap the picture to bring it back. The other options (hand, settings, invitation, front/back camera) are under “⋯”.'],
        ...(PipWindow.supported()
          ? [[b('Picture-in-picture'), ' (button or P) also opens by itself when you switch to another tab — the call stays on top, with microphone, camera and hang-up buttons.'] as Block[]]
          : []),
        ['The dot next to a name shows the connection quality (green — good, yellow — fair, red — poor).'],
        ['The chat also sends ', b('files'), ' (up to 2 GB) — directly between participants; drop a file into the chat or use the paperclip.'],
        [b('Recording'), ' saves the call on your computer (a .webm file); the others get a note in the chat.'],
      ),
    ),
    section(
      'Room host 👑',
      list(
        ['The host is whoever created the room; when they leave, the role passes to the next person (or the host hands it over).'],
        ['The host has a ', b('⋮'), ' menu on the others’ tiles: mute microphone, make host, remove from the room.'],
        ['A removed person cannot come back for 10 minutes (this also applies to others from the same internet address).'],
        ['Settings → Room → ', b('Lock the room'), ' — nobody new can join; ', b('Mute everyone'), '. A muted participant can turn their microphone on again.'],
      ),
    ),
    section(
      'Video and audio quality',
      list(
        ['Settings → Quality → ', b('Quality profile'), ': “Call” (default) or “Game” — studio audio, 1080p camera, 4 Mb/s upload limit.'],
        [b('Studio audio'), ' has no echo cancellation or noise suppression — best with headphones. Playing on speakers? Tick “Echo cancellation”: it stays stereo with no other filters, and the others won’t hear themselves (they may still hear your game from the speakers).'],
        ['The ', b('GPU'), ' / ', b('CPU'), ' badge on the bar: whether the graphics card encodes your video (better while gaming) or the processor.'],
        [b('P2P'), ' — video goes directly between participants; ', b('SFU'), ' — via the server (with 3–4 people or a slow connection). It switches by itself; you can choose by hand in Settings → Connection.'],
      ),
    ),
    section(
      'Privacy and encryption',
      list(
        ['Calls are ', b('end-to-end encrypted'), ' (the ', b('E2EE'), ' badge on the bar): in P2P mode WebRTC does it, in SFU mode every video and audio frame is also encrypted with keys only the participants know — the server forwards data it cannot read.'],
        ['You exchange the keys directly; when someone leaves they change, so that person cannot follow the rest of the call.'],
        [b('Safety code'), ': Settings → Connection, “Code” column. Compare it by voice — if you both see the same code, nobody (not even the server) is listening in.'],
        ['Chat and files go directly between participants, encrypted as well.'],
      ),
    ),
    ...(hotkeys
      ? [
          section(
            'Gaming: overlay and shortcuts',
            p('The overlay shows small cameras of your teammates in a corner of the screen, over the game. It never takes the mouse or keyboard.'),
            list(
              ['Turn it on with the screen button on the call bar, a shortcut, or Settings → “Overlay & shortcuts” (also monitor, corner, size, opacity).'],
              ['The game must run in ', b('“windowed fullscreen” / borderless'), ' mode — nothing can show over exclusive fullscreen.'],
            ),
            p('Shortcuts that also work in a game (during a call only; change them in Settings → Overlay & shortcuts):'),
            keys([
              [formatAccelerator(hotkeys.overlay), 'show/hide the overlay'],
              [formatAccelerator(hotkeys.mute), 'mute/unmute the microphone (with a sound)'],
              [formatAccelerator(hotkeys.window), 'minimize/restore the call window'],
            ]),
          ),
        ]
      : []),
    section(
      'Server owner key',
      p('Only for the person who runs a Tutaj server (e.g. set one up themselves). Other participants do not need it — calls work without it.'),
      list(
        [b('Where to get it'), ': the server install script prints it at the end of the installation. It is also stored on the server in ', code('deploy/.env'), ' (the ', code('OWNER_KEY'), ' variable), e.g. ', code('grep OWNER_KEY ~/tutaj/deploy/.env'), '. On o.tutaj.eu.org only that server’s owner has it.'],
        [b('Where to enter it'), ': in the lobby, before joining — “Devices, quality and advanced settings” → “Server owner key”. It is remembered in this browser or app. After joining you will see “Owner key recognised”; a wrong key breaks nothing — it simply changes nothing.'],
        [b('What it gives'), ': lifts the limits the server uses against abuse — open rooms per address (5 by default) and joins per minute (30) — and extends access to the TURN relay from 4 to 24 hours, so long calls on difficult networks do not drop.'],
        [b('When it helps'), ': when you see “You already have the maximum number of rooms open” or “Too many attempts” (e.g. several people on one home network, testing), or before a call longer than 4 hours.'],
        [b('What it does not give'), ': it does not make you the room host, does not bypass a room password, a locked room, the 4-person limit or being removed, and gives no access to other people’s calls (they are end-to-end encrypted). Nor does it lift the limit of simultaneous connections per address (20) — ', code('TRUSTED_IPS'), ' on the server does that.'],
        [b('Careful'), ': do not enter it on someone else’s computer. If it leaks, change ', code('OWNER_KEY'), ' in ', code('deploy/.env'), ' and run ', code('sudo docker compose up -d'), ' in the ', code('deploy'), ' directory.'],
      ),
    ),
    section(
      'When something does not work',
      list(
        [b('No camera picture / “device in use”'), ' — close other programs that use it (Teams, Discord, OBS).'],
        [b('No access to the camera or microphone'), ' — Windows: Settings → Privacy & security → Camera / Microphone (allow apps).'],
        [b('Others hear an echo'), ' — put on headphones, tick “Echo cancellation” or choose “Call” audio in Settings → Quality.'],
        [b('Someone cannot connect'), ' — check the quality dot and the table in Settings → Connection; on company networks the connection goes through a TURN server and may take longer.'],
        ...(desktop
          ? [[b('App'), ': the ', kbd('Alt'), ' key shows the menu — change server, local network mode (no internet), check for updates.'] as Block[]]
          : []),
      ),
    ),
  ];
}

let open = false;

/** Opens the help dialog (on top of the settings dialog, if that is open). */
export async function showHelp(): Promise<void> {
  if (open) return;
  open = true;
  const bridge = window.tutaj;
  const overlay = await bridge?.overlay?.get().catch(() => null);
  const context: Context = { hotkeys: overlay?.hotkeys ?? null, desktop: !!bridge };
  const dialog = $<HTMLDialogElement>('help');
  $('help-body').replaceChildren(...(lang === 'pl' ? polish(context) : english(context)));
  dialog.addEventListener('close', () => (open = false), { once: true });
  dialog.showModal();
  $('help-body').scrollTop = 0;
}
