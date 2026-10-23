'use strict';

// The renderer's only way to touch the disk: open one file, read the secrets
// module and the other .py files next to it, and save those. Paths are
// checked in main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('files', {
  open: () => ipcRenderer.invoke('file:open'),
  readSecrets: (sourcePath, moduleName) => ipcRenderer.invoke('file:read-secrets', sourcePath, moduleName),
  readFolder: (sourcePath) => ipcRenderer.invoke('file:read-folder', sourcePath),
  save: (payload) => ipcRenderer.invoke('file:save', payload)
});
