// Secure bridge — exposes window.nexus to the UI (renderer.js / game.js / memory.js).
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['listening', 'transcript', 'manager', 'route', 'agent', 'delta', 'answer', 'error', 'memory', 'notice', 'display'];

contextBridge.exposeInMainWorld('nexus', {
  ask: (text) => ipcRenderer.invoke('orch:ask', text),
  askVision: (text, image) => ipcRenderer.invoke('orch:askVision', { text, image }),
  on: (evt, cb) => { if (EVENTS.includes(evt)) ipcRenderer.on('orch:' + evt, (_e, payload) => cb(payload)); },
  stopSpeaking: () => ipcRenderer.send('buddy:stopSpeaking'),
  hasKey: () => ipcRenderer.invoke('key:has'),
  saveKey: (key) => ipcRenderer.invoke('key:save', key),
  contentVersion: () => ipcRenderer.invoke('app:contentVersion'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  // Long-term memory (secret VALUES never cross this bridge)
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    addNote: (kind, text) => ipcRenderer.invoke('memory:addNote', kind, text),
    deleteNote: (id) => ipcRenderer.invoke('memory:deleteNote', id),
    setSecret: (name, value, note) => ipcRenderer.invoke('memory:setSecret', name, value, note),
    deleteSecret: (name) => ipcRenderer.invoke('memory:deleteSecret', name),
    encAvailable: () => ipcRenderer.invoke('memory:encAvailable'),
  },
});
