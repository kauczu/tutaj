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
  /** Reloads the server page (offline screen). */
  retry: () => ipcRenderer.invoke('tutaj:retry'),
  /** { displays: [{ id, label, width, height, primary, current }], selected: id | null } */
  displays: () => ipcRenderer.invoke('tutaj:displays'),
  /** Monitor for the camera window; null = automatic (not the call window's monitor). */
  setStageDisplay: (id) => ipcRenderer.invoke('tutaj:set-stage-display', id),
});
