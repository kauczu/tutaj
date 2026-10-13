import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, net, session, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Tutaj desktop.
 *
 * "remote" (default): a dedicated window onto the Tutaj server (https://o.tutaj.eu.org) —
 *   the UI comes from the server, so the app is always up to date with it.
 * "lan": the app runs its own server (signaling + SFU) and hosts calls on the local network,
 *   without any internet server.
 */

const here = dirname(fileURLToPath(import.meta.url));
// The server this build is dedicated to. Someone hosting Tutaj under their own domain changes
// "tutaj.defaultServer" in package.json (or users pick another server in the app).
const DEFAULT_SERVER = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).tutaj?.defaultServer ?? 'https://o.tutaj.eu.org';
const HTTP_PORT = Number(process.env.TUTAJ_PORT ?? 3000);
const HTTPS_PORT = Number(process.env.TUTAJ_HTTPS_PORT ?? 3443);
// TUTAJ_LAN=0 keeps the embedded server (lan mode) private to this machine.
const LAN = process.env.TUTAJ_LAN !== '0';

// In the installed app the web client ships as a resource, and mediasoup's worker binary sits
// outside app.asar (a child process can't be spawned from inside the archive).
const CLIENT_DIR = app.isPackaged ? join(process.resourcesPath, 'client') : undefined;
const WORKER_BIN = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Release',
      process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker')
  : undefined;

// --- Settings ---------------------------------------------------------------------

// Separate profile (settings, certificates, cache) — used by tests.
if (process.env.TUTAJ_USER_DATA) app.setPath('userData', process.env.TUTAJ_USER_DATA);

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function isAllowedServer(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** "wp.pl" → "https://wp.pl"; a full URL → its origin (Tutaj lives at the root). null = not a URL. */
function normalizeServer(input) {
  let value = typeof input === 'string' ? input.trim() : '';
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const VERIFY_TIMEOUT_MS = 8000;

/**
 * Confirms that `url` hosts a Tutaj server before the app trusts it with the bridge, camera and
 * microphone. Checks /api/info (Tutaj ≥ 0.2) and falls back to /api/health (older servers).
 */
async function verifyServer(url) {
  const getJson = async (path) => {
    const res = await net.fetch(new URL(path, `${url}/`).toString(), {
      redirect: 'manual', // a redirect elsewhere means it is not a Tutaj endpoint
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (res.status !== 200) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  };
  try {
    const info = await getJson('api/info');
    if (info?.app === 'tutaj') return { ok: true };
    const health = await getJson('api/health');
    if (health?.ok === true && typeof health.rooms === 'number' && typeof health.clients === 'number') return { ok: true };
    return { ok: false, unreachable: false };
  } catch (err) {
    // A redirect (common on ordinary websites) also lands here: if the address answers at all,
    // it is reachable — just not a Tutaj server.
    const answers = await net
      .fetch(`${url}/`, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS), cache: 'no-store' })
      .then(() => true, () => false);
    return answers ? { ok: false, unreachable: false } : { ok: false, unreachable: true, detail: err?.message ?? String(err) };
  }
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    /* first run */
  }
  const mode = process.env.TUTAJ_MODE ?? saved.mode;
  const serverUrl = process.env.TUTAJ_SERVER_URL ?? saved.serverUrl;
  return {
    mode: mode === 'lan' ? 'lan' : 'remote',
    serverUrl: isAllowedServer(serverUrl) ? serverUrl : DEFAULT_SERVER,
  };
}

function saveSettings(patch) {
  const current = (() => {
    try {
      return JSON.parse(readFileSync(settingsFile(), 'utf8'));
    } catch {
      return {};
    }
  })();
  writeFileSync(settingsFile(), JSON.stringify({ ...current, ...patch }, null, 2));
}

const settings = loadSettings();
let server = null;
let mainWindow = null;
let appUrl = '';
let appOrigin = '';

if (!app.requestSingleInstanceLock()) app.quit();

// --- LAN host mode: embedded server ---------------------------------------------------

/** Starts the embedded server, falling back to random ports if the defaults are taken. */
async function startEmbeddedServer() {
  const { startServer } = await import('@tutaj/server');
  const base = {
    host: LAN ? '0.0.0.0' : '127.0.0.1',
    tls: { selfSigned: true, cacheDir: join(app.getPath('userData'), 'certs') },
    clientDir: CLIENT_DIR,
    // Invite links must point at an address other machines can open, not localhost.
    publicUrl: LAN ? 'lan' : null,
    // SFU on the host for rooms of 3–4 where a mesh can't cope; skipped silently if it can't start.
    sfu:
      process.env.TUTAJ_SFU === '0'
        ? false
        : { listenIp: LAN ? '0.0.0.0' : '127.0.0.1', port: Number(process.env.TUTAJ_SFU_PORT ?? 40000), workerBin: WORKER_BIN },
  };
  try {
    server = await startServer({ ...base, port: HTTP_PORT, httpsPort: LAN ? HTTPS_PORT : undefined });
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    server = await startServer({ ...base, port: 0, httpsPort: LAN ? 0 : undefined });
  }
}

// --- Screen-share picker ------------------------------------------------------------------

/** A small window listing screens and windows to share. */
function pickSource(parent) {
  return new Promise(async (resolve) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    const picker = new BrowserWindow({
      parent,
      modal: true,
      width: 760,
      height: 520,
      title: 'Wybierz ekran lub okno',
      autoHideMenuBar: true,
      backgroundColor: '#02060c',
      webPreferences: { preload: join(here, 'picker-preload.cjs'), sandbox: true, contextIsolation: true },
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      resolve(sources.find((s) => s.id === id) ?? null);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:sources', () =>
      sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })),
    );
    ipcMain.on('picker:choose', (_e, id) => finish(id));
    picker.on('closed', () => finish(null));
    await picker.loadFile(join(here, 'picker.html'));
  });
}

