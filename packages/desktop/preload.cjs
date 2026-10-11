const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tutaj', {
  isDesktop: true,
  hostInfo: () => ipcRenderer.invoke('tutaj:host-info'),
});
