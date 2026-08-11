// Electron main process — the "shell": window, Director orchestrator, voice, updates.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const Anthropic = require('@anthropic-ai/sdk');

let mainWindow;
let client = null;

// --- The team: one Director (Nova) + five specialists -----------------------
const SUBAGENTS = {
  research:  { name: 'Scout', searching: true,
    system: 'You are Scout, a research specialist. Use web_search for anything current, factual, or niche, then return a tight, well-sourced answer in plain prose.',
    tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
  docs:      { name: 'Quill',
    system: 'You are Quill, a documents specialist. Draft or edit the requested document/text clearly and concisely. Return the finished text.', tools: [] },
  marketing: { name: 'Spark',
    system: 'You are Spark, a marketing specialist. Produce sharp, on-brand marketing copy or ideas for the task. Be punchy and concrete.', tools: [] },
  inbox:     { name: 'Echo',
    system: 'You are Echo, a communications specialist. Draft the requested Slack message or email reply in an appropriate tone. Return the draft.', tools: [] },
  api:       { name: 'Wire',
    system: 'You are Wire, an API/automation specialist. Produce the concrete steps, code, or request/response payloads for the automation or API task.', tools: [] },
};

const DIRECTOR_SYSTEM = `You are Nova, the Director of an AI studio. You have five specialists you delegate to with the \`delegate\` tool:
- research (Scout): web search, facts, current info
- docs (Quill): writing and editing documents
- marketing (Spark): marketing copy and ideas
- inbox (Echo): drafting Slack messages and email replies
- api (Wire): API calls and automation tasks
For each user request, delegate to the right specialist(s) — you may delegate more than once. For simple conversation you can answer directly without delegating. When results come back, reply with a concise, natural spoken answer (2-5 sentences, no markdown, no bullet points, no URLs — it will be read aloud).`;

const DELEGATE_TOOL = {
  name: 'delegate',
  description: 'Assign a task to one specialist and receive their result.',
  input_schema: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: Object.keys(SUBAGENTS), description: 'Which specialist' },
      task: { type: 'string', description: 'The concrete task for them' },
      reason: { type: 'string', description: 'Why this specialist (one short phrase)' },
    },
    required: ['agent', 'task'],
  },
};

// --- Config / API key -------------------------------------------------------
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; } }
function saveConfig(cfg) { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }
function getApiKey() { return process.env.ANTHROPIC_API_KEY || loadConfig().apiKey || ''; }
function initClient() { const k = getApiKey(); client = k ? new Anthropic({ apiKey: k }) : null; return !!client; }

// --- Live content updates (UI layer) ----------------------------------------
const DEFAULT_REMOTE = 'https://raw.githubusercontent.com/darabhassan182-lgtm/ai-desktop-buddy/main/content';
function remoteBase() { return loadConfig().updateUrl || process.env.NEXUS_UPDATE_URL || DEFAULT_REMOTE; }
function bundledContentDir() { return path.join(__dirname, 'content'); }
function userContentDir() { return path.join(app.getPath('userData'), 'content'); }
function activeContentDir() { return app.isPackaged ? userContentDir() : bundledContentDir(); }
function readManifest(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return { version: '0.0.0', files: [] }; } }
function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
const CONTENT_FILES = ['index.html', 'styles.css', 'renderer.js', 'voice.js', 'game.js', 'manifest.json'];
function syncBundledContent() {
  const src = bundledContentDir(), dst = userContentDir();
  const bundled = readManifest(src), user = readManifest(dst);
  if (!fs.existsSync(path.join(dst, 'index.html')) || cmpVersions(bundled.version, user.version) > 0) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of CONTENT_FILES) { try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch (_) {} }
  }
}
async function fetchText(url) { const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 560,
    resizable: true, maximizable: true, fullscreenable: true,
    title: 'Nexus', backgroundColor: '#0b0e17',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(activeContentDir(), 'index.html'));
}