// --- Main window --------------------------------------------------------------------------

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};
const SERVER_PAGE = join(here, 'offline.html');
/** The app's own pages: the verified Tutaj origin, or the bundled server page. */
const isAppPage = (url) => (appOrigin !== '' && originOf(url) === appOrigin) || url.startsWith('file:');
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The bundled page for choosing a server. kind: "unreachable" (offline/server down),
 * "foreign" (the address is not a Tutaj server), "choose" (opened from the menu).
 */
function showServerPage(kind, reason) {
  void mainWindow.loadFile(SERVER_PAGE, {
    query: { kind, server: settings.serverUrl, default: DEFAULT_SERVER, mode: settings.mode, reason: reason ?? '' },
  });
}

/** Opens the server — only after confirming it really is a Tutaj server. */
async function openServer() {
  if (settings.mode === 'remote') {
    const check = await verifyServer(settings.serverUrl);
    if (!check.ok) {
      appOrigin = ''; // nothing is trusted until a Tutaj server is confirmed
      showServerPage(check.unreachable ? 'unreachable' : 'foreign', check.detail);
      return;
    }
  }
  appOrigin = originOf(appUrl);
  await mainWindow.loadURL(appUrl).catch(() => {}); // failures are handled by did-fail-load
}

function restart() {
  app.relaunch();
  app.exit(0);
}

/** Restart into the other mode (remembered for next launches). */
function switchMode(mode) {
  saveSettings({ mode: mode === 'lan' ? 'lan' : 'remote' });
  restart();
}

/**
 * Use another Tutaj server (e.g. a self-hosted one); empty = back to this build's default.
 * The address is saved only if a Tutaj server answers there.
 */
async function setServer(input) {
  const url = normalizeServer(input);
  if (url === null) return { ok: false, error: 'To nie jest prawidłowy adres.' };
  const isDefault = !url || url === originOf(DEFAULT_SERVER);
  if (!isDefault) {
    if (!isAllowedServer(url)) return { ok: false, error: 'Adres musi zaczynać się od https://' };
    const check = await verifyServer(url);
    if (!check.ok) {
      return {
        ok: false,
        error: check.unreachable
          ? `Nie udało się połączyć z ${hostOf(url)}. Sprawdź adres i połączenie z internetem.`
          : `Pod adresem ${hostOf(url)} nie działa serwer Tutaj — nic nie zmieniono.`,
      };
    }
  }
  saveSettings({ serverUrl: isDefault ? undefined : url, mode: 'remote' });
  setTimeout(restart, 100); // let the reply reach the page first
  return { ok: true };
}

