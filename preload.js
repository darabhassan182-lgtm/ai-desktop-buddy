// Secure bridge — exposes window.nexus to the UI (renderer.js / game.js).
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['listening', 'transcript', 'manager', 'route', 'agent', 'delta', 'answer', 'error'];

contextBridge.exposeInMainWorld('nexus', {
  ask: (text) => ipcRenderer.invoke('orch:ask', text),
  on: (evt, cb) => { if (EVENTS.includes(evt)) ipcRenderer.on('orch:' + evt, (_e, payload) => cb(payload)); },
  stopSpeaking: () => ipcRenderer.send('buddy:stopSpeaking'),
  hasKey: () => ipcRenderer.invoke('key:has'),
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  contentVersion: () => ipcRenderer.invoke('app:contentVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
});
