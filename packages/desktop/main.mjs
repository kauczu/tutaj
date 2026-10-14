import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, net, screen, session, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setUiLang, t, uiLang } from './i18n.mjs';
import { initUpdater } from './updater.mjs';

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
    overlay: sanitizeOverlay(saved.overlay),
    /** Last size and position of the call window (restored at start). */
    window: sanitizeWindow(saved.window),
    /** Version the user chose not to install ("Pomiń tę wersję"). */
    skipVersion: typeof saved.skipVersion === 'string' ? saved.skipVersion : null,
    /** Interface language reported by the page ('pl' | 'en'); null = the system's. */
    language: saved.language === 'pl' || saved.language === 'en' ? saved.language : null,
    hotkeys: sanitizeHotkeys(saved.hotkeys),
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

let server = null;
let mainWindow = null;
/** Desktop app updates (see updater.mjs). */
let updates = null;
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
      title: t('picker.title'),
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
    await picker.loadFile(join(here, 'picker.html'), { query: { lang: uiLang() } });
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
    query: { kind, server: settings.serverUrl, default: DEFAULT_SERVER, mode: settings.mode, reason: reason ?? '', lang: uiLang() },
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
  if (url === null) return { ok: false, error: t('server.badAddress') };
  const isDefault = !url || url === originOf(DEFAULT_SERVER);
  if (!isDefault) {
    if (!isAllowedServer(url)) return { ok: false, error: t('server.needHttps') };
    const check = await verifyServer(url);
    if (!check.ok) {
      return {
        ok: false,
        error: check.unreachable
          ? t('server.unreachable', { host: hostOf(url) })
          : t('server.foreign', { host: hostOf(url) }),
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
          { label: t('menu.chooseServer'), click: () => showServerPage('choose') },
          { label: t('menu.restoreServer', { host: hostOf(DEFAULT_SERVER) }), enabled: !onDefault, click: () => void setServer('') },
          lan
            ? { label: t('menu.serverMode', { host: hostOf(settings.serverUrl) }), click: () => switchMode('remote') }
            : { label: t('menu.lanMode'), click: () => switchMode('lan') },
          { type: 'separator' },
          { label: t('menu.checkUpdates'), click: () => updates?.check(true) },
          { label: t('menu.version', { version: app.getVersion() }), enabled: false },
          { type: 'separator' },
          { role: 'quit', label: t('menu.quit') },
        ],
      },
      {
        label: t('menu.view'),
        submenu: [
          { role: 'reload', label: t('menu.reload') },
          { role: 'togglefullscreen', label: t('menu.fullscreen') },
          { type: 'separator' },
          { role: 'zoomIn', label: t('menu.zoomIn') },
          { role: 'zoomOut', label: t('menu.zoomOut') },
          { role: 'resetZoom', label: t('menu.resetZoom') },
        ],
      },
    ]),
  );
}

function registerIpc() {
  // Only the app's own pages may use the bridge.
  const guard = (handler) => (event, ...args) => (isAppPage(event.senderFrame?.url ?? '') ? handler(...args) : null);
  ipcMain.handle('tutaj:info', guard(() => ({
    /** Version of this desktop app (the web client shows the server's own version). */
    appVersion: app.getVersion(),
    mode: settings.mode,
    serverUrl: settings.serverUrl,
    defaultServer: DEFAULT_SERVER,
    lan: settings.mode === 'lan' && LAN && server ? { lanUrls: server.lanUrls, httpPort: server.httpPort } : null,
  })));
  ipcMain.handle('tutaj:switch-mode', guard((mode) => switchMode(mode)));
  ipcMain.handle('tutaj:set-server', guard((url) => setServer(url)));
  ipcMain.handle('tutaj:retry', guard(() => openServer()));
  // The page's language: menus, dialogs and the app's own pages follow it.
  ipcMain.handle('tutaj:set-language', guard((lang) => {
    if (lang !== 'pl' && lang !== 'en') return;
    if (settings.language !== lang) {
      settings.language = lang;
      saveSettings({ language: lang });
    }
    setUiLang(lang);
    buildMenu();
  }));
  ipcMain.handle('tutaj:overlay-get', guard(() => ({ ...settings.overlay, displays: listDisplays(), hotkeys: settings.hotkeys })));
  ipcMain.handle('tutaj:hotkey-set', guard((name, accelerator) => setHotkey(name, accelerator)));
  // While the user records a new shortcut, the current ones must not fire.
  ipcMain.handle('tutaj:hotkeys-pause', guard((paused) => (paused === true ? unregisterHotkeys() : inCall && registerHotkeys())));
  ipcMain.handle('tutaj:overlay-set', guard((patch) => {
    const wasEnabled = settings.overlay.enabled;
    settings.overlay = sanitizeOverlay({ ...settings.overlay, ...(patch && typeof patch === 'object' ? patch : {}) });
    // Only a change of `enabled` comes from the user toggling the overlay (not its automatic opening on join).
    if (settings.overlay.minimizeCall && settings.overlay.enabled !== wasEnabled) setCallWindow(!settings.overlay.enabled);
    saveSettings({ overlay: settings.overlay });
    placeOverlay();
    return settings.overlay;
  }));
  ipcMain.handle('tutaj:overlay-resize', guard((width, height) => {
    overlaySize = { width: clampInt(width, 1, 1600), height: clampInt(height, 1, 2000) };
    placeOverlay();
  }));
  ipcMain.handle('tutaj:call-state', guard((on) => setInCall(on === true)));
}

