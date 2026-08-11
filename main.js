// Electron main process — runs with full Node access (this is the "backend").
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// In development, load a local .env if present (harmless if missing).
require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');

let mainWindow;
let client = null; // created once we have an API key

// --- The AI team ------------------------------------------------------------
const AGENTS = {
  research: {
    name: 'Scout',
    system: `You are "Scout", a warm, curious research assistant. When a question needs current, \
factual, or niche information, use the web_search tool, then reply conversationally in 2-4 sentences \
that sound natural read aloud. Mention source names inline when useful (e.g. "according to Reuters"). \
Do NOT use markdown, bullet points, headings, or raw URLs — this answer may be spoken out loud.`,
    tools: [{ type: 'web_search_20260209', name: 'web_search' }],
  },
};

// --- Config storage (private, per-machine) ----------------------------------
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch (_) { return {}; }
}
function saveConfig(cfg) { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }
function getApiKey() { return process.env.ANTHROPIC_API_KEY || loadConfig().apiKey || ''; }
function initClient() {
  const key = getApiKey();
  client = key ? new Anthropic({ apiKey: key }) : null;
  return !!client;
}

// --- Live content updates ---------------------------------------------------
// The UI ("content" layer) lives in ./content and can be refreshed at runtime
// from GitHub — no reinstall. main.js / preload.js are the "shell" (need a dmg).
const DEFAULT_REMOTE = 'https://raw.githubusercontent.com/darabhassan182-lgtm/ai-desktop-buddy/main/content';
function remoteBase() {
  return loadConfig().updateUrl || process.env.NEXUS_UPDATE_URL || DEFAULT_REMOTE;
}
function bundledContentDir() { return path.join(__dirname, 'content'); }
function userContentDir() { return path.join(app.getPath('userData'), 'content'); }
function activeContentDir() { return app.isPackaged ? userContentDir() : bundledContentDir(); }

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (_) { return { version: '0.0.0', files: [] }; }
}
function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
// Seed / refresh the writable copy from the bundle when the bundled version is newer.
function syncBundledContent() {
  const src = bundledContentDir(), dst = userContentDir();
  const bundled = readManifest(src), user = readManifest(dst);
  const needSeed = !fs.existsSync(path.join(dst, 'index.html'));
  if (needSeed || cmpVersions(bundled.version, user.version) > 0) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ['index.html', 'styles.css', 'renderer.js', 'voice.js', 'manifest.json']) {
      try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch (_) {}
    }
  }
}
async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 740, minWidth: 380, minHeight: 560,
    resizable: true, maximizable: true, fullscreenable: true,
    title: 'Nexus', backgroundColor: '#0e1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(activeContentDir(), 'index.html'));
}

app.whenReady().then(() => {
  initClient();
  if (app.isPackaged) syncBundledContent();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- Key setup IPC ----------------------------------------------------------
ipcMain.handle('key:has', () => !!client);
ipcMain.handle('key:save', (_e, key) => {
  const trimmed = String(key || '').trim();
  if (!trimmed) return false;
  const cfg = loadConfig();
  cfg.apiKey = trimmed;
  saveConfig(cfg);
  client = new Anthropic({ apiKey: trimmed });
  return true;
});

// --- Update IPC -------------------------------------------------------------
ipcMain.handle('app:contentVersion', () => readManifest(activeContentDir()).version);
ipcMain.handle('update:check', async () => {
  const local = readManifest(activeContentDir());
  try {
    const remote = JSON.parse(await fetchText(remoteBase() + '/manifest.json?t=' + Date.now()));
    return { ok: true, current: local.version, latest: remote.version,
             hasUpdate: cmpVersions(remote.version, local.version) > 0 };
  } catch (e) {
    return { ok: false, current: local.version, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('update:apply', async () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'You are in dev mode — edit files directly. The Update button applies to the installed app.' };
  }
  try {
    const base = remoteBase();
    const remote = JSON.parse(await fetchText(base + '/manifest.json?t=' + Date.now()));
    const files = remote.files || [];
    const downloaded = {};
    for (const f of files) downloaded[f] = await fetchText(base + '/' + f + '?t=' + Date.now());
    const dst = userContentDir();
    fs.mkdirSync(dst, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dst, f), downloaded[f]);
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(remote, null, 2));
    if (mainWindow) mainWindow.reload();
    return { ok: true, version: remote.version };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// --- Text-to-speech via macOS `say` -----------------------------------------
let sayProc = null;
function speak(text, send) {
  if (sayProc) { try { sayProc.kill(); } catch (_) {} }
  const clean = (text || '').slice(0, 4000);
  if (!clean) { send && send('buddy:status', 'idle'); return; }
  send && send('buddy:status', 'speaking');
  sayProc = execFile('say', ['-r', '190', clean], () => { send && send('buddy:status', 'idle'); });
}

// --- Ask a specific agent ---------------------------------------------------
ipcMain.handle('buddy:ask', async (event, payload) => {
  const send = (channel, data) => event.sender.send(channel, data);
  const agentId = (payload && payload.agentId) || 'research';
  const question = (payload && payload.question) || '';
  const agent = AGENTS[agentId] || AGENTS.research;

  if (!client) {
    send('buddy:status', 'idle');
    send('buddy:done', 'I need an API key first — open Settings and paste your key.');
    return { ok: false, error: 'no-key' };
  }

  send('buddy:status', 'thinking');
  const messages = [{ role: 'user', content: String(question) }];
  let finalText = '';

  try {
    for (let i = 0; i < 6; i++) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8', max_tokens: 2048,
        system: agent.system, tools: agent.tools, messages,
      });
      stream.on('text', (delta) => send('buddy:delta', delta));
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' &&
            ev.content_block && ev.content_block.type === 'server_tool_use') {
          send('buddy:status', 'searching');
        }
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: msg.content });
        send('buddy:status', 'searching');
        continue;
      }
      finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      break;
    }
    send('buddy:done', finalText);
    speak(finalText, send);
    return { ok: true, text: finalText };
  } catch (err) {
    const m = (err && err.message) ? err.message : String(err);
    send('buddy:status', 'idle');
    send('buddy:done', 'Sorry — something went wrong: ' + m);
    return { ok: false, error: m };
  }
});

ipcMain.on('buddy:stopSpeaking', () => { if (sayProc) { try { sayProc.kill(); } catch (_) {} } });
