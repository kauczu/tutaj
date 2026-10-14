const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the Tutaj pages (the server's web client, or the bundled offline page).
contextBridge.exposeInMainWorld('tutaj', {
  isDesktop: true,
  /** { mode: 'remote' | 'lan', serverUrl, lan: { lanUrls, httpPort } | null } */
  info: () => ipcRenderer.invoke('tutaj:info'),
  /** Restarts the app in the given mode ('remote' or 'lan'). */
  switchMode: (mode) => ipcRenderer.invoke('tutaj:switch-mode', mode),
  /** Switches to another Tutaj server (https://…); empty string = the build's default. Restarts the app. */
  setServer: (url) => ipcRenderer.invoke('tutaj:set-server', url),
  /** The page's interface language ('pl' | 'en'): the app's menus and dialogs follow it. */
  setLanguage: (lang) => ipcRenderer.invoke('tutaj:set-language', lang),
  /** Reloads the server page (offline screen). */
  retry: () => ipcRenderer.invoke('tutaj:retry'),
  /** Game overlay: settings { enabled, corner, size, opacity, display, displays } and the size of its content. */
  overlay: {
    get: () => ipcRenderer.invoke('tutaj:overlay-get'),
    set: (patch) => ipcRenderer.invoke('tutaj:overlay-set', patch),
    resize: (width, height) => ipcRenderer.invoke('tutaj:overlay-resize', width, height),
  },
  /** Changes a global shortcut ('overlay' | 'mute') to an Electron accelerator; null = default. → { ok, error?, hotkeys? } */
  setHotkey: (name, accelerator) => ipcRenderer.invoke('tutaj:hotkey-set', name, accelerator),
  /** Suspends the global shortcuts while a new one is being recorded. */
  pauseHotkeys: (paused) => ipcRenderer.invoke('tutaj:hotkeys-pause', paused),
  /** In a call: global shortcuts (default Ctrl+Shift+O overlay, Ctrl+Shift+M mute) are active. */
  setInCall: (inCall) => ipcRenderer.invoke('tutaj:call-state', inCall),
  /** Global shortcut pressed: 'overlay' | 'mute'. Returns an unsubscribe function. */
  onHotkey: (cb) => {
    const listener = (_e, name) => cb(name);
    ipcRenderer.on('tutaj:hotkey', listener);
    return () => ipcRenderer.removeListener('tutaj:hotkey', listener);
  },
});
