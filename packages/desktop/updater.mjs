// Desktop app updates from GitHub Releases (electron-updater, NSIS installer).
//
// At start (and from the menu) the app checks the latest release. A newer version is offered in a
// dialog; on "yes" it downloads in the background (progress on the taskbar icon) and then installs
// silently and restarts — right away, or after the call if one is in progress.
import { app, dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import updater from 'electron-updater';

const { autoUpdater } = updater;

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
    if (testFeed) return console.log(`[updater] would install ${downloaded}`);
    // Silent NSIS install into the same place, then start the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  };

  autoUpdater.on('update-available', async (info) => {
    if (!manual && ctx.skipped() === info.version) return;
    const choice = await ask({
      message: `Dostępna jest nowa wersja Tutaj: ${info.version}`,
      detail:
        `Masz wersję ${app.getVersion()}. Aktualizacja pobierze się w tle, ` +
        'a potem aplikacja zainstaluje ją i uruchomi się ponownie.\n\nCo nowego: github.com/kauczu/tutaj/releases',
      buttons: ['Aktualizuj', 'Później', 'Pomiń tę wersję'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 2) ctx.skip(info.version);
    if (choice !== 0) return;
    ctx.skip(null);
    busy = true;
    autoUpdater.downloadUpdate().catch((err) => failed(err));
  });

  autoUpdater.on('update-not-available', () => {
    if (manual) void ask({ message: `Masz najnowszą wersję Tutaj (${app.getVersion()}).`, buttons: ['OK'] });
  });

  autoUpdater.on('download-progress', (p) => win()?.setProgressBar(Math.max(0.01, p.percent / 100)));

  autoUpdater.on('update-downloaded', async (info) => {
    busy = false;
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
  });

  const failed = (err) => {
    busy = false;
    win()?.setProgressBar(-1);
    console.warn('[updater]', err?.message ?? err);
    if (manual) void ask({ type: 'error', message: 'Nie udało się sprawdzić lub pobrać aktualizacji.', detail: String(err?.message ?? err), buttons: ['OK'] });
  };
  autoUpdater.on('error', failed);

  return {
    /** @param {boolean} [fromMenu] user asked: report "up to date" and errors too */
    check(fromMenu = false) {
      if (busy) return;
      if (downloaded) {
        if (fromMenu) install();
        return;
      }
      manual = fromMenu;
      autoUpdater.checkForUpdates().catch((err) => failed(err));
    },
  };
}

function notPackaged(ctx) {
  const w = ctx.window();
  const opts = { type: 'info', title: 'Aktualizacja Tutaj', message: 'Aktualizacje działają w zainstalowanej aplikacji (nie w trybie deweloperskim).', buttons: ['OK'] };
  void (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts));
}
