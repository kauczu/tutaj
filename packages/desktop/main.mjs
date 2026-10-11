import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
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
const DEFAULT_SERVER = 'https://o.tutaj.eu.org';
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
const OFFLINE_PAGE = join(here, 'offline.html');
/** The app's own pages: the Tutaj origin, or the bundled offline page. */
const isAppPage = (url) => originOf(url) === appOrigin || url.startsWith('file:');

function showOffline(reason) {
  void mainWindow.loadFile(OFFLINE_PAGE, { query: { server: settings.serverUrl, reason: reason ?? '' } });
}

/** Restart into the other mode (remembered for next launches). */
function switchMode(mode) {
  saveSettings({ mode: mode === 'lan' ? 'lan' : 'remote' });
  app.relaunch();
  app.exit(0);
}

function registerIpc() {
  // Only the app's own pages may use the bridge.
  const guard = (handler) => (event, ...args) => (isAppPage(event.senderFrame?.url ?? '') ? handler(...args) : null);
  ipcMain.handle('tutaj:info', guard(() => ({
    mode: settings.mode,
    serverUrl: settings.serverUrl,
    lan: settings.mode === 'lan' && LAN && server ? { lanUrls: server.lanUrls, httpPort: server.httpPort } : null,
  })));
  ipcMain.handle('tutaj:switch-mode', guard((mode) => switchMode(mode)));
  ipcMain.handle('tutaj:retry', guard(() => mainWindow.loadURL(appUrl)));
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
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });

  // Links (chat, invites, other sites) open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (originOf(url) === appOrigin) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // Server unreachable (offline, DNS, server down): show our own page instead of a blank window.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED */ && originOf(url) === appOrigin) showOffline(description);
  });

  await mainWindow.loadURL(appUrl).catch(() => {}); // failures are handled by did-fail-load
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (settings.mode === 'lan') {
    await startEmbeddedServer();
    appUrl = `http://localhost:${server.httpPort}`;
  } else {
    appUrl = settings.serverUrl;
  }
  appOrigin = originOf(appUrl);
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', async () => {
  await server?.close();
  app.quit();
});
