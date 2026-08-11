// Electron main process — the "shell": window, Director orchestrator, voice, updates, memory.
const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
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

const DIRECTOR_SYSTEM = `You are Agent Sea, the Director of an AI studio. You have five specialists you delegate to with the \`delegate\` tool:
- research (Scout): web search, facts, current info
- docs (Quill): writing and editing documents
- marketing (Spark): marketing copy and ideas
- inbox (Echo): drafting Slack messages and email replies
- api (Wire): API calls and automation tasks
You also have a long-term MEMORY. Use the \`remember\` tool whenever the user shares durable information (their name, company, preferences, a repeatable process/workflow) so you can act faster next time; use \`forget\` to remove an outdated item by id. Never re-ask for something already in MEMORY, and never ask for a stored credential's value.
For each user request, delegate to the right specialist(s) — you may delegate more than once. For simple conversation you can answer directly. When results come back, reply with a concise, natural spoken answer (2-5 sentences, no markdown, no bullet points, no URLs — it will be read aloud).`;

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
const REMEMBER_TOOL = {
  name: 'remember',
  description: 'Save a durable key point, preference, or repeatable process to long-term memory so you can act faster next time.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['note', 'preference', 'process'] },
      content: { type: 'string', description: 'The thing to remember, phrased so it is useful later.' },
    },
    required: ['content'],
  },
};
const FORGET_TOOL = {
  name: 'forget',
  description: 'Delete a memory item by its id (ids are shown in the MEMORY section).',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};
const DIRECTOR_TOOLS = [DELEGATE_TOOL, REMEMBER_TOOL, FORGET_TOOL];

// --- Config / API key -------------------------------------------------------
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; } }
function saveConfig(cfg) { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }
function getApiKey() { return process.env.ANTHROPIC_API_KEY || loadConfig().apiKey || ''; }
function initClient() { const k = getApiKey(); client = k ? new Anthropic({ apiKey: k }) : null; return !!client; }

// --- Long-term MEMORY (notes + encrypted secret vault) ----------------------
function memoryPath() { return path.join(app.getPath('userData'), 'memory.json'); }
function loadMemory() {
  try {
    const m = JSON.parse(fs.readFileSync(memoryPath(), 'utf8'));
    return { notes: Array.isArray(m.notes) ? m.notes : [], secrets: (m.secrets && typeof m.secrets === 'object') ? m.secrets : {} };
  } catch (_) { return { notes: [], secrets: {} }; }
}
function saveMemory(m) { fs.writeFileSync(memoryPath(), JSON.stringify(m, null, 2)); }
let memSeq = 0;
function newId() { memSeq += 1; return 'm' + Date.now().toString(36) + memSeq.toString(36); }
function notifyMemory(reason) { try { if (mainWindow) mainWindow.webContents.send('orch:memory', { reason }); } catch (_) {} }

function addNote(kind, text) {
  const m = loadMemory();
  const k = ['note', 'process', 'preference'].includes(kind) ? kind : 'note';
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return null;
  const dup = m.notes.find((n) => n.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  const note = { id: newId(), kind: k, text: t, createdAt: new Date().toISOString() };
  m.notes.push(note); saveMemory(m); notifyMemory('note-added');
  return note;
}
function deleteNote(id) {
  const m = loadMemory(); const before = m.notes.length;
  m.notes = m.notes.filter((n) => n.id !== id);
  if (m.notes.length !== before) { saveMemory(m); notifyMemory('note-deleted'); return true; }
  return false;
}

// Secrets — encrypted at rest via macOS Keychain (safeStorage). Values NEVER go to the LLM.
function encAvailable() { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } }
function encryptSecret(value) {
  if (encAvailable()) return { enc: safeStorage.encryptString(String(value)).toString('base64'), insecure: false };
  return { enc: Buffer.from(String(value), 'utf8').toString('base64'), insecure: true }; // fallback: obfuscated only
}
function decryptSecret(rec) {
  try {
    const buf = Buffer.from(rec.enc, 'base64');
    return rec.insecure ? buf.toString('utf8') : safeStorage.decryptString(buf);
  } catch (_) { return null; }
}
function sanitizeName(name, existing) {
  let base = String(name || '').trim().replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '-').slice(0, 40).toLowerCase();
  if (!base) base = 'secret';
  return base;
}
function setSecret(name, value, note) {
  const m = loadMemory();
  const nm = sanitizeName(name);
  const { enc, insecure } = encryptSecret(value);
  m.secrets[nm] = { enc, insecure, note: String(note || '').slice(0, 200), createdAt: new Date().toISOString() };
  saveMemory(m); notifyMemory('secret-set');
  return { name: nm, insecure };
}
function deleteSecret(name) {
  const m = loadMemory();
  if (m.secrets[name]) { delete m.secrets[name]; saveMemory(m); notifyMemory('secret-deleted'); return true; }
  return false;
}
function secretNames() { return Object.keys(loadMemory().secrets); }
// getSecretValue exists for future real API execution; values are never sent to the LLM.
function getSecretValue(name) { const m = loadMemory(); return m.secrets[name] ? decryptSecret(m.secrets[name]) : null; }