/** Application menu (Alt shows it): a way back that works whatever the window shows. */
function buildMenu() {
  const lan = settings.mode === 'lan';
  const onDefault = !lan && originOf(settings.serverUrl) === originOf(DEFAULT_SERVER);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Tutaj',
        submenu: [
          { label: 'Wybierz serwer…', click: () => showServerPage('choose') },
          { label: `Przywróć serwer domyślny (${hostOf(DEFAULT_SERVER)})`, enabled: !onDefault, click: () => void setServer('') },
          lan
            ? { label: `Tryb serwera (${hostOf(settings.serverUrl)})`, click: () => switchMode('remote') }
            : { label: 'Tryb lokalny (sieć LAN)', click: () => switchMode('lan') },
          { type: 'separator' },
          { role: 'quit', label: 'Zamknij' },
        ],
      },
      {
        label: 'Widok',
        submenu: [
          { role: 'reload', label: 'Odśwież' },
          { role: 'togglefullscreen', label: 'Pełny ekran' },
          { type: 'separator' },
          { role: 'zoomIn', label: 'Powiększ' },
          { role: 'zoomOut', label: 'Pomniejsz' },
          { role: 'resetZoom', label: 'Rzeczywisty rozmiar' },
        ],
      },
    ]),
  );
}

function registerIpc() {
  // Only the app's own pages may use the bridge.
  const guard = (handler) => (event, ...args) => (isAppPage(event.senderFrame?.url ?? '') ? handler(...args) : null);
  ipcMain.handle('tutaj:info', guard(() => ({
    mode: settings.mode,
    serverUrl: settings.serverUrl,
    defaultServer: DEFAULT_SERVER,
    lan: settings.mode === 'lan' && LAN && server ? { lanUrls: server.lanUrls, httpPort: server.httpPort } : null,
  })));
  ipcMain.handle('tutaj:switch-mode', guard((mode) => switchMode(mode)));
  ipcMain.handle('tutaj:set-server', guard((url) => setServer(url)));
  ipcMain.handle('tutaj:retry', guard(() => openServer()));
}

async function createWindow() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const trusted = originOf(wc.getURL()) === appOrigin;
    callback(trusted && ['media', 'display-capture', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission));
  });
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const source = await pickSource(mainWindow);
    if (source) callback({ video: source });
    else callback({});
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    title: 'Tutaj',
    backgroundColor: '#02060c',
    autoHideMenuBar: true,
    // The installed .exe carries its own icon; in development use the PNG.
    ...(app.isPackaged ? {} : { icon: join(here, 'build', 'icon.png') }),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      // During a game Tutaj is always in the background: keep timers (stats, speaking detection,
      // bitrate control) running at full rate.
      backgroundThrottling: false,
    },
  });

  // Links (chat, invites, other sites) open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigation and redirects may only stay on the verified Tutaj origin; anything else opens in the browser.
  const keepOnServer = (e, url) => {
    if (appOrigin !== '' && originOf(url) === appOrigin) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', (e, url) => keepOnServer(e, e.url ?? url));
  mainWindow.webContents.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    if (e.isMainFrame ?? isMainFrame) keepOnServer(e, e.url ?? url);
  });
  // Server unreachable (offline, DNS, server down): show our own page instead of a blank window.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED */ && originOf(url) === appOrigin) showServerPage('unreachable', description);
  });

  await openServer();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Chromium slows down hidden/occluded windows — exactly the state of a call window behind a game.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.whenReady().then(async () => {
  if (settings.mode === 'lan') {
    await startEmbeddedServer();
    appUrl = `http://localhost:${server.httpPort}`;
  } else {
    appUrl = settings.serverUrl;
  }
  registerIpc();
  buildMenu();
  await createWindow();
});

app.on('window-all-closed', async () => {
  await server?.close();
  app.quit();
});
