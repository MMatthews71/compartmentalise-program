'use strict';

// The renderer's only way to touch the disk: open one file, read the secrets
// module and the other .py files next to it, and save those. Paths are
// checked in main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('files', {
  open: () => ipcRenderer.invoke('file:open'),
  readSecrets: (sourcePath, moduleName) => ipcRenderer.invoke('file:read-secrets', sourcePath, moduleName),
  readFolder: (sourcePath) => ipcRenderer.invoke('file:read-folder', sourcePath),
  save: (payload) => ipcRenderer.invoke('file:save', payload),
  recent: () => ipcRenderer.invoke('recent:list'),
  openRecent: (filePath) => ipcRenderer.invoke('file:open-recent', filePath),
  openInProject: (filePath) => ipcRenderer.invoke('file:open-in-project', filePath),
  remember: (filePath, moduleName) => ipcRenderer.invoke('recent:remember', filePath, moduleName),
  setUnsaved: (value) => ipcRenderer.invoke('app:set-unsaved', value),
  confirm: (question) => ipcRenderer.invoke('app:confirm', question)
});