app.whenReady().then(() => {
  initClient();
  if (app.isPackaged) syncBundledContent();
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- Key + update IPC -------------------------------------------------------
ipcMain.handle('key:has', () => !!client);
ipcMain.handle('key:save', (_e, key) => {
  const t = String(key || '').trim(); if (!t) return false;
  const cfg = loadConfig(); cfg.apiKey = t; saveConfig(cfg);
  client = new Anthropic({ apiKey: t }); return true;
});
ipcMain.handle('app:contentVersion', () => readManifest(activeContentDir()).version);
ipcMain.handle('update:check', async () => {
  const local = readManifest(activeContentDir());
  try {
    const remote = JSON.parse(await fetchText(remoteBase() + '/manifest.json?t=' + Date.now()));
    return { ok: true, current: local.version, latest: remote.version, hasUpdate: cmpVersions(remote.version, local.version) > 0 };
  } catch (e) { return { ok: false, current: local.version, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('update:apply', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Dev mode — edit files directly.' };
  try {
    const base = remoteBase();
    const remote = JSON.parse(await fetchText(base + '/manifest.json?t=' + Date.now()));
    const files = remote.files || [];
    const dl = {};
    for (const f of files) dl[f] = await fetchText(base + '/' + f + '?t=' + Date.now());
    const dst = userContentDir(); fs.mkdirSync(dst, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dst, f), dl[f]);
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(remote, null, 2));
    if (mainWindow) mainWindow.reload();
    return { ok: true, version: remote.version };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Text-to-speech ---------------------------------------------------------
let sayProc = null;
function speak(text, onDone) {
  if (sayProc) { try { sayProc.kill(); } catch (_) {} }
  const clean = (text || '').slice(0, 4000);
  if (!clean) { onDone && onDone(); return; }
  sayProc = execFile('say', ['-r', '188', clean], () => { onDone && onDone(); });
}
ipcMain.on('buddy:stopSpeaking', () => { if (sayProc) { try { sayProc.kill(); } catch (_) {} } });

// --- Run one specialist -----------------------------------------------------
async function runSubAgent(id, task, emit) {
  const a = SUBAGENTS[id];
  emit('agent', { agentId: id, state: a.searching ? 'searching' : 'working' });
  const messages = [{ role: 'user', content: String(task || '') }];
  let text = '';
  for (let i = 0; i < 6; i++) {
    const stream = client.messages.stream({
      model: 'claude-opus-4-8', max_tokens: 2048, system: a.system,
      tools: (a.tools && a.tools.length) ? a.tools : undefined, messages,
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
    text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    break;
  }
  emit('agent', { agentId: id, state: 'delivering' });
  emit('agent', { agentId: id, state: 'done' });
  return text || '(no result)';
}

// --- The Director orchestrator ----------------------------------------------
ipcMain.handle('orch:ask', async (event, text) => {
  const emit = (evt, payload) => { try { event.sender.send('orch:' + evt, payload); } catch (_) {} };
  if (!client) { emit('error', { message: 'Add your Anthropic API key in Settings first.' }); return { ok: false }; }

  emit('manager', { state: 'thinking' });
  const messages = [{ role: 'user', content: String(text || '') }];
  let finalText = '';

  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8', max_tokens: 2048, system: DIRECTOR_SYSTEM, tools: [DELEGATE_TOOL], messages,
      });
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content });
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');

      if (msg.stop_reason === 'tool_use' && toolUses.length) {
        const results = [];
        for (const tu of toolUses) {
          const inp = tu.input || {};
          const agentId = inp.agent;
          if (SUBAGENTS[agentId]) {
            emit('route', { agentId, task: inp.task || '', reason: inp.reason || '' });
            emit('agent', { agentId, state: 'assigned' });
            let out = '';
            try { out = await runSubAgent(agentId, inp.task || String(text), emit); }
            catch (e) { out = '(failed: ' + ((e && e.message) || e) + ')'; emit('agent', { agentId, state: 'idle' }); }
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
          } else {
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown specialist.', is_error: true });
          }
        }
        messages.push({ role: 'user', content: results });
        emit('manager', { state: 'thinking' });
        continue;
      }

      finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      break;
    }

    emit('manager', { state: 'speaking' });
    if (finalText) emit('delta', { text: finalText });
    emit('answer', { text: finalText });
    speak(finalText, () => emit('manager', { state: 'idle' }));
    return { ok: true, text: finalText };
  } catch (err) {
    const m = (err && err.message) || String(err);
    emit('error', { message: m });
    emit('manager', { state: 'idle' });
    return { ok: false, error: m };
  }
});