// --- Window size and position ---------------------------------------------------------

const MIN_SIZE = { width: 420, height: 520 };

function sanitizeWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const width = int(w.width);
  const height = int(w.height);
  if (width === null || height === null) return null;
  return {
    x: int(w.x),
    y: int(w.y),
    width: Math.max(MIN_SIZE.width, width),
    height: Math.max(MIN_SIZE.height, height),
    maximized: w.maximized === true,
  };
}

/**
 * The saved window bounds, if they still land on a connected monitor (monitors change between
 * sessions); otherwise just the saved size, fitted to the primary monitor and centred.
 */
function initialBounds() {
  const w = settings.window;
  if (!w) return { width: 1280, height: 820 };
  const onScreen =
    w.x !== null &&
    w.y !== null &&
    screen.getAllDisplays().some(({ workArea: a }) => {
      // Enough of the title bar visible to grab the window.
      return w.x + w.width - 100 > a.x && w.x + 100 < a.x + a.width && w.y >= a.y - 8 && w.y + 40 < a.y + a.height;
    });
  if (onScreen) return { x: w.x, y: w.y, width: w.width, height: w.height };
  const area = screen.getPrimaryDisplay().workArea;
  return { width: Math.min(w.width, area.width), height: Math.min(w.height, area.height) };
}

/** Remembers size, position and maximized state (normal bounds, also while maximized or minimized). */
function trackWindowBounds(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isFullScreen()) return;
    settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings({ window: settings.window });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, later);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

// --- Game overlay ----------------------------------------------------------------

/** Window name the web client gives its overlay popup (`OVERLAY_WINDOW_NAME`). */
const OVERLAY_NAME = 'tutaj-overlay';
const OVERLAY_MARGIN = 24;

let overlayWindow = null;
let overlaySize = { width: 300, height: 200 };
let inCall = false;

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

function sanitizeOverlay(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    enabled: v.enabled === true,
    corner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(v.corner) ? v.corner : 'top-right',
    size: ['s', 'm', 'l'].includes(v.size) ? v.size : 'm',
    opacity: [1, 0.85, 0.7, 0.5].includes(v.opacity) ? v.opacity : 0.85,
    /** Electron display id; null = primary monitor (where games usually run). */
    display: Number.isSafeInteger(v.display) ? v.display : null,
    /** Showing the overlay (by hand) minimizes the call window; hiding it restores the window. */
    minimizeCall: v.minimizeCall === true,
  };
}

/** Minimizes the call window, or brings it back (shortcut, or together with the overlay). */
function setCallWindow(visible) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!visible) mainWindow.minimize();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

const toggleCallWindow = () => setCallWindow(!mainWindow || mainWindow.isMinimized() || !mainWindow.isVisible());

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label ?? '',
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primary,
  }));
}

/** Puts the overlay in the chosen corner of the chosen monitor (whole screen: games cover the taskbar). */
function placeOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getAllDisplays().find((d) => d.id === settings.overlay.display) ?? screen.getPrimaryDisplay();
  const b = display.bounds;
  const { width, height } = overlaySize;
  const right = settings.overlay.corner.endsWith('right');
  const bottom = settings.overlay.corner.startsWith('bottom');
  overlayWindow.setBounds({
    x: right ? b.x + b.width - width - OVERLAY_MARGIN : b.x + OVERLAY_MARGIN,
    y: bottom ? b.y + b.height - height - OVERLAY_MARGIN : b.y + OVERLAY_MARGIN,
    width,
    height,
  });
}

function overlayWindowOptions() {
  return {
    ...overlaySize,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never takes focus or keyboard input from the game.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: t('overlay.title'),
    webPreferences: { backgroundThrottling: false },
  };
}

function adoptOverlayWindow(child) {
  overlayWindow = child;
  child.on('closed', () => {
    if (overlayWindow === child) overlayWindow = null;
  });
  child.setMenu(null);
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  child.webContents.on('will-navigate', (e) => e.preventDefault());
  // Above fullscreen (borderless) games, and every click goes through to the game.
  child.setAlwaysOnTop(true, 'screen-saver');
  child.setIgnoreMouseEvents(true);
  child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeOverlay();
  child.showInactive();
}

const sendHotkey = (name) => mainWindow?.webContents.send('tutaj:hotkey', name);

