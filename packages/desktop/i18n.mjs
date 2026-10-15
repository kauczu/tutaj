// Texts of the desktop app itself (menus, dialogs, messages). The web page tells the app its
// language (bridge setLanguage); until then the system language decides.
import { app } from 'electron';

const dict = {
  pl: {
    'menu.chooseServer': 'Wybierz serwer…',
    'menu.restoreServer': 'Przywróć serwer domyślny ({host})',
    'menu.serverMode': 'Tryb serwera ({host})',
    'menu.lanMode': 'Tryb lokalny (sieć LAN)',
    'menu.checkUpdates': 'Sprawdź aktualizacje…',
    'menu.version': 'Wersja {version}',
    'menu.quit': 'Zamknij',
    'menu.view': 'Widok',
    'menu.reload': 'Odśwież',
    'menu.fullscreen': 'Pełny ekran',
    'menu.zoomIn': 'Powiększ',
    'menu.zoomOut': 'Pomniejsz',
    'menu.resetZoom': 'Rzeczywisty rozmiar',
    'picker.title': 'Wybierz ekran lub okno',
    'overlay.title': 'Tutaj — nakładka',
    'server.badAddress': 'To nie jest prawidłowy adres.',
    'server.needHttps': 'Adres musi zaczynać się od https://',
    'server.unreachable': 'Nie udało się połączyć z {host}. Sprawdź adres i połączenie z internetem.',
    'server.foreign': 'Pod adresem {host} nie działa serwer Tutaj — nic nie zmieniono.',
    'hotkey.unknown': 'Nieznany skrót',
    'hotkey.invalid': 'Nieprawidłowy skrót',
    'hotkey.duplicate': 'Ten skrót jest już używany przez inną akcję',
    'hotkey.taken': 'Ten skrót jest zajęty przez inny program albo nieobsługiwany',
    'update.title': 'Aktualizacja Tutaj',
    'update.available': 'Dostępna jest nowa wersja Tutaj: {version}',
    'update.availableDetail':
      'Masz wersję {current}. Aktualizacja pobierze się teraz (postęp w osobnym okienku), a potem aplikacja zainstaluje ją i uruchomi się ponownie.',
    'update.whatsNew': 'Co nowego?',
    'update.now': 'Aktualizuj',
    'update.later': 'Później',
    'update.skip': 'Pomiń tę wersję',
    'update.upToDate': 'Masz najnowszą wersję Tutaj ({version}).',
    'update.ready': 'Wersja {version} jest gotowa do instalacji.',
    'update.readyDetail': 'Instalacja zakończy trwającą rozmowę i uruchomi aplikację ponownie.',
    'update.installNow': 'Zainstaluj teraz',
    'update.onQuit': 'Po zamknięciu aplikacji',
    'update.failed': 'Nie udało się sprawdzić lub pobrać aktualizacji.',
    'update.devOnly': 'Aktualizacje działają w zainstalowanej aplikacji (nie w trybie deweloperskim).',
  },
  en: {
    'menu.chooseServer': 'Choose server…',
    'menu.restoreServer': 'Restore the default server ({host})',
    'menu.serverMode': 'Server mode ({host})',
    'menu.lanMode': 'Local mode (LAN)',
    'menu.checkUpdates': 'Check for updates…',
    'menu.version': 'Version {version}',
    'menu.quit': 'Quit',
    'menu.view': 'View',
    'menu.reload': 'Reload',
    'menu.fullscreen': 'Full screen',
    'menu.zoomIn': 'Zoom in',
    'menu.zoomOut': 'Zoom out',
    'menu.resetZoom': 'Actual size',
    'picker.title': 'Choose a screen or window',
    'overlay.title': 'Tutaj — overlay',
    'server.badAddress': 'This is not a valid address.',
    'server.needHttps': 'The address must start with https://',
    'server.unreachable': 'Could not connect to {host}. Check the address and your internet connection.',
    'server.foreign': 'No Tutaj server runs at {host} — nothing was changed.',
    'hotkey.unknown': 'Unknown shortcut',
    'hotkey.invalid': 'Invalid shortcut',
    'hotkey.duplicate': 'This shortcut is already used by another action',
    'hotkey.taken': 'This shortcut is taken by another program or not supported',
    'update.title': 'Tutaj update',
    'update.available': 'A new version of Tutaj is available: {version}',
    'update.availableDetail':
      'You have version {current}. The update downloads now (progress in a small window), then the app installs it and restarts.',
    'update.whatsNew': 'What’s new?',
    'update.now': 'Update',
    'update.later': 'Later',
    'update.skip': 'Skip this version',
    'update.upToDate': 'You have the latest version of Tutaj ({version}).',
    'update.ready': 'Version {version} is ready to install.',
    'update.readyDetail': 'Installing ends the current call and restarts the app.',
    'update.installNow': 'Install now',
    'update.onQuit': 'When the app closes',
    'update.failed': 'Could not check for or download the update.',
    'update.devOnly': 'Updates work in the installed app (not in development mode).',
  },
};

let chosen = null;

/** 'pl' | 'en': set by the page, otherwise from the system language. */
export function uiLang() {
  if (chosen) return chosen;
  return app.getLocale().toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

export function setUiLang(lang) {
  chosen = lang === 'pl' || lang === 'en' ? lang : null;
}

export function t(key, params = {}) {
  const text = dict[uiLang()][key] ?? dict.pl[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m));
}
