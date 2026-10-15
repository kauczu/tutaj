import { lang } from '../i18n';
import { $, h } from './dom';
import { formatAccelerator, type Hotkeys } from './hotkeys';
import { PipWindow } from './pip';

type Block = HTMLElement | string;

const section = (title: string, ...body: Block[]) => h('section', {}, h('h3', { text: title }), ...body);
const p = (...parts: Block[]) => h('p', {}, ...parts);
const list = (...items: Block[][]) => h('ul', {}, ...items.map((parts) => h('li', {}, ...parts)));
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
      'Rozpoczęcie rozmowy',
      list(
        ['Wpisz ', b('imię'), ' i ', b('nazwę pokoju'), ', kliknij ', b('Dołącz'), '. Imię i ostatni pokój są zapamiętywane.'],
        ['W pokoju ', b('Kopiuj zaproszenie'), ' daje link do wysłania innym — kto go otworzy, trafi do tego pokoju.'],
        ['W pokoju mogą być ', b('maks. 4 osoby'), '. Hasło pokoju ustala pierwsza osoba (lobby → „Urządzenia, jakość i ustawienia zaawansowane”).'],
        ['Kamera i mikrofon włączają się dopiero po dołączeniu i wyłączają po rozłączeniu. Przyciski pod podglądem wybierają, z czym dołączysz (wybór jest zapamiętywany); „Włącz podgląd” pozwala wcześniej sprawdzić obraz i dźwięk — wyłącza się sam, gdy przejdziesz do innej karty. Język interfejsu zmienisz w ustawieniach zaawansowanych.'],
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
        ['Ustawienia → ', b('Zablokuj pokój'), ' — nikt nowy nie dołączy; ', b('Wycisz wszystkich'), '. Wyciszony uczestnik może sam włączyć mikrofon z powrotem.'],
      ),
    ),
    section(
      'Jakość obrazu i dźwięku',
      list(
        ['Ustawienia → ', b('Profil jakości'), ': „Rozmowa” (domyślny) albo „Gra” — dźwięk studyjny, kamera 1080p, limit wysyłania 4 Mb/s.'],
        [b('Dźwięk studyjny'), ' wyłącza redukcję echa — używaj słuchawek, inaczej rozmówcy usłyszą siebie.'],
        ['Znacznik ', b('GPU'), ' / ', b('CPU'), ' na pasku: czy obraz koduje karta graficzna (lepiej podczas gry), czy procesor.'],
        [b('P2P'), ' — obraz płynie bezpośrednio między uczestnikami; ', b('SFU'), ' — przez serwer (przy 3–4 osobach lub słabym łączu). Przełącza się samo; można wybrać ręcznie w Ustawieniach.'],
      ),
    ),
    section(
      'Prywatność i szyfrowanie',
      list(
        ['Rozmowy są ', b('szyfrowane end-to-end'), ' (znacznik ', b('E2EE'), ' na pasku): w trybie P2P robi to WebRTC, w trybie SFU każda klatka obrazu i dźwięku jest dodatkowo szyfrowana kluczami, które znają tylko uczestnicy — serwer przekazuje dane, których nie może odczytać.'],
        ['Klucze wymieniacie bezpośrednio między sobą; po wyjściu kogoś z pokoju zmieniają się, więc ta osoba nie zobaczy dalszej części rozmowy.'],
        [b('Kod bezpieczeństwa'), ': Ustawienia → tabela połączeń, kolumna „Kod”. Porównajcie go głosem — jeśli u obu jest taki sam, nikt (także serwer) nie podsłuchuje.'],
        ['Czat i pliki płyną bezpośrednio między uczestnikami, też szyfrowane.'],
      ),
    ),
    ...(hotkeys
      ? [
          section(
            'Gra: nakładka i skróty',
            p('Nakładka pokazuje małe kamery współgraczy w rogu ekranu, nad grą. Nie przechwytuje myszy ani klawiatury.'),
            list(
              ['Włączysz ją przyciskiem z ikoną ekranu na pasku rozmowy, skrótem albo w Ustawieniach → „Nakładka na grę” (tam też monitor, róg, rozmiar, krycie).'],
              ['Gra musi działać w trybie ', b('„pełny ekran w oknie” / bez ramek'), ' — nad wyłącznym pełnym ekranem żadne okno się nie pokaże.'],
            ),
            p('Skróty działające także w grze (tylko w trakcie rozmowy; zmienisz je w Ustawieniach):'),
            keys([
              [formatAccelerator(hotkeys.overlay), 'pokaż/ukryj nakładkę'],
              [formatAccelerator(hotkeys.mute), 'wycisz/włącz mikrofon (z sygnałem dźwiękowym)'],
              [formatAccelerator(hotkeys.window), 'zminimalizuj/przywróć okno rozmowy'],
            ]),
          ),
        ]
      : []),
    section(
      'Gdy coś nie działa',
      list(
        [b('Brak obrazu z kamery / „urządzenie zajęte”'), ' — zamknij inne programy, które jej używają (Teams, Discord, OBS).'],
        [b('Brak dostępu do kamery lub mikrofonu'), ' — Windows: Ustawienia → Prywatność i zabezpieczenia → Kamera / Mikrofon (zezwól aplikacjom).'],
        [b('Rozmówcy słyszą echo'), ' — załóż słuchawki albo wybierz dźwięk „Rozmowa” w Ustawieniach.'],
        [b('Ktoś się nie łączy'), ' — sprawdź kropkę jakości i tabelę połączeń w Ustawieniach; w sieciach firmowych połączenie idzie przez serwer TURN i może trwać dłużej.'],
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
      'Starting a call',
      list(
        ['Enter your ', b('name'), ' and a ', b('room name'), ', click ', b('Join'), '. Your name and the last room are remembered.'],
        ['In the room, ', b('Copy invitation'), ' gives you a link to send — whoever opens it lands in the same room.'],
        ['A room holds ', b('up to 4 people'), '. The first person sets the room password (lobby → “Devices, quality and advanced settings”).'],
        ['The camera and microphone turn on only when you join and off when you hang up. The buttons under the preview choose what you join with (the choice is remembered); “Start preview” lets you check picture and sound first — it stops by itself when you switch to another tab. The interface language is in the advanced settings.'],
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
        ['Settings → ', b('Lock the room'), ' — nobody new can join; ', b('Mute everyone'), '. A muted participant can turn their microphone on again.'],
      ),
    ),
    section(
      'Video and audio quality',
      list(
        ['Settings → ', b('Quality profile'), ': “Call” (default) or “Game” — studio audio, 1080p camera, 4 Mb/s upload limit.'],
        [b('Studio audio'), ' turns echo cancellation off — use headphones, or the others will hear themselves.'],
        ['The ', b('GPU'), ' / ', b('CPU'), ' badge on the bar: whether the graphics card encodes your video (better while gaming) or the processor.'],
        [b('P2P'), ' — video goes directly between participants; ', b('SFU'), ' — via the server (with 3–4 people or a slow connection). It switches by itself; you can choose by hand in Settings.'],
      ),
    ),
    section(
      'Privacy and encryption',
      list(
        ['Calls are ', b('end-to-end encrypted'), ' (the ', b('E2EE'), ' badge on the bar): in P2P mode WebRTC does it, in SFU mode every video and audio frame is also encrypted with keys only the participants know — the server forwards data it cannot read.'],
        ['You exchange the keys directly; when someone leaves they change, so that person cannot follow the rest of the call.'],
        [b('Safety code'), ': Settings → connections table, “Code” column. Compare it by voice — if you both see the same code, nobody (not even the server) is listening in.'],
        ['Chat and files go directly between participants, encrypted as well.'],
      ),
    ),
    ...(hotkeys
      ? [
          section(
            'Gaming: overlay and shortcuts',
            p('The overlay shows small cameras of your teammates in a corner of the screen, over the game. It never takes the mouse or keyboard.'),
            list(
              ['Turn it on with the screen button on the call bar, a shortcut, or Settings → “Game overlay” (also monitor, corner, size, opacity).'],
              ['The game must run in ', b('“windowed fullscreen” / borderless'), ' mode — nothing can show over exclusive fullscreen.'],
            ),
            p('Shortcuts that also work in a game (during a call only; change them in Settings):'),
            keys([
              [formatAccelerator(hotkeys.overlay), 'show/hide the overlay'],
              [formatAccelerator(hotkeys.mute), 'mute/unmute the microphone (with a sound)'],
              [formatAccelerator(hotkeys.window), 'minimize/restore the call window'],
            ]),
          ),
        ]
      : []),
    section(
      'When something does not work',
      list(
        [b('No camera picture / “device in use”'), ' — close other programs that use it (Teams, Discord, OBS).'],
        [b('No access to the camera or microphone'), ' — Windows: Settings → Privacy & security → Camera / Microphone (allow apps).'],
        [b('Others hear an echo'), ' — put on headphones or choose “Call” audio in Settings.'],
        [b('Someone cannot connect'), ' — check the quality dot and the connections table in Settings; on company networks the connection goes through a TURN server and may take longer.'],
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
