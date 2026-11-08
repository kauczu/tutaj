const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id, audio) => ipcRenderer.send('picker:choose', id, audio === true),
  onThumbnails: (cb) => ipcRenderer.on('picker:thumbnails', (_e, list) => cb(list)),
});
