const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the Tutaj pages (the server's web client, or the bundled offline page).
contextBridge.exposeInMainWorld('tutaj', {
  isDesktop: true,
  /** { mode: 'remote' | 'lan', serverUrl, lan: { lanUrls, httpPort } | null } */
  info: () => ipcRenderer.invoke('tutaj:info'),
  /** Restarts the app in the given mode ('remote' or 'lan'). */
  switchMode: (mode) => ipcRenderer.invoke('tutaj:switch-mode', mode),
  /** Reloads the server page (offline screen). */
  retry: () => ipcRenderer.invoke('tutaj:retry'),
});
