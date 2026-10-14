const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the update progress window (update-progress.html).
contextBridge.exposeInMainWorld('updater', {
  onState: (cb) => ipcRenderer.on('updater:state', (_e, state) => cb(state)),
  hide: () => ipcRenderer.send('updater:hide'),
  cancel: () => ipcRenderer.send('updater:cancel'),
});
