import { $, h } from './dom';
import { formatAccelerator } from './hotkeys';

type Block = HTMLElement | string;

const section = (title: string, ...body: Block[]) => h('section', {}, h('h3', { text: title }), ...body);
const p = (...parts: Block[]) => h('p', {}, ...parts);
const list = (...items: Block[][]) => h('ul', {}, ...items.map((parts) => h('li', {}, ...parts)));
const b = (text: string) => h('strong', { text });
const kbd = (text: string) => h('kbd', { text });

function keys(rows: [string, string][]): HTMLTableElement {
  return h('table', { class: 'keys' }, h('tbody', {}, ...rows.map(([k, what]) => h('tr', {}, h('td', {}, kbd(k)), h('td', { text: what })))));
}

/** Short user guide. Desktop-only parts (overlay, global shortcuts) appear in the desktop app only. */
async function content(): Promise<HTMLElement[]> {
  const bridge = window.tutaj;
  const overlay = await bridge?.overlay?.get().catch(() => null);
  const desktop = !!bridge;

  const parts: HTMLElement[] = [
    section(
      'Rozpoczęcie rozmowy',
      list(
        ['Wpisz ', b('imię'), ' i ', b('nazwę pokoju'), ', kliknij ', b('Dołącz'), '. Imię i ostatni pokój są zapamiętywane.'],
        ['W pokoju ', b('Kopiuj zaproszenie'), ' daje link do wysłania innym — kto go otworzy, trafi do tego pokoju.'],
        ['W pokoju mogą być ', b('maks. 4 osoby'), '. Hasło pokoju ustala pierwsza osoba (lobby → „Urządzenia, jakość i ustawienia zaawansowane”).'],
        ['Przed dołączeniem możesz wyłączyć mikrofon lub kamerę przyciskami pod podglądem.'],
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
        ['F1', 'ta pomoc'],
      ]),
      list(
        ['Kliknięcie kafelka powiększa osobę, dwuklik — pełny ekran.'],
        ['Kropka przy imieniu to jakość połączenia (zielona — dobra, żółta — średnia, czerwona — słaba).'],
        ['Czat przesyła też ', b('pliki'), ' (do 2 GB) — bezpośrednio między uczestnikami; przeciągnij plik do czatu lub użyj spinacza.'],
        [b('Nagrywanie'), ' zapisuje rozmowę na Twoim komputerze (plik .webm); pozostali dostają informację w czacie.'],
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
  ];

  parts.push(
    section(
      'Prywatność i szyfrowanie',
      list(
        ['Rozmowy są ', b('szyfrowane end-to-end'), ' (znacznik ', b('E2EE'), ' na pasku): w trybie P2P robi to WebRTC, w trybie SFU każda klatka obrazu i dźwięku jest dodatkowo szyfrowana kluczami, które znają tylko uczestnicy — serwer przekazuje dane, których nie może odczytać.'],
        ['Klucze wymieniacie bezpośrednio między sobą; po wyjściu kogoś z pokoju zmieniają się, więc ta osoba nie zobaczy dalszej części rozmowy.'],
        [b('Kod bezpieczeństwa'), ': Ustawienia → tabela połączeń, kolumna „Kod”. Porównajcie go głosem — jeśli u obu jest taki sam, nikt (także serwer) nie podsłuchuje.'],
        ['Czat i pliki płyną bezpośrednio między uczestnikami, też szyfrowane.'],
      ),
    ),
  );

  if (overlay) {
    const hk = overlay.hotkeys;
    parts.push(
      section(
        'Gra: nakładka i skróty',
        p('Nakładka pokazuje małe kamery współgraczy w rogu ekranu, nad grą. Nie przechwytuje myszy ani klawiatury.'),
        list(
          ['Włączysz ją przyciskiem z ikoną ekranu na pasku rozmowy, skrótem albo w Ustawieniach → „Nakładka na grę” (tam też monitor, róg, rozmiar, krycie).'],
          ['Gra musi działać w trybie ', b('„pełny ekran w oknie” / bez ramek'), ' — nad wyłącznym pełnym ekranem żadne okno się nie pokaże.'],
        ),
        p('Skróty działające także w grze (tylko w trakcie rozmowy; zmienisz je w Ustawieniach):'),
        keys([
          [formatAccelerator(hk.overlay), 'pokaż/ukryj nakładkę'],
          [formatAccelerator(hk.mute), 'wycisz/włącz mikrofon (z sygnałem dźwiękowym)'],
          [formatAccelerator(hk.window), 'zminimalizuj/przywróć okno rozmowy'],
        ]),
      ),
    );
  }

  parts.push(
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
  );
  return parts;
}

let open = false;

/** Opens the help dialog (on top of the settings dialog, if that is open). */
export async function showHelp(): Promise<void> {
  if (open) return;
  open = true;
  const dialog = $<HTMLDialogElement>('help');
  $('help-body').replaceChildren(...(await content()));
  dialog.addEventListener('close', () => (open = false), { once: true });
  dialog.showModal();
  $('help-body').scrollTop = 0;
}
