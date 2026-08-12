// Secure bridge — exposes window.nexus to the UI (renderer.js / game.js / memory.js).
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['listening', 'transcript', 'manager', 'route', 'agent', 'delta', 'answer', 'error', 'memory', 'notice', 'display'];

contextBridge.exposeInMainWorld('nexus', {
  ask: (text) => ipcRenderer.invoke('orch:ask', text),
  askVision: (text, image) => ipcRenderer.invoke('orch:askVision', { text, image }),
  transcribe: (b64, mime) => ipcRenderer.invoke('stt:transcribe', b64, mime),
  briefing: () => ipcRenderer.invoke('orch:briefing'),
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
  // Gmail sending (App Password stored locally; never returned in full)
  gmail: {
    get: () => ipcRenderer.invoke('gmail:get'),
    set: (user, pass) => ipcRenderer.invoke('gmail:set', user, pass),
    test: () => ipcRenderer.invoke('gmail:test'),
  },
  // Slack (token stored locally; never returned)
  slack: {
    get: () => ipcRenderer.invoke('slack:get'),
    set: (token) => ipcRenderer.invoke('slack:set', token),
    test: () => ipcRenderer.invoke('slack:test'),
  },
  // Smartlead (API key stored locally; never returned)
  smartlead: {
    get: () => ipcRenderer.invoke('smartlead:get'),
    set: (key) => ipcRenderer.invoke('smartlead:set', key),
    test: () => ipcRenderer.invoke('smartlead:test'),
  },
  // Make.com (token stored locally; never returned)
  make: {
    get: () => ipcRenderer.invoke('make:get'),
    set: (token, zone) => ipcRenderer.invoke('make:set', token, zone),
    test: () => ipcRenderer.invoke('make:test'),
  },
  // Voice (ElevenLabs cinematic TTS): key never returned to the renderer
  voice: {
    get: () => ipcRenderer.invoke('voice:get'),
    setKey: (key) => ipcRenderer.invoke('voice:setKey', key),
    setVoice: (id) => ipcRenderer.invoke('voice:setVoice', id),
    setModel: (m) => ipcRenderer.invoke('voice:setModel', m),
    listVoices: () => ipcRenderer.invoke('voice:listVoices'),
    test: () => ipcRenderer.invoke('voice:test'),
  },
});
