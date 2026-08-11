// Secure bridge between the UI (renderer) and the Node backend (main).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  ask: (agentId, question) => ipcRenderer.invoke('buddy:ask', { agentId, question }),
  hasKey: () => ipcRenderer.invoke('key:has'),
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  stopSpeaking: () => ipcRenderer.send('buddy:stopSpeaking'),
  onStatus: (cb) => ipcRenderer.on('buddy:status', (_e, s) => cb(s)),
  onDelta: (cb) => ipcRenderer.on('buddy:delta', (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on('buddy:done', (_e, t) => cb(t)),
  // Live updates
  contentVersion: () => ipcRenderer.invoke('app:contentVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
});
