const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
  onThumbnails: (cb) => ipcRenderer.on('picker:thumbnails', (_e, list) => cb(list)),
});
