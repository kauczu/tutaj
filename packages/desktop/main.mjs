import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@tutaj/server';

const here = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.TUTAJ_PORT ?? 3000);
const HTTPS_PORT = Number(process.env.TUTAJ_HTTPS_PORT ?? 3443);
// TUTAJ_LAN=0 keeps the embedded server private to this machine.
const LAN = process.env.TUTAJ_LAN !== '0';

let server = null;
let mainWindow = null;

if (!app.requestSingleInstanceLock()) app.quit();

/** Starts the embedded server, falling back to random ports if the defaults are taken. */
async function startEmbeddedServer() {
  const base = {
    host: LAN ? '0.0.0.0' : '127.0.0.1',
    tls: { selfSigned: true, cacheDir: join(app.getPath('userData'), 'certs') },
    // Invite links must point at an address other machines can open, not localhost.
    publicUrl: LAN ? 'lan' : null,
    // SFU on the host for rooms of 3–4 where a mesh can't cope; skipped silently if it can't start.
    sfu: process.env.TUTAJ_SFU === '0' ? false : { listenIp: LAN ? '0.0.0.0' : '127.0.0.1', port: Number(process.env.TUTAJ_SFU_PORT ?? 40000) },
  };
  try {
    server = await startServer({ ...base, port: HTTP_PORT, httpsPort: LAN ? HTTPS_PORT : undefined });
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    server = await startServer({ ...base, port: 0, httpsPort: LAN ? 0 : undefined });
  }
}

/** Screen-share picker: a small window listing screens and windows. */
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

async function createWindow() {
  const ses = session.defaultSession;
  const appOrigin = `http://localhost:${server.httpPort}`;

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const trusted = wc.getURL().startsWith(appOrigin);
    callback(trusted && ['media', 'display-capture', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission));
  });
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const source = await pickSource(mainWindow);
    if (source) callback({ video: source });
    else callback({});
  });

  ipcMain.handle('tutaj:host-info', () =>
    LAN ? { lanUrls: server.lanUrls, httpPort: server.httpPort } : null,
  );

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    title: 'Tutaj',
    backgroundColor: '#02060c',
    autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });

  // Links (chat, invites) open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appOrigin)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  await mainWindow.loadURL(appOrigin);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  await startEmbeddedServer();
  await createWindow();
});

app.on('window-all-closed', async () => {
  await server?.close();
  app.quit();
});
