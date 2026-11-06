'use strict';

// The only bridge between the locked-down page and the filesystem. Every call
// goes to main.js, which decides which folders may be read or written.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fsBridge', {
  /** Pick a project folder, read it, and load its saved secrets (if any). */
  openProject: () => ipcRenderer.invoke('folder:open-project'),
  /** Pick any folder (e.g. the AI's edited copy) and read it. */
  openOther: (title) => ipcRenderer.invoke('folder:open-other', { title }),
  /** Save the secret list into <project>/compartmentalise-secrets/. */
  saveSecrets: (rootId, secrets) => ipcRenderer.invoke('secrets:save', { rootId, secrets }),
  /** Ask where to write, then write/copy the given files there. */
  writeFolder: (opts) => ipcRenderer.invoke('folder:write', opts)
});
