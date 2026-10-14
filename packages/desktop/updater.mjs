// Desktop app updates from GitHub Releases (electron-updater, NSIS installer).
//
// At start (and from the menu) the app checks the latest release. A newer version is offered in a
// dialog; on "yes" it downloads with a progress window (and progress on the taskbar icon), then
// installs silently and restarts — right away, or after the call if one is in progress.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import updater from 'electron-updater';

const { autoUpdater, CancellationToken } = updater;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} ctx
 * @param {() => import('electron').BrowserWindow | null} ctx.window  the call window
 * @param {() => boolean} ctx.inCall
 * @param {() => string | null} ctx.skipped     version the user chose to skip
 * @param {(version: string | null) => void} ctx.skip
 */
export function initUpdater(ctx) {
  // Test hook: a local update feed (generic provider) instead of GitHub, and no real installation.
  const testFeed = process.env.TUTAJ_UPDATE_FEED;
  if (!app.isPackaged && !testFeed) return { check: () => notPackaged(ctx) };
  if (testFeed) {
    // What the installer would carry as app-update.yml (download cache name included).
    const config = join(app.getPath('userData'), 'test-app-update.yml');
    writeFileSync(config, `provider: generic\nurl: ${testFeed}\nupdaterCacheDirName: tutaj-updater-test\n`);
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = config;
  }
  autoUpdater.autoDownload = false;
  // "Later" after downloading: installed when the app quits.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  let manual = false;
  let busy = false;
  let downloaded = null;
  let version = '';
  let cancelToken = null;
  const progress = createProgressWindow(() => ctx.window());

  const win = () => {
    const w = ctx.window();
    return w && !w.isDestroyed() ? w : null;
  };
  const ask = async (options) => {
    const w = win();
    const opts = { type: 'info', title: 'Aktualizacja Tutaj', noLink: true, ...options };
    return (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts)).then((r) => r.response);
  };

  const install = () => {
    progress.show({ state: 'installing', version: downloaded });
    if (testFeed) {
      console.log(`[updater] would install ${downloaded}`);
      return setTimeout(() => progress.close(), 1500);
    }
    // A moment to read "Instalowanie…", then a silent NSIS install into the same place and a restart.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
  };

  autoUpdater.on('update-available', async (info) => {
    if (!manual && ctx.skipped() === info.version) return;
    const choice = await ask({
      message: `Dostępna jest nowa wersja Tutaj: ${info.version}`,
      detail:
        `Masz wersję ${app.getVersion()}. Aktualizacja pobierze się teraz (postęp w osobnym okienku), ` +
        'a potem aplikacja zainstaluje ją i uruchomi się ponownie.\n\nCo nowego: github.com/kauczu/tutaj/releases',
      buttons: ['Aktualizuj', 'Później', 'Pomiń tę wersję'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 2) ctx.skip(info.version);
    if (choice !== 0) return;
    ctx.skip(null);
    busy = true;
    version = info.version;
    cancelToken = new CancellationToken();
    progress.show({ state: 'downloading', version, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    autoUpdater.downloadUpdate(cancelToken).catch((err) => failed(err));
  });

  autoUpdater.on('update-not-available', () => {
    if (manual) void ask({ message: `Masz najnowszą wersję Tutaj (${app.getVersion()}).`, buttons: ['OK'] });
  });

  autoUpdater.on('download-progress', (p) => {
    win()?.setProgressBar(Math.max(0.01, p.percent / 100));
    progress.update({ state: 'downloading', version, percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    busy = false;
    cancelToken = null;
    downloaded = info.version;
    win()?.setProgressBar(-1);
    if (!ctx.inCall()) return install();
    // Installing restarts the app — never cut a call without asking.
    const choice = await ask({
      message: `Wersja ${info.version} jest gotowa do instalacji.`,
      detail: 'Instalacja zakończy trwającą rozmowę i uruchomi aplikację ponownie.',
      buttons: ['Zainstaluj teraz', 'Po zamknięciu aplikacji'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) install();
    else progress.update({ state: 'ready', version: info.version });
  });

  const failed = (err) => {
    const cancelled = cancelToken?.cancelled;
    busy = false;
    cancelToken = null;
    win()?.setProgressBar(-1);
    if (cancelled) return progress.close();
    console.warn('[updater]', err?.message ?? err);
    const message = String(err?.message ?? err).split('\n')[0];
    if (progress.isOpen()) progress.show({ state: 'error', message });
    else if (manual) void ask({ type: 'error', message: 'Nie udało się sprawdzić lub pobrać aktualizacji.', detail: message, buttons: ['OK'] });
  };
  autoUpdater.on('error', failed);

  ipcMain.on('updater:hide', (e) => {
    if (progress.owns(e.sender)) progress.close();
  });
  ipcMain.on('updater:cancel', (e) => {
    if (progress.owns(e.sender)) cancelToken?.cancel();
  });

  return {
    /** @param {boolean} [fromMenu] user asked: report "up to date" and errors too */
    check(fromMenu = false) {
      // Downloading: bring the progress window back.
      if (busy) return fromMenu && progress.reopen();
      if (downloaded) {
        if (fromMenu) install();
        return;
      }
      manual = fromMenu;
      autoUpdater.checkForUpdates().catch((err) => failed(err));
    },
  };
}

/** Small window with the download progress. Closing it only hides it; the download goes on. */
function createProgressWindow(parent) {
  let win = null;
  let last = null;
  const send = () => win && !win.isDestroyed() && last && win.webContents.send('updater:state', last);
  const open = () => {
    if (win && !win.isDestroyed()) return win;
    const p = parent();
    win = new BrowserWindow({
      width: 460,
      height: 200,
      useContentSize: true,
      parent: p && !p.isDestroyed() ? p : undefined,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'Aktualizacja Tutaj',
      backgroundColor: '#02060c',
      autoHideMenuBar: true,
      ...(app.isPackaged ? {} : { icon: join(here, 'build', 'icon.png') }),
      webPreferences: { preload: join(here, 'update-progress-preload.cjs'), sandbox: true, contextIsolation: true },
    });
    win.setMenu(null);
    win.webContents.on('did-finish-load', send);
    win.once('ready-to-show', () => win?.show());
    void win.loadFile(join(here, 'update-progress.html'));
    win.on('closed', () => (win = null));
    return win;
  };
  return {
    show(state) {
      last = state;
      open();
      send();
    },
    update(state) {
      last = state;
      send();
    },
    reopen() {
      if (last) open();
    },
    close() {
      if (win && !win.isDestroyed()) win.close();
    },
    isOpen: () => !!win && !win.isDestroyed(),
    owns: (contents) => !!win && !win.isDestroyed() && contents === win.webContents,
  };
}

function notPackaged(ctx) {
  const w = ctx.window();
  const opts = { type: 'info', title: 'Aktualizacja Tutaj', message: 'Aktualizacje działają w zainstalowanej aplikacji (nie w trybie deweloperskim).', buttons: ['OK'] };
  void (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts));
}
