// ---------- The AI team (UI catalog) ----------
const AGENTS = [
  { id: 'research',  name: 'Scout', role: 'Research',        icon: '🔎', accent: '#6c8bff', ready: true,
    tag: 'Searches the web and answers questions out loud.' },
  { id: 'docs',      name: 'Quill', role: 'Documents',       icon: '📝', accent: '#34d399', ready: false,
    tag: 'Writes and edits documents, spreadsheets & slides.' },
  { id: 'marketing', name: 'Spark', role: 'Marketing',       icon: '📣', accent: '#f59e0b', ready: false,
    tag: 'Campaign ideas, copywriting, and content.' },
  { id: 'inbox',     name: 'Echo',  role: 'Slack & Email',   icon: '💬', accent: '#ec4899', ready: false,
    tag: 'Drafts and sends replies for you.' },
  { id: 'api',       name: 'Wire',  role: 'API & Automation',icon: '🔌', accent: '#22d3ee', ready: false,
    tag: 'Calls services and runs tasks on demand.' },
];

const el = (id) => document.getElementById(id);
const hub = el('hub'), chat = el('chat');
const transcript = el('transcript'), input = el('input');
const chatAvatar = el('chatAvatar'), chatName = el('chatName'), chatStatus = el('chatStatus');

let activeAgent = AGENTS[0];
let currentBubble = null;

// ---------- Build the hub grid ----------
function buildHub() {
  const grid = el('agentGrid');
  grid.innerHTML = '';
  AGENTS.forEach((a) => {
    const card = document.createElement('button');
    card.className = 'card ' + (a.ready ? 'ready' : 'locked');
    card.style.setProperty('--card-accent', a.accent);
    card.innerHTML = `
      <span class="badge ${a.ready ? 'live' : ''}">${a.ready ? 'LIVE' : 'SOON'}</span>
      <div class="card-icon">${a.icon}</div>
      <div class="card-role">${a.role}</div>
      <div class="card-name">${a.name}</div>
      <div class="card-tag">${a.tag}</div>
      <div class="card-cta">${a.ready ? 'Open →' : 'Coming soon'}</div>`;
    card.addEventListener('click', () => {
      if (a.ready) openChat(a);
      else showToast(`${a.name} (${a.role}) is coming soon.`);
    });
    grid.appendChild(card);
  });
}

// ---------- View routing ----------
function openChat(agent) {
  activeAgent = agent;
  chatAvatar.textContent = agent.icon;
  chatName.textContent = agent.name;
  document.documentElement.style.setProperty('--accent', agent.accent);
  transcript.innerHTML = '';
  addMessage(`Hi, I'm ${agent.name}. ${agent.tag}`, 'ai');
  setStatus('idle');
  hub.classList.add('hidden');
  chat.classList.remove('hidden');
  input.focus();
}
function goHub() {
  window.buddy.stopSpeaking();
  chat.classList.add('hidden');
  hub.classList.remove('hidden');
}

// ---------- Chat ----------
const STATUS_TEXT = { idle: 'Ready', thinking: 'Thinking…', searching: 'Searching the web…', speaking: 'Speaking…' };
function setStatus(state) {
  chatAvatar.className = 'chat-avatar ' + state;
  chatStatus.textContent = STATUS_TEXT[state] || 'Ready';
}
function addMessage(text, who) {
  const row = document.createElement('div');
  row.className = 'row ' + (who === 'user' ? 'user' : 'ai');
  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (who === 'user' ? 'user' : 'ai');
  bubble.textContent = text;
  row.appendChild(bubble);
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
  return bubble;
}
async function ask(question) {
  const q = (question || '').trim();
  if (!q) return;
  input.value = '';
  addMessage(q, 'user');
  currentBubble = addMessage('', 'ai');
  currentBubble.classList.add('pending');
  window.buddy.stopSpeaking();
  await window.buddy.ask(activeAgent.id, q);
}

window.buddy.onStatus(setStatus);
window.buddy.onDelta((delta) => {
  if (currentBubble) {
    currentBubble.textContent += delta;
    transcript.scrollTop = transcript.scrollHeight;
  }
});
window.buddy.onDone((text) => {
  if (currentBubble) {
    if (text) currentBubble.textContent = text;
    currentBubble.classList.remove('pending');
  }
  currentBubble = null;
});

el('sendBtn').addEventListener('click', () => ask(input.value));
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(input.value); });
el('backBtn').addEventListener('click', goHub);

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- API key setup ----------
const setup = el('setup'), keyInput = el('keyInput'), keyError = el('keyError');
async function refreshKeyScreen() {
  const has = await window.buddy.hasKey();
  setup.classList.toggle('hidden', has);
}
async function submitKey() {
  keyError.textContent = '';
  const ok = await window.buddy.saveKey(keyInput.value);
  if (ok) { keyInput.value = ''; setup.classList.add('hidden'); }
  else { keyError.textContent = 'That key looks empty — paste one starting with sk-ant-'; }
}
el('keySave').addEventListener('click', submitKey);
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });
el('hubSettings').addEventListener('click', () => setup.classList.remove('hidden'));
el('chatSettings').addEventListener('click', () => setup.classList.remove('hidden'));

// ---------- Live update button ----------
const verTag = el('verTag');
async function showVersion() {
  try { verTag.textContent = 'v' + (await window.buddy.contentVersion()); } catch (_) {}
}
el('updateBtn').addEventListener('click', async () => {
  showToast('Checking for updates…');
  const r = await window.buddy.checkUpdate();
  if (!r.ok) { showToast('Update check failed (offline?): ' + (r.error || '')); return; }
  if (!r.hasUpdate) { showToast(`You're up to date (v${r.current}).`); return; }
  showToast(`Updating to v${r.latest}…`);
  const a = await window.buddy.applyUpdate();
  if (a.ok) showToast('Updated! Reloading…');   // window reloads automatically
  else showToast('Update failed: ' + (a.error || ''));
});
showVersion();

// ---------- Voice input (record → offline Whisper → text) ----------
const micBtn = el('micBtn');
let recorder = null, chunks = [], recording = false;

micBtn.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

async function startRecording() {
  window.buddy.stopSpeaking();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      micBtn.classList.remove('listening');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      await handleTranscribe(blob);
    };
    recorder.start();
    recording = true;
    micBtn.classList.add('listening');
    chatStatus.textContent = 'Listening… tap 🎤 to stop';
  } catch (_) {
    showToast('Microphone blocked — allow it in System Settings → Privacy → Microphone, then reopen.');
  }
}

function stopRecording() {
  if (recorder && recording) { recording = false; recorder.stop(); }
}

async function handleTranscribe(blob) {
  if (!window.NexusVoice) { showToast('Voice engine still loading — try again in a moment.'); chatStatus.textContent = 'Ready'; return; }
  chatStatus.textContent = 'Transcribing…';
  try {
    const text = await window.NexusVoice.transcribe(blob, (p) => { if (p) chatStatus.textContent = p; });
    if (text) ask(text);
    else { chatStatus.textContent = 'Ready'; showToast("Didn't catch that — tap 🎤 and try again."); }
  } catch (e) {
    chatStatus.textContent = 'Ready';
    showToast('Voice failed: ' + ((e && e.message) || e) + ' (needs internet the first time to fetch the model).');
  }
}

// ---------- Boot ----------
buildHub();
refreshKeyScreen();