// Detect API keys / tokens in free text so they can be vaulted and stripped before hitting the LLM.
const SECRET_PATTERNS = [
  { name: 'anthropic',   re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: 'openai',      re: /sk-proj-[A-Za-z0-9_\-]{20,}/g },
  { name: 'openai',      re: /sk-(?!ant-|proj-)[A-Za-z0-9]{20,}/g },
  { name: 'stripe',      re: /[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'github',      re: /gh[posru]_[A-Za-z0-9]{20,}/g },
  { name: 'github',      re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack',       re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws',         re: /AKIA[0-9A-Z]{16}/g },
  { name: 'google',      re: /AIza[0-9A-Za-z_\-]{30,}/g },
];
const LABELED_SECRET = /\b(?:api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|bearer|token|password)\b\s*(?:is|=|:)?\s*["'`]?([A-Za-z0-9_\-.]{16,})["'`]?/gi;

function scanForSecrets(text) {
  let redacted = String(text || '');
  const found = [];
  const taken = new Set(secretNames());
  function uniqueName(base) {
    if (!taken.has(base)) { taken.add(base); return base; }
    let i = 2; while (taken.has(base + i)) i++; taken.add(base + i); return base + i;
  }
  for (const p of SECRET_PATTERNS) {
    redacted = redacted.replace(p.re, (match) => {
      const nm = uniqueName(p.name);
      found.push({ name: nm, value: match });
      return '«secured:' + nm + '»';
    });
  }
  redacted = redacted.replace(LABELED_SECRET, (match, val) => {
    if (match.indexOf('«secured:') !== -1 || !val || val.length < 16) return match;
    const nm = uniqueName('secret');
    found.push({ name: nm, value: val });
    return match.replace(val, '«secured:' + nm + '»');
  });
  return { redacted, found };
}

// Per user's instruction: give stored key VALUES to the AI directly (still encrypted at rest on disk).
const EXPOSE_SECRETS_TO_AI = true;
function buildMemoryBlock() {
  const m = loadMemory();
  const names = Object.keys(m.secrets);
  if (!m.notes.length && !names.length) return '';
  let s = '\n\n=== MEMORY (durable knowledge about this user; use it to act faster and avoid re-asking) ===\n';
  for (const n of m.notes.slice(-60)) s += `- [${n.kind}] (${n.id}) ${n.text}\n`;
  if (names.length) {
    if (EXPOSE_SECRETS_TO_AI) {
      s += 'Stored credentials you may use directly (kept encrypted on-device):\n';
      for (const nm of names) { const v = getSecretValue(nm); s += `- ${nm} = ${v == null ? '(unavailable)' : v}\n`; }
    } else {
      s += `Stored credentials (values hidden; reference by name only): ${names.join(', ')}\n`;
    }
  }
  s += 'Use this to avoid re-asking. Call `remember` when the user shares new durable info; `forget` to remove an item by id.';
  return s;
}

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
const CONTENT_FILES = ['index.html', 'styles.css', 'renderer.js', 'voice.js', 'game.js', 'memory.js', 'memory.css', 'three.bundle.js', 'manifest.json'];
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

// --- Memory IPC (values are never returned to the renderer or the LLM) ------
ipcMain.handle('memory:list', () => {
  const m = loadMemory();
  return {
    notes: m.notes,
    secrets: Object.keys(m.secrets).map((name) => ({
      name, note: m.secrets[name].note || '', insecure: !!m.secrets[name].insecure, createdAt: m.secrets[name].createdAt,
    })),
    encAvailable: encAvailable(),
  };
});
ipcMain.handle('memory:addNote', (_e, kind, text) => addNote(kind, text));
ipcMain.handle('memory:deleteNote', (_e, id) => deleteNote(id));
ipcMain.handle('memory:setSecret', (_e, name, value, note) => setSecret(name, value, note));
ipcMain.handle('memory:deleteSecret', (_e, name) => deleteSecret(name));
ipcMain.handle('memory:encAvailable', () => encAvailable());

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
      model: 'claude-sonnet-5', max_tokens: 2048, system: a.system,
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

  // Capture any keys typed in chat and save them to the vault (encrypted at rest).
  const scan = scanForSecrets(text);
  if (scan.found.length) {
    for (const f of scan.found) setSecret(f.name, f.value, 'captured from chat');
    emit('notice', { text: 'Saved ' + scan.found.length + ' key' + (scan.found.length > 1 ? 's' : '') + ' to memory (' + scan.found.map((f) => f.name).join(', ') + ').' });
    emit('memory', { reason: 'secret-captured' });
  }
  const userText = String(text || '');

  emit('manager', { state: 'thinking' });
  const messages = [{ role: 'user', content: userText }];
  const system = DIRECTOR_SYSTEM + buildMemoryBlock();
  let finalText = '';

  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8', max_tokens: 2048, system, tools: DIRECTOR_TOOLS, messages,
      });
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content });
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');

      if (msg.stop_reason === 'tool_use' && toolUses.length) {
        const results = new Array(toolUses.length);
        const jobs = [];
        toolUses.forEach((tu, idx) => {
          const inp = tu.input || {};
          if (tu.name === 'remember') {
            const note = addNote(inp.kind, inp.content);
            emit('memory', { reason: 'remembered' });
            results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: note ? ('Remembered (' + note.id + ').') : 'Nothing to remember.' };
          } else if (tu.name === 'forget') {
            const ok = deleteNote(inp.id);
            results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: ok ? 'Forgotten.' : 'No memory with that id.' };
          } else if (tu.name === 'delegate' && SUBAGENTS[inp.agent]) {
            const agentId = inp.agent;
            emit('route', { agentId, task: inp.task || '', reason: inp.reason || '' });
            emit('agent', { agentId, state: 'assigned' });
            // Run specialists concurrently — big speedup when several are delegated at once.
            jobs.push((async () => {
              try { results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: await runSubAgent(agentId, inp.task || String(text), emit) }; }
              catch (e) { results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: '(failed: ' + ((e && e.message) || e) + ')' }; emit('agent', { agentId, state: 'idle' }); }
            })());
          } else {
            results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool.', is_error: true };
          }
        });
        await Promise.all(jobs);
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