/** Global shortcuts exist only during a call, so they don't take these keys from other apps otherwise. */
function setInCall(on) {
  if (on === inCall) return;
  inCall = on;
  if (on) registerHotkeys();
  else {
    unregisterHotkeys();
    overlayWindow?.close();
  }
}

// --- Global shortcuts ---------------------------------------------------------------

/** Global shortcuts, active only during a call: they work while a game has focus. */
function defaultHotkeys() {
  return { overlay: 'CommandOrControl+Shift+O', mute: 'CommandOrControl+Shift+M', window: 'CommandOrControl+Shift+H' };
}

function sanitizeHotkeys(h) {
  const out = defaultHotkeys();
  if (h && typeof h === 'object') {
    for (const name of Object.keys(out)) {
      if (isAccelerator(h[name])) out[name] = h[name];
    }
  }
  return out;
}

/** Shape check only (Electron validates the rest when registering). */
function isAccelerator(a) {
  return typeof a === 'string' && a.length <= 64 && /^[A-Za-z0-9]+(\+[A-Za-z0-9`\-=[\];',./\\]+)*$/.test(a);
}

let registered = [];

function registerHotkeys() {
  unregisterHotkeys();
  for (const [name, accelerator] of Object.entries(settings.hotkeys)) {
    try {
      // The call window shortcut is handled here: it must work while the page is minimized or hidden.
      const action = name === 'window' ? toggleCallWindow : () => sendHotkey(name);
      if (globalShortcut.register(accelerator, action)) registered.push(accelerator);
      else console.warn(`shortcut ${accelerator} is taken`);
    } catch (err) {
      console.warn(`shortcut ${accelerator} is invalid`, err);
    }
  }
}

function unregisterHotkeys() {
  for (const accelerator of registered) globalShortcut.unregister(accelerator);
  registered = [];
}

const sameKey = (a, b) => a.toLowerCase().replace('commandorcontrol', 'ctrl').replace('control', 'ctrl') === b.toLowerCase().replace('commandorcontrol', 'ctrl').replace('control', 'ctrl');

/** Changes one shortcut (null = default). Refused if invalid, a duplicate, or taken by another app. */
function setHotkey(name, accelerator) {
  if (!(name in settings.hotkeys)) return { ok: false, error: t('hotkey.unknown') };
  const next = accelerator == null ? defaultHotkeys()[name] : accelerator;
  if (!isAccelerator(next)) return { ok: false, error: t('hotkey.invalid') };
  const other = Object.entries(settings.hotkeys).find(([n, a]) => n !== name && sameKey(a, next));
  if (other) return { ok: false, error: t('hotkey.duplicate') };
  unregisterHotkeys();
  let ok = false;
  try {
    ok = globalShortcut.register(next, () => {});
    if (ok) globalShortcut.unregister(next);
  } catch {
    ok = false;
  }
  if (ok) {
    settings.hotkeys = { ...settings.hotkeys, [name]: next };
    saveSettings({ hotkeys: settings.hotkeys });
  }
  if (inCall) registerHotkeys();
  return ok ? { ok: true, hotkeys: settings.hotkeys } : { ok: false, error: t('hotkey.taken') };
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
    ...initialBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
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

  if (settings.window?.maximized) mainWindow.maximize();
  mainWindow.show();
  trackWindowBounds(mainWindow);

  // Links (chat, invites, other sites) open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The game overlay: a blank same-origin popup the call page fills with its video streams.
    if (frameName === OVERLAY_NAME && url === 'about:blank' && isAppPage(mainWindow.webContents.getURL())) {
      return { action: 'allow', overrideBrowserWindowOptions: overlayWindowOptions() };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName === OVERLAY_NAME) adoptOverlayWindow(child);
  });
  // Reload/navigation ends the call: drop its shortcuts and overlay.
  mainWindow.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) setInCall(false);
  });
  mainWindow.on('closed', () => {
    setInCall(false);
    overlayWindow?.close();
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

// Read last, after every declaration above: loading calls sanitizers that use module constants
// (a `const` read before its line throws — and the app would not start once settings were saved).
const settings = loadSettings();
setUiLang(settings.language);

app.whenReady().then(async () => {
  if (settings.mode === 'lan') {
    await startEmbeddedServer();
    appUrl = `http://localhost:${server.httpPort}`;
  } else {
    appUrl = settings.serverUrl;
  }
  registerIpc();
  updates = initUpdater({
    window: () => mainWindow,
    inCall: () => inCall,
    skipped: () => settings.skipVersion,
    skip: (version) => {
      settings.skipVersion = version;
      saveSettings({ skipVersion: version ?? undefined });
    },
  });
  buildMenu();
  await createWindow();
  // Not during the start-up rush; the dialog appears over the lobby.
  setTimeout(() => updates.check(), 5000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', async () => {
  await server?.close();
  app.quit();
});
