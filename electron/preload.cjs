const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  getBackendStatus: () => ipcRenderer.invoke('app:getBackendStatus'),
  openExternalCad: (cadExecutablePath, filePath) => ipcRenderer.invoke('app:openExternalCad', { cadExecutablePath, filePath }),
  googleLogin: () => ipcRenderer.invoke('auth:googleLogin'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveGeneratedFile: (arg1, arg2, arg3) => {
    let payload = {};
    if (typeof arg1 === 'object' && arg1 !== null) {
      payload = arg1;
    } else {
      payload = { sourcePath: arg1, base64Data: arg2, defaultName: arg3 };
    }
    return ipcRenderer.invoke('fs:saveGeneratedFile', payload);
  },

  // ── Auto-Update ───────────────────────────────────────────────────────────
  // Renderer → Main
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // Main → Renderer  (listen to push events from the updater)
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, info) => cb(info)),
});
