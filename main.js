// Electron main process — the "shell": window, Director orchestrator, voice, updates, memory.
const { app, BrowserWindow, ipcMain, session, safeStorage, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const MAKE_KNOWLEDGE = require('./make-knowledge');

let mainWindow;
let client = null;

const MAKE_TOOL = {
  name: 'make',
  description: "Operate the user's Make.com account. actions: 'list_scenarios' (optional `query` filters by name), 'get_blueprint' (needs scenario_id — returns the scenario's blueprint JSON to STUDY), 'create_scenario' (needs `name` + `blueprint` = the scenario blueprint object with flow/metadata), 'run_scenario'/'activate'/'deactivate' (need scenario_id), 'list_connections', 'list_data_stores'.",
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_scenarios', 'get_blueprint', 'create_scenario', 'run_scenario', 'activate', 'deactivate', 'list_connections', 'list_data_stores'] },
      scenario_id: { type: 'string' }, name: { type: 'string' }, query: { type: 'string' },
      blueprint: { type: 'object', description: 'For create_scenario: the scenario blueprint object (name, flow[], metadata).' },
    },
    required: ['action'],
  },
};

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
    system: "You are Wire, an API/automation specialist AND the user's Make.com expert. For automation/API tasks give concrete steps, code, or payloads. For Make.com: BUILD scenarios (emit a valid blueprint object and call make.create_scenario), STUDY them (make.get_blueprint then explain in plain English), and list/run/activate scenarios with the `make` tool. Always name a created scenario clearly and confirm what it will do.\n\n" + MAKE_KNOWLEDGE,
    tools: [MAKE_TOOL] },
  files:     { name: 'Sift',
    system: "You are Sift, the file specialist — you find and UNDERSTAND files of ANY type, fast. Use find_files to locate and read_file to open/parse anything: text, code, JSON, CSV, PDFs, Word/Excel/PowerPoint, images (you receive them to view), or unknown/binary formats (read_file identifies the type, extracts readable text, and opens the file in its app). If a format is unfamiliar, read_file still returns its type + extracted text — reason about the structure from there and explain it. Answer the user's question about the file plainly and precisely, and name the file.",
    tools: [] },
};

const DIRECTOR_SYSTEM = `You are Agent Sea, the Director of an AI studio. You have six specialists you delegate to with the \`delegate\` tool:
- research (Scout): web search, facts, current info
- docs (Quill): writing and editing documents
- marketing (Spark): marketing copy and ideas
- inbox (Echo): drafting Slack messages and email replies
- api (Wire): API calls, automation, and Make.com — building, studying, running, and managing scenarios (delegate any Make.com / "build me an automation" / "what does this scenario do" request to Wire)
- files (Sift): finding and UNDERSTANDING any file on the Mac — text, code, JSON, CSV, PDF, Word/Excel/PowerPoint, images, or unknown/binary formats (delegate any "find/open/read/what's in this file" request to Sift; for simple lookups you can also use find_files/read_file directly)
You also have a long-term MEMORY. Use the \`remember\` tool whenever the user shares durable information (their name, company, preferences, a repeatable process/workflow) so you can act faster next time; use \`forget\` to remove an outdated item by id. Never re-ask for something already in MEMORY, and never ask for a stored credential's value.
LEARN AND ADAPT to the user over time: notice their habits, routines, favourite apps/sites/music, the people they contact, and how they like things done — and proactively \`remember\` them (e.g. "morning routine = open Chrome + Gmail", "favourite focus music = lo-fi beats on YouTube", "usually emails Areeba about design"). When you spot a repeated pattern, save it and use it so a short command triggers the whole thing next time. Prefer acting on remembered shortcuts over re-asking.
You can SEARCH the user's Mac for files with \`find_files\` (by name or content, via Spotlight) and then open a result with \`control\` action 'open_path'. Use it whenever they ask to find/locate/open a file or document.
Wire can access the user's SMARTLEAD cold-email account with the \`smartlead\` tool — list campaigns, pull a campaign's analytics (opens/replies/etc.), read leads, or add leads. If it isn't connected, tell them to click the ⚡ button to add their Smartlead API key.
You can OPEN things on the user's Mac with the \`control\` tool — launch apps (Chrome, Netflix, Spotify…) and open URLs in Chrome (websites, a YouTube search to play a song/video, etc.). When the user says open/play/put on/go to something, just do it with \`control\`; you don't need permission to open apps or websites.
You can also TAKE FULL CONTROL of the mouse and keyboard with \`take_control\` — but ONLY when the user has clearly asked you to operate the screen / navigate / click through something, AND you can't do it with a known URL or another tool. Do NOT take control for casual chat or things a direct answer or \`control\` (open URL) can do. If you already have a remembered "Working URL" for this, just open it with \`control\` instead. When you do take control, it runs one careful step at a time and the user can say "stop" to halt it instantly. Only pause to confirm before irreversible/sensitive actions (sending money, deleting, posting publicly, sending a message/email).
You control the user's HOLOGRAPHIC DISPLAY with the \`show\` tool. Be visual, like Jarvis: whenever a place, city, country, or landmark comes up, call \`show\` with kind 'map' and that place so the map flies to it on screen; when a short summary, list, or set of facts would help, call \`show\` with kind 'info'. Do this proactively and in ADDITION to speaking.
You can READ and SEARCH the user's Gmail with \`gmail_search\` (find an address, look up or check emails — returns senders/subjects/snippets + ids) and \`gmail_read\` (full body of one message by id, for summarizing). Use these to actually look things up instead of saying you can't.
You can use SLACK when connected: \`slack_search\` to find/read messages, and \`slack_send\` to post a message (channel can be #channel or @person). Confirm before sending a Slack message, same as email. If a Slack action fails because it isn't connected, tell them to click the 💬 button to connect Slack.
You can SEND EMAIL from the user's connected Gmail with the \`send_email\` tool. Workflow: draft the email (delegate to Echo if helpful), then READ BACK the recipient, subject, and a short summary of the body and ask "shall I send it?"; only after the user clearly confirms, call \`send_email\`. Never send without that confirmation. If sending fails because Gmail isn't connected, tell them to click the 📧 button to connect Gmail.
You are calm, refined, and efficient — like Jarvis from Iron Man. For each request, delegate to the right specialist(s) when needed (you may delegate more than once); for simple things, answer directly. Reply with a VERY brief spoken answer — ideally one sentence, at most two — natural and composed, no markdown, no bullet points, no URLs (it is read aloud). Address the user directly.`;

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
const SHOW_TOOL = {
  name: 'show',
  description: "Display a visual on the user's holographic HUD, in ADDITION to your brief spoken reply. Use kind 'map' whenever a place, city, country, address, region, or landmark is relevant — the map flies to it and pulses on screen. Use kind 'info' to put a short readable summary, list, or set of facts on screen while you speak. Call this proactively (e.g. mention London → show the London map); your spoken text stays one or two sentences regardless.",
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['map', 'info'], description: "'map' flies a holographic map to a place; 'info' shows a readable text panel." },
      query: { type: 'string', description: "For kind=map: the place to fly to, e.g. 'London', 'Eiffel Tower', 'Tokyo, Japan'." },
      title: { type: 'string', description: 'Short heading for the panel (both kinds).' },
      body: { type: 'string', description: "For kind=info: REQUIRED — the actual content to display, e.g. the numbered steps or facts, each item on its OWN line (use newlines). Do not leave this empty; the title is only a heading." },
      zoom: { type: 'number', description: 'Optional map zoom 3–17 (country≈5, city≈11, landmark≈16).' },
    },
    required: ['kind'],
  },
};
const SEND_EMAIL_TOOL = {
  name: 'send_email',
  description: "Send an email from the user's connected Gmail. ONLY call this AFTER you have read back the recipient, subject, and body to the user and they clearly said yes. Never send without that explicit confirmation. If Gmail isn't connected, tell the user to connect it with the 📧 button.",
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body of the email.' },
    },
    required: ['to', 'subject', 'body'],
  },
};
const GMAIL_SEARCH_TOOL = {
  name: 'gmail_search',
  description: "Search the user's Gmail and return matching messages (id, from, to, subject, date, snippet). Use it to find someone's email address, look up past emails, or check the inbox. `query` is a Gmail search string (names, keywords, from:x, subject:x, is:unread, newer_than:7d, etc.).",
  input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number', description: '1–15, default 8' } }, required: ['query'] },
};
const GMAIL_READ_TOOL = {
  name: 'gmail_read',
  description: "Read the FULL body of one Gmail message by its id (ids come from gmail_search). Use to summarize or answer questions about a specific email.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};
const SLACK_SEND_TOOL = {
  name: 'slack_send',
  description: "Send a Slack message from the user's connected Slack. `channel` can be #channel, @person, or a channel/DM id. ONLY send after reading it back and getting a clear yes — same as email.",
  input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
};
const SLACK_SEARCH_TOOL = {
  name: 'slack_search',
  description: "Search the user's Slack messages (needs a Slack user token). Returns matching messages with who/where/text. Use to find a message, catch up, or look something up.",
  input_schema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: '1–20, default 10' } }, required: ['query'] },
};
const CONTROL_TOOL = {
  name: 'control',
  description: "Open things on the user's Mac. action 'open_app' launches a Mac app by name (e.g. 'Google Chrome', 'Netflix', 'Spotify', 'Notes', 'Mail'). action 'open_url' opens a web address IN CHROME — build the exact URL yourself: to play music/video use a YouTube search URL like https://www.youtube.com/results?search_query=SONG+NAME (or a direct link), open Netflix at https://www.netflix.com, or any site. action 'open_path' opens a FILE or FOLDER by its path (e.g. a result from find_files) in its default app/Finder. Use this whenever the user says open / play / go to / put on / open the file. You may call it more than once.",
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['open_url', 'open_app', 'open_path'] }, target: { type: 'string', description: 'A full URL (open_url), a Mac app name (open_app), or a file/folder path (open_path).' } }, required: ['action', 'target'] },
};
const SMARTLEAD_TOOL = {
  name: 'smartlead',
  description: "Access the user's Smartlead cold-email/outreach account (Wire's domain). action 'list_campaigns' → campaigns (id, name, status) — the account can have HUNDREDS, so pass `query` to filter by name (e.g. query:'Vet'). 'campaign_analytics' → stats for a campaign (needs campaign_id): sent, opens, replies, bounces. 'list_leads' → leads in a campaign (needs campaign_id). 'add_leads' → add prospects (needs campaign_id + leads: array of {email, first_name?, last_name?, company_name?}). To act on a named campaign: list_campaigns with query to get its id, then use that id.",
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_campaigns', 'campaign_analytics', 'list_leads', 'add_leads'] },
      campaign_id: { type: 'string', description: 'Campaign id (from list_campaigns) — required except for list_campaigns.' },
      query: { type: 'string', description: "For list_campaigns: only return campaigns whose name contains this (case-insensitive)." },
      leads: { type: 'array', items: { type: 'object' }, description: 'For add_leads: array of {email, first_name, last_name, company_name}.' },
    },
    required: ['action'],
  },
};
const TAKE_CONTROL_TOOL = {
  name: 'take_control',
  description: "Take over the mouse and keyboard to actually DO a task on the user's screen — navigate a website, click through an app, fill a form, or fix a wrong page by clicking to the right place. Use this whenever a task needs operating the computer visually (not just opening a URL). Prefer this over `control` when the exact URL is unknown or you need to click around. `goal` = a clear, complete description of what to accomplish.",
  input_schema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
};
const FIND_FILES_TOOL = {
  name: 'find_files',
  description: "Search the user's Mac (Spotlight) for files by name or content. Returns matching file paths. Use whenever the user wants to find, locate, or open a file/document. To OPEN a result, use the `control` tool with action 'open_path' and the file path.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Filename, keywords, or phrase to find.' },
      name_only: { type: 'boolean', description: 'true = match filenames only; false (default) = also match file contents.' },
      kind: { type: 'string', description: "Optional file kind filter, e.g. 'pdf', 'image', 'folder', 'presentation', 'spreadsheet'." },
      limit: { type: 'number', description: 'Max results (default 15).' },
    },
    required: ['query'],
  },
};
const READ_FILE_TOOL = {
  name: 'read_file',
  description: "Read and UNDERSTAND a file on the Mac by its path — ANY type: text/code/JSON/CSV, PDF, Word/Excel/PowerPoint, images (returned so you can see them), or unknown/binary (it gets identified, readable text extracted, and the file opened in its app). Use after find_files, or whenever the user references a file or path.",
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const DIRECTOR_TOOLS = [DELEGATE_TOOL, REMEMBER_TOOL, FORGET_TOOL, SHOW_TOOL, SEND_EMAIL_TOOL, GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL, SLACK_SEND_TOOL, SLACK_SEARCH_TOOL, CONTROL_TOOL, SMARTLEAD_TOOL, TAKE_CONTROL_TOOL, FIND_FILES_TOOL, READ_FILE_TOOL];
SUBAGENTS.files.tools = [FIND_FILES_TOOL, READ_FILE_TOOL];   // Sift gets file find + read (defined above via hoisting-safe assignment)

// --- File search (Spotlight / mdfind) ---------------------------------------
function findFiles(query, nameOnly, kind, limit) {
  return new Promise((resolve) => {
    const q = String(query || '').trim();
    if (!q) { resolve('No query.'); return; }
    const args = ['-onlyin', os.homedir()];
    if (nameOnly) { args.push('-name', q); }
    else if (kind) { args.push('kMDItemDisplayName == "*' + q + '*"cd || (kMDItemTextContent == "*' + q + '*"cd && kMDItemKind == "*' + kind + '*"cd)'); }
    else { args.push(q); }
    execFile('mdfind', args, { maxBuffer: 4 * 1024 * 1024, timeout: 12000 }, (e, out) => {
      let lines = String(out || '').split('\n').filter(Boolean);
      if (kind && !nameOnly) lines = lines.filter((p) => new RegExp(kind, 'i').test(p) || true); // kind mostly handled in query
      const n = Math.max(1, Math.min(40, limit || 15));
      lines = lines.slice(0, n);
      if (!lines.length) { resolve('No files found for "' + q + '".'); return; }
      resolve(lines.map((p) => { const name = p.split('/').pop(); return name + '  —  ' + p; }).join('\n'));
    });
  });
}
function runOut(cmd, args) { return new Promise((res) => execFile(cmd, args, { maxBuffer: 12 * 1024 * 1024, timeout: 20000 }, (e, out) => res(String(out || '')))); }
const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'].find((x) => { try { return fs.existsSync(x); } catch (_) { return false; } });
// Understand any file — pick the best extraction per type; learn/adapt for unknowns.
async function readFileSmart(p) {
  p = String(p || '').trim().replace(/^~(?=\/)/, os.homedir());
  let st; try { st = fs.statSync(p); } catch (_) { return { kind: 'text', text: 'File not found: ' + p }; }
  if (st.isDirectory()) { let items = []; try { items = fs.readdirSync(p).slice(0, 300); } catch (_) {} return { kind: 'text', text: 'Folder ' + p + ' (' + items.length + ' items):\n' + items.join('\n') }; }
  const ext = (p.split('.').pop() || '').toLowerCase();
  const cap = (t) => (t.length > 60000 ? t.slice(0, 60000) + '\n…[truncated]' : t);
  const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  if (IMG[ext]) { try { return { kind: 'image', b64: fs.readFileSync(p).toString('base64'), media_type: IMG[ext] }; } catch (_) {} }
  if (['heic', 'heif', 'tiff', 'tif'].includes(ext)) { const tmp = path.join(os.tmpdir(), 'nx-i-' + Date.now() + '.png'); await sh('sips', ['-s', 'format', 'png', p, '--out', tmp]); try { const b = fs.readFileSync(tmp).toString('base64'); fs.unlinkSync(tmp); return { kind: 'image', b64: b, media_type: 'image/png' }; } catch (_) {} }
  const TEXT = ['txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sh', 'zsh', 'bash', 'css', 'scss', 'less', 'sql', 'env', 'blueprint', 'geojson', 'svg', 'php', 'pl', 'lua', 'r', 'swift', 'kt', 'gradle', 'properties', 'plist', 'srt', 'vtt'];
  if (TEXT.includes(ext)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      if (ext === 'json' || ext === 'blueprint' || /\.blueprint\.json$/i.test(p)) {   // Make blueprint → compact flow map
        try { const j = JSON.parse(raw); const b = j.blueprint || j; if (b && Array.isArray(b.flow)) return { kind: 'text', text: 'Make.com blueprint file:\n' + summarizeBlueprint(b).slice(0, 40000) }; } catch (_) {}
      }
      return { kind: 'text', text: cap(raw) };
    } catch (_) {}
  }
  if (ext === 'pdf') {
    if (PDFTOTEXT) { const out = await runOut(PDFTOTEXT, ['-nopgbrk', p, '-']); if (out.trim()) return { kind: 'text', text: cap(out) }; }
    const tmp = path.join(os.tmpdir(), 'nx-pdf-' + Date.now() + '.png'); await sh('sips', ['-s', 'format', 'png', p, '--out', tmp]);
    try { const b = fs.readFileSync(tmp).toString('base64'); fs.unlinkSync(tmp); return { kind: 'image', b64: b, media_type: 'image/png' }; } catch (_) {}
    return { kind: 'text', text: 'PDF at ' + p + ' — could not extract text.' };
  }
  if (['docx', 'doc', 'rtf', 'odt', 'rtfd', 'wpd'].includes(ext)) { const out = await runOut('textutil', ['-convert', 'txt', '-stdout', p]); if (out.trim()) return { kind: 'text', text: cap(out) }; }
  if (['xlsx', 'pptx', 'docx', 'ods', 'odp', 'epub', 'key', 'numbers', 'pages'].includes(ext)) { const out = await runOut('unzip', ['-p', p, '*.xml']); const s = out.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); if (s) return { kind: 'text', text: cap(s) }; }
  // Unknown / binary — identify it, pull readable strings, and open it so the user sees it.
  const ftype = (await runOut('file', ['-b', p])).trim() || 'unknown type';
  if (/\btext\b|ASCII|UTF-8|JSON|XML|source/i.test(ftype)) { try { return { kind: 'text', text: cap(fs.readFileSync(p, 'utf8')) }; } catch (_) {} }
  const strs = (await runOut('strings', [p])).trim();
  execFile('open', [p], () => {});
  return { kind: 'text', text: "I couldn't fully parse this as text (it's " + ftype + '), so I opened it in its default app. Readable text extracted:\n' + (strs ? strs.slice(0, 20000) : '(none)') };
}
function toolResultContent(r) { return r.kind === 'image' ? [{ type: 'image', source: { type: 'base64', media_type: r.media_type, data: r.b64 } }] : (r.text || '(empty)'); }

// --- Smartlead (cold-email API; key as ?api_key=) ---------------------------
async function smartleadCall(path, method, body) {
  const key = loadConfig().smartleadKey;
  if (!key) throw new Error('Smartlead not connected');
  const url = 'https://server.smartlead.ai/api/v1' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
  const opts = { method: method || 'GET', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const txt = await res.text();
  if (!res.ok) throw new Error('Smartlead HTTP ' + res.status + ' ' + txt.slice(0, 160));
  try { return JSON.parse(txt); } catch (_) { return txt; }
}
async function smartleadAction(action, campaignId, leads, query) {
  if (action === 'list_campaigns') {
    const c = await smartleadCall('/campaigns/', 'GET');
    let arr = Array.isArray(c) ? c : (c.data || []);
    if (query) { const q = String(query).toLowerCase(); arr = arr.filter((x) => String(x.name || '').toLowerCase().indexOf(q) !== -1); }
    if (!arr.length) return query ? ('No campaigns matching "' + query + '".') : 'No campaigns found.';
    return 'Total ' + arr.length + (query ? ' matching "' + query + '"' : '') + ':\n' + arr.slice(0, 60).map((x) => 'id=' + x.id + ' | ' + (x.name || '(unnamed)') + ' | ' + (x.status || '')).join('\n');
  }
  if (!campaignId) throw new Error('campaign_id is required');
  if (action === 'campaign_analytics') return JSON.stringify(await smartleadCall('/campaigns/' + campaignId + '/analytics', 'GET')).slice(0, 1600);
  if (action === 'list_leads') return JSON.stringify(await smartleadCall('/campaigns/' + campaignId + '/leads', 'GET')).slice(0, 1600);
  if (action === 'add_leads') { const r = await smartleadCall('/campaigns/' + campaignId + '/leads', 'POST', { lead_list: (leads || []).slice(0, 400) }); return 'Add leads result: ' + JSON.stringify(r).slice(0, 500); }
  throw new Error('Unknown Smartlead action');
}

// --- Make.com (Wire's automation platform) ----------------------------------
function makeConfig() { const c = loadConfig(); return { token: c.makeToken || '', zone: c.makeZone || 'eu1' }; }
async function makeCall(method, mpath, body) {
  const { token, zone } = makeConfig();
  if (!token) throw new Error('Make not connected');
  const opts = { method, headers: { Authorization: 'Token ' + token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('https://' + zone + '.make.com/api/v2' + mpath, opts);
  const txt = await res.text();
  if (!res.ok) throw new Error('Make HTTP ' + res.status + ' ' + txt.slice(0, 180));
  try { return JSON.parse(txt); } catch (_) { return txt; }
}
async function makeTeam() {
  const c = loadConfig(); if (c.makeTeamId) return c.makeTeamId;
  const orgs = await makeCall('GET', '/organizations'); const org = (orgs.organizations || [])[0];
  if (!org) throw new Error('No Make organization on this account');
  const teams = await makeCall('GET', '/teams?organizationId=' + org.id); const team = (teams.teams || [])[0];
  if (!team) throw new Error('No Make team found');
  c.makeTeamId = team.id; saveConfig(c); return team.id;
}
// Parse a Make blueprint into a compact, COMPLETE flow map — so even a 25+ module
// scenario fits cleanly in context instead of being truncated raw JSON.
function countModules(flow) { let n = 0; (flow || []).forEach((m) => { n++; if (Array.isArray(m.routes)) m.routes.forEach((rt) => { n += countModules(rt && rt.flow); }); }); return n; }
function summarizeBlueprint(bp) {
  bp = (bp && (bp.blueprint || bp)) || {};
  const short = (v) => { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 90 ? s.slice(0, 90) + '…' : s; } catch (_) { return ''; } };
  const lines = [];
  function walk(flow, depth) {
    (flow || []).forEach((m) => {
      const ind = '  '.repeat(depth);
      const mod = m.module || m.type || '?';
      const label = (m.metadata && m.metadata.designer && (m.metadata.designer.name || m.metadata.designer.label)) || m.label || '';
      const p = Object.assign({}, m.parameters || {}, m.mapper || {});
      const params = Object.keys(p).slice(0, 8).map((k) => k + '=' + short(p[k])).filter((s) => s.length < 110).join(', ');
      lines.push(ind + '#' + (m.id != null ? m.id : '?') + ' ' + mod + (label ? ' ["' + label + '"]' : '') + (params ? ' — ' + params : ''));
      if (m.filter && (m.filter.conditions || m.filter.name)) lines.push(ind + '   ↳ filter: ' + short(m.filter.name || m.filter.conditions));
      if (Array.isArray(m.routes)) m.routes.forEach((rt, i) => { lines.push(ind + '   ├─ route ' + (i + 1) + ':'); walk(rt && rt.flow, depth + 2); });
    });
  }
  walk(bp.flow, 0);
  return 'Scenario "' + (bp.name || '(unnamed)') + '" — ' + countModules(bp.flow) + ' modules:\n' + lines.join('\n');
}
async function makeAction(inp) {
  const a = inp.action;
  if (a === 'list_scenarios') {
    const team = await makeTeam();
    const sc = await makeCall('GET', '/scenarios?teamId=' + team + '&pg[limit]=100');
    let arr = sc.scenarios || [];
    if (inp.query) { const q = String(inp.query).toLowerCase(); arr = arr.filter((s) => String(s.name || '').toLowerCase().indexOf(q) !== -1); }
    return arr.length ? ('Total ' + arr.length + ':\n' + arr.slice(0, 60).map((s) => 'id=' + s.id + ' | ' + (s.name || '') + ' | ' + (s.isActive ? 'ON' : 'off')).join('\n')) : 'No scenarios found.';
  }
  if (a === 'get_blueprint') { const bp = await makeCall('GET', '/scenarios/' + inp.scenario_id + '/blueprint'); return summarizeBlueprint((bp.response && bp.response.blueprint) || bp).slice(0, 30000); }
  if (a === 'create_scenario') {
    const team = await makeTeam();
    const bp = inp.blueprint || {}; if (inp.name && !bp.name) bp.name = inp.name;
    const r = await makeCall('POST', '/scenarios', { blueprint: JSON.stringify(bp), teamId: team, scheduling: JSON.stringify({ type: 'indefinitely', interval: 900 }) });
    return 'Created scenario id=' + ((r.scenario && r.scenario.id) || JSON.stringify(r).slice(0, 200)) + ' (created OFF — activate when ready).';
  }
  if (a === 'run_scenario') { const r = await makeCall('POST', '/scenarios/' + inp.scenario_id + '/run', { responsive: false }); return 'Run started: ' + JSON.stringify(r).slice(0, 160); }
  if (a === 'activate') { await makeCall('POST', '/scenarios/' + inp.scenario_id + '/start', {}); return 'Scenario activated.'; }
  if (a === 'deactivate') { await makeCall('POST', '/scenarios/' + inp.scenario_id + '/stop', {}); return 'Scenario deactivated.'; }
  if (a === 'list_connections') { const team = await makeTeam(); const r = await makeCall('GET', '/connections?teamId=' + team); return JSON.stringify(r.connections || r).slice(0, 2500); }
  if (a === 'list_data_stores') { const team = await makeTeam(); const r = await makeCall('GET', '/data-stores?teamId=' + team); return JSON.stringify(r.dataStores || r['data-stores'] || r).slice(0, 2500); }
  return 'Unknown make action.';
}

// --- Full computer control: Sea sees the screen + moves/clicks the mouse ----
function sh(cmd, args) { return new Promise((r) => execFile(cmd, args, () => r())); }
// A Finder-launched app has a minimal PATH, so resolve cliclick's absolute path.
const CLICLICK = ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick', '/usr/bin/cliclick'].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || 'cliclick';
let controlAbort = false;   // set true to halt an in-progress take_control loop
function chromeURL() {
  return new Promise((r) => execFile('osascript', ['-e', 'tell application "Google Chrome" to get URL of active tab of front window'], (e, out) => r(String(out || '').trim())));
}
function getScreen() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], (e, out) => {
      const m = String(out || '').match(/(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
      resolve(m ? { w: parseInt(m[3], 10), h: parseInt(m[4], 10) } : { w: 1512, h: 982 });
    });
  });
}
async function grabScreen(dw, dh) {
  const tmp = path.join(os.tmpdir(), 'nx-shot-' + Date.now() + '.png');
  await sh('screencapture', ['-x', '-C', '-t', 'png', tmp]);
  await sh('sips', ['-z', String(dh), String(dw), tmp]);
  let b = ''; try { b = fs.readFileSync(tmp).toString('base64'); } catch (_) {}
  try { fs.unlinkSync(tmp); } catch (_) {}
  return b;
}
function translateKey(text) {
  const named = { return: 'return', enter: 'return', tab: 'tab', escape: 'esc', esc: 'esc', space: 'space', backspace: 'delete', delete: 'delete', up: 'arrow-up', down: 'arrow-down', left: 'arrow-left', right: 'arrow-right', page_up: 'page-up', page_down: 'page-down', home: 'home', end: 'end' };
  const parts = String(text || '').split('+'); const mods = []; let key = null;
  for (const p of parts) { const t = p.trim().toLowerCase();
    if (['cmd', 'command', 'super', 'meta'].includes(t)) mods.push('cmd');
    else if (['ctrl', 'control'].includes(t)) mods.push('ctrl');
    else if (['alt', 'option'].includes(t)) mods.push('alt');
    else if (t === 'shift') mods.push('shift');
    else key = p.trim(); }
  const cmds = []; mods.forEach((m) => cmds.push('kd:' + m));
  if (key) { const nk = named[key.toLowerCase()]; cmds.push(nk ? ('kp:' + nk) : ('t:' + key)); }
  mods.slice().reverse().forEach((m) => cmds.push('ku:' + m));
  return cmds.length ? cmds : ['kp:return'];
}
// The built-in computer tool isn't supported on current models, so we give Sea
// a custom one-action-at-a-time tool over ordinary screenshots (regular vision).
const SCREEN_ACTION_TOOL = {
  name: 'screen_action',
  description: 'Do ONE action on the screen; you then receive a fresh screenshot. x,y are PIXELS in the screenshot you were shown (top-left = 0,0).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'done'] },
      x: { type: 'number' }, y: { type: 'number' },
      text: { type: 'string', description: 'action=type: text to type. action=key: a key or combo like "Return", "cmd+l", "cmd+t".' },
      scroll_direction: { type: 'string', enum: ['up', 'down'] },
      summary: { type: 'string', description: 'action=done: one short sentence on what you accomplished.' },
    },
    required: ['action'],
  },
};
async function execCustomAction(a, scale) {
  const x = Math.round((a.x || 0) / scale), y = Math.round((a.y || 0) / scale);
  switch (a.action) {
    case 'click': await sh(CLICLICK, ['c:' + x + ',' + y]); break;
    case 'double_click': await sh(CLICLICK, ['dc:' + x + ',' + y]); break;
    case 'right_click': await sh(CLICLICK, ['rc:' + x + ',' + y]); break;
    case 'move': await sh(CLICLICK, ['m:' + x + ',' + y]); break;
    case 'type': await sh(CLICLICK, ['-w', '8', 't:' + String(a.text || '')]); break;
    case 'key': await sh(CLICLICK, translateKey(a.text)); break;
    case 'scroll': { const k = a.scroll_direction === 'up' ? 'arrow-up' : 'arrow-down'; const seq = []; for (let i = 0; i < 5; i++) seq.push('kp:' + k); await sh(CLICLICK, seq); break; }
    default: break;
  }
}
async function computerUse(goal, emit) {
  const scr = await getScreen();
  const scale = Math.min(1, 1280 / scr.w);
  const dw = Math.round(scr.w * scale), dh = Math.round(scr.h * scale);
  const sys = 'You operate the user\'s Mac by looking at screenshots and issuing ONE screen_action at a time. Each screenshot is ' + dw + 'x' + dh + ' pixels (top-left origin); x,y are pixels in that image. Take the single best next step toward the goal (click a button/link/field, type, press a key, or scroll), then you get a new screenshot. To open a URL in Chrome: key "cmd+l" to focus the address bar, type the URL, then key "Return". New tab = key "cmd+t". Be precise about where you click. Call action "done" with a short summary when finished. Never ask the user questions — just get it done.';
  controlAbort = false;
  let shot = await grabScreen(dw, dh);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Goal: ' + goal }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] }];
  let lastSig = '', repeat = 0;
  for (let i = 0; i < 12; i++) {
    if (controlAbort) return 'Stopped.';
    let msg;
    try { msg = await client.messages.create({ model: directorModel(), max_tokens: 1024, system: sys, tools: [SCREEN_ACTION_TOOL], tool_choice: { type: 'any' }, messages }); }
    catch (e) { throw new Error('vision API: ' + ((e && e.message) || e)); }
    if (controlAbort) return 'Stopped.';
    messages.push({ role: 'assistant', content: msg.content });
    const tu = msg.content.find((b) => b.type === 'tool_use');
    if (!tu) return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || 'Done.';
    const a = tu.input || {};
    if (a.action === 'done') {
      const url = await chromeURL();
      if (url && /^https?:/i.test(url)) { try { addNote('process', 'Working URL for "' + goal + '": ' + url); emit && emit('memory', { reason: 'learned-url' }); } catch (_) {} }
      return a.summary || 'Done.';
    }
    const sig = a.action + ':' + (a.x || '') + ',' + (a.y || '') + ':' + (a.text || '');
    if (sig === lastSig) { repeat++; if (repeat >= 2) return 'Stopped — it was repeating the same action without progress.'; } else repeat = 0;
    lastSig = sig;
    emit && emit('notice', { text: 'Sea: ' + a.action + (a.x != null ? ' @' + Math.round(a.x) + ',' + Math.round(a.y) : (a.text ? ' "' + String(a.text).slice(0, 24) + '"' : '')) });
    try { await execCustomAction(a, scale); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
    if (controlAbort) return 'Stopped.';
    shot = await grabScreen(dw, dh);
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } }] }] });
  }
  return 'Stopped after 12 steps — tell me if it got close and I can continue.';
}

// --- Mac control: open apps + URLs (in Chrome) ------------------------------
function macControl(action, target) {
  const t = String(target || '').trim();
  if (!t) throw new Error('nothing to open');
  if (action === 'open_app') { execFile('open', ['-a', t], () => {}); return 'Opening ' + t + '.'; }
  if (action === 'open_path') { execFile('open', [t], () => {}); return 'Opening ' + (t.split('/').pop() || t) + '.'; }
  let url = t; if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;   // default to https
  execFile('open', ['-a', 'Google Chrome', url], (err) => { if (err) execFile('open', [url], () => {}); });  // Chrome, else default browser
  return 'Opening ' + url + '.';
}

// --- Slack (Web API via a user/bot token) -----------------------------------
function slackToken() { return loadConfig().slackToken || ''; }
async function slackCall(method, params) {
  const token = slackToken();
  if (!token) throw new Error('Slack not connected');
  const body = new URLSearchParams();
  const p = params || {};
  for (const k in p) { if (p[k] != null) body.append(k, typeof p[k] === 'object' ? JSON.stringify(p[k]) : String(p[k])); }
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  });
  const d = await res.json().catch(() => ({ ok: false, error: 'bad-response' }));
  if (!d.ok) throw new Error('Slack ' + method + ': ' + (d.error || 'failed'));
  return d;
}
async function slackResolveChannel(name) {
  const n = String(name || '').replace(/^[#@]/, '').toLowerCase().trim();
  if (/^[CDG][A-Z0-9]{6,}$/.test(String(name || ''))) return name;   // already an id
  try {
    const conv = await slackCall('conversations.list', { types: 'public_channel,private_channel', limit: 1000 });
    const ch = (conv.channels || []).find((c) => (c.name || '').toLowerCase() === n);
    if (ch) return ch.id;
  } catch (_) {}
  const users = await slackCall('users.list', {});
  const u = (users.members || []).find((m) => (m.name || '').toLowerCase() === n || ((m.profile && m.profile.display_name) || '').toLowerCase() === n || ((m.profile && m.profile.real_name) || '').toLowerCase() === n);
  if (u) { const dm = await slackCall('conversations.open', { users: u.id }); return dm.channel.id; }
  throw new Error('No Slack channel or person called "' + name + '"');
}
async function slackSend(channel, text) {
  const id = await slackResolveChannel(channel);
  const d = await slackCall('chat.postMessage', { channel: id, text: String(text || '') });
  return d.ts || 'sent';
}
async function slackSearch(query, count) {
  const d = await slackCall('search.messages', { query: String(query || ''), count: Math.max(1, Math.min(20, count || 10)) });
  return (((d.messages || {}).matches) || []).map((m) => ({ from: m.username || m.user || '', channel: (m.channel && m.channel.name) || '', text: m.text || '', permalink: m.permalink || '' }));
}
async function slackAuthTest() { const d = await slackCall('auth.test', {}); return { team: d.team, user: d.user }; }

// --- Gmail sending (SMTP + App Password via nodemailer) ---------------------
function gmailConfig() {
  const c = loadConfig();
  const oauth = (c.gmailOAuth && c.gmailOAuth.refreshToken) ? c.gmailOAuth : null;
  return { user: c.gmailUser || (oauth && oauth.user) || '', pass: c.gmailAppPass || '', oauth };
}
async function gmailAccessToken(o) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error('Token refresh failed (HTTP ' + res.status + ') ' + (await res.text().catch(() => '')).slice(0, 120));
  const d = await res.json();
  if (!d.access_token) throw new Error('No access token from Google');
  return d.access_token;
}
async function sendGmail(to, subject, body) {
  const g = gmailConfig();
  if (!g.user || (!g.oauth && !g.pass)) throw new Error('Gmail not connected');
  if (g.oauth) {
    // OAuth path → Gmail send API (uses only the gmail.send scope).
    const token = await gmailAccessToken(g.oauth);
    const mime = [
      'From: ' + g.user, 'To: ' + String(to || ''), 'Subject: ' + String(subject || '(no subject)'),
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', String(body || ''),
    ].join('\r\n');
    const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error('Gmail API HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 160));
    const d = await res.json();
    return d.id || 'sent';
  }
  // App Password fallback → SMTP.
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: g.user, pass: g.pass.replace(/\s+/g, '') } });
  const info = await transporter.sendMail({ from: g.user, to: String(to || ''), subject: String(subject || '(no subject)'), text: String(body || '') });
  return (info && info.messageId) ? info.messageId : 'sent';
}

// Read side — search the inbox + fetch a full message (needs the OAuth connection).
function decodeB64Url(s) { try { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (_) { return ''; } }
function headerMap(payload) { const h = {}; ((payload && payload.headers) || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; }); return h; }
async function gmailSearch(query, max) {
  const g = gmailConfig();
  if (!g.oauth) throw new Error('Reading the inbox needs the Gmail OAuth connection (reconnect via 📧).');
  const token = await gmailAccessToken(g.oauth);
  const n = Math.max(1, Math.min(15, max || 8));
  const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + n + '&q=' + encodeURIComponent(String(query || '')), { headers: { Authorization: 'Bearer ' + token } });
  if (!listRes.ok) throw new Error('Gmail list HTTP ' + listRes.status + ' ' + (await listRes.text().catch(() => '')).slice(0, 120));
  const ids = ((await listRes.json()).messages || []).slice(0, n).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const mRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date', { headers: { Authorization: 'Bearer ' + token } });
    if (!mRes.ok) continue;
    const m = await mRes.json(); const h = headerMap(m.payload);
    out.push({ id, from: h.from || '', to: h.to || '', subject: h.subject || '(no subject)', date: h.date || '', snippet: m.snippet || '' });
  }
  return out;
}
async function gmailRead(id) {
  const g = gmailConfig();
  if (!g.oauth) throw new Error('Reading the inbox needs the Gmail OAuth connection.');
  const token = await gmailAccessToken(g.oauth);
  const mRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(id) + '?format=full', { headers: { Authorization: 'Bearer ' + token } });
  if (!mRes.ok) throw new Error('Gmail read HTTP ' + mRes.status);
  const m = await mRes.json(); const h = headerMap(m.payload);
  // Pull the plain-text body from the MIME tree.
  let text = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) { text += decodeB64Url(p.body.data); }
    else if (p.parts) p.parts.forEach(walk);
  })(m.payload);
  if (!text && m.payload && m.payload.body && m.payload.body.data) text = decodeB64Url(m.payload.body.data);
  return { from: h.from || '', to: h.to || '', subject: h.subject || '', date: h.date || '', body: (text || m.snippet || '').slice(0, 6000) };
}

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

// --- Short-term conversation memory (the running chat, remembered across prompts + restarts) ---
let conversation = [];               // [{ role:'user'|'assistant', content:string }]
const CONV_MAX_MESSAGES = 2000;      // up to ~1000 exchanges
const CONV_MAX_CHARS = 200000;       // ~50k-token safety cap so each request stays fast
function convPath() { return path.join(app.getPath('userData'), 'conversation.json'); }
function loadConversation() {
  try {
    const a = JSON.parse(fs.readFileSync(convPath(), 'utf8'));
    if (Array.isArray(a)) conversation = a.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  } catch (_) {}
}
function saveConversation() { try { fs.writeFileSync(convPath(), JSON.stringify(conversation)); } catch (_) {} }
function trimConversation() {
  if (conversation.length > CONV_MAX_MESSAGES) conversation = conversation.slice(-CONV_MAX_MESSAGES);
  let total = 0; for (const m of conversation) total += m.content.length;
  while (conversation.length > 2 && total > CONV_MAX_CHARS) { total -= conversation[0].content.length; conversation.shift(); }
  while (conversation.length && conversation[0].role !== 'user') conversation.shift(); // history must start on a user turn
}
// Only the RECENT slice of the conversation is sent to the model — the full
// history is still kept on disk, but re-sending all of it every turn is what
// makes each reply cost more. This caps the per-request context to save credits.
const SEND_MAX_MESSAGES = 24, SEND_MAX_CHARS = 14000;
function priorMessages() {
  let msgs = conversation.slice(-SEND_MAX_MESSAGES);
  let total = 0; for (const m of msgs) total += m.content.length;
  while (msgs.length > 2 && total > SEND_MAX_CHARS) { total -= msgs[0].content.length; msgs = msgs.slice(1); }
  while (msgs.length && msgs[0].role !== 'user') msgs = msgs.slice(1);
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}
// Sea's "brain" model — configurable so it can be dialed for cost vs smarts.
function directorModel() { return loadConfig().directorModel || 'claude-opus-4-8'; }
function cachedSystem(text) { return [{ type: 'text', text: String(text || ''), cache_control: { type: 'ephemeral' } }]; }
function recordExchange(userText, assistantText) {
  conversation.push({ role: 'user', content: String(userText || '') }, { role: 'assistant', content: String(assistantText || '(no reply)') });
  trimConversation(); saveConversation();
}
function resetConversation() { conversation = []; saveConversation(); }
const RESET_RE = /^\s*(new conversation|start over|start fresh|fresh start|forget (this|our) (chat|conversation)|clear (the )?(chat|history|conversation)|reset( the)? (chat|conversation))\s*[.!]?\s*$/i;

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
const CONTENT_FILES = ['index.html', 'styles.css', 'renderer.js', 'voice.js', 'game.js', 'memory.js', 'memory.css', 'jarvis.js', 'jarvis.css', 'display.js', 'display.css', 'voice-ui.js', 'voiceid.js', 'gmail-ui.js', 'slack-ui.js', 'smartlead-ui.js', 'make-ui.js', 'leaflet.js', 'leaflet.css', 'manifest.json'];
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,   // keep listening/timers running when Nexus is behind another app
    },
  });
  mainWindow.loadFile(path.join(activeContentDir(), 'index.html'));
}

app.whenReady().then(() => {
  initClient();
  loadConversation();
  if (app.isPackaged) syncBundledContent();
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
  // Let Sea "see" the screen (getDisplayMedia) — hand back the primary screen source.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback(sources && sources[0] ? { video: sources[0] } : {});
      }).catch(() => callback({}));
    });
  } catch (_) {}
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

// --- Gmail connect IPC ------------------------------------------------------
ipcMain.handle('gmail:get', () => { const g = gmailConfig(); return { connected: !!(g.oauth || (g.user && g.pass)), user: g.user, method: g.oauth ? 'oauth' : (g.pass ? 'app-password' : 'none') }; });
ipcMain.handle('gmail:set', (_e, user, pass) => {
  const c = loadConfig();
  const u = String(user || '').trim();
  const p = String(pass || '').replace(/\s+/g, '');
  if (u) c.gmailUser = u; else delete c.gmailUser;
  if (p) c.gmailAppPass = p; else delete c.gmailAppPass;
  saveConfig(c);
  return { ok: true, connected: !!(c.gmailUser && c.gmailAppPass) };
});
ipcMain.handle('gmail:test', async () => {
  const g = gmailConfig();
  if (!g.user || (!g.oauth && !g.pass)) return { ok: false, error: 'Not connected.' };
  try { const id = await sendGmail(g.user, 'Nexus test ✓', 'This is a test from Agent Sea — email sending works.'); return { ok: true, id }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Make.com connect IPC ---------------------------------------------------
ipcMain.handle('make:get', () => { const c = loadConfig(); return { connected: !!c.makeToken, zone: c.makeZone || 'eu1' }; });
ipcMain.handle('make:set', (_e, token, zone) => {
  const c = loadConfig(); const t = String(token || '').trim();
  if (t) c.makeToken = t; else delete c.makeToken;
  if (zone) c.makeZone = String(zone).trim();
  delete c.makeTeamId;   // re-resolve team on next use (token/zone changed)
  saveConfig(c); return { ok: true, connected: !!c.makeToken };
});
ipcMain.handle('make:test', async () => {
  if (!loadConfig().makeToken) return { ok: false, error: 'Not connected.' };
  try { const team = await makeTeam(); const sc = await makeCall('GET', '/scenarios?teamId=' + team + '&pg[limit]=1'); return { ok: true, team, total: (sc.pg && sc.pg.total) != null ? sc.pg.total : (sc.scenarios ? sc.scenarios.length : 0) }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Smartlead connect IPC --------------------------------------------------
ipcMain.handle('smartlead:get', () => ({ connected: !!loadConfig().smartleadKey }));
ipcMain.handle('smartlead:set', (_e, key) => {
  const c = loadConfig(); const t = String(key || '').trim();
  if (t) c.smartleadKey = t; else delete c.smartleadKey;
  saveConfig(c); return { ok: true, connected: !!c.smartleadKey };
});
ipcMain.handle('smartlead:test', async () => {
  if (!loadConfig().smartleadKey) return { ok: false, error: 'Not connected.' };
  try { const c = await smartleadCall('/campaigns/', 'GET'); const arr = Array.isArray(c) ? c : (c.data || []); return { ok: true, count: arr.length }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Slack connect IPC ------------------------------------------------------
ipcMain.handle('slack:get', () => ({ connected: !!slackToken() }));
ipcMain.handle('slack:set', (_e, token) => {
  const c = loadConfig(); const t = String(token || '').trim();
  if (t) c.slackToken = t; else delete c.slackToken;
  saveConfig(c); return { ok: true, connected: !!c.slackToken };
});
ipcMain.handle('slack:test', async () => {
  if (!slackToken()) return { ok: false, error: 'Not connected.' };
  try { const a = await slackAuthTest(); return { ok: true, team: a.team, user: a.user }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Morning briefing: urgent unread email from the past day ----------------
ipcMain.handle('orch:briefing', async (event) => {
  const emit = (evt, payload) => { try { event.sender.send('orch:' + evt, payload); } catch (_) {} };
  if (!client) return { ok: false, error: 'no-key' };
  if (!gmailConfig().oauth) return { ok: false, error: 'gmail-not-connected' };
  const sys = 'You are Agent Sea preparing the user\'s MORNING BRIEFING. Use gmail_search to find UNREAD emails from the past day (query exactly: is:unread newer_than:1d). Decide which are URGENT — from clients, a boss, or important people; deadlines, requests, or anything time-sensitive that needs a prompt reply. If useful, gmail_read the top one or two. Then output PLAIN TEXT only: one urgent item per line as "• Sender — Subject — why it matters (1 short clause)", most urgent first, at most 6 lines. If nothing is urgent, output exactly "No urgent unread emails from the past day." End with a final line like "— N urgent of M unread." No preamble, no markdown headers.' + buildMemoryBlock();
  const messages = [{ role: 'user', content: 'Prepare my morning briefing of urgent unread emails from the past day.' }];
  emit('manager', { state: 'thinking' });
  emit('agent', { agentId: 'inbox', state: 'searching' });
  let finalText = '';
  try {
    for (let turn = 0; turn < 6; turn++) {
      const stream = client.messages.stream({ model: directorModel(), max_tokens: 1500, system: cachedSystem(sys), tools: [GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL], messages });
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content });
      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason === 'tool_use' && toolUses.length) {
        const results = [];
        for (const tu of toolUses) {
          const inp = tu.input || {};
          try {
            if (tu.name === 'gmail_search') { const f = await gmailSearch(inp.query, inp.max); results.push({ type: 'tool_result', tool_use_id: tu.id, content: f.length ? f.map((m, i) => (i + 1) + '. id=' + m.id + ' | From: ' + m.from + ' | Subject: ' + m.subject + ' | ' + m.date + '\n   ' + m.snippet).join('\n') : 'No matching emails.' }); }
            else if (tu.name === 'gmail_read') { const m = await gmailRead(inp.id); results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'From: ' + m.from + '\nSubject: ' + m.subject + '\nDate: ' + m.date + '\n\n' + m.body }); }
            else results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool.', is_error: true });
          } catch (e) { results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Failed: ' + ((e && e.message) || e), is_error: true }); }
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    emit('agent', { agentId: 'inbox', state: 'done' });
    emit('display', { kind: 'info', title: 'Morning Briefing — Urgent Unread', body: finalText || 'No urgent unread emails.' });
    const first = (finalText || '').split('\n').filter(Boolean);
    const spoken = 'Good morning. ' + (/^no urgent/i.test(finalText) ? 'No urgent unread emails from the past day.' : ('You have ' + Math.max(0, first.filter((l) => l.trim().startsWith('•')).length) + ' urgent email' + (first.filter((l) => l.trim().startsWith('•')).length === 1 ? '' : 's') + ' this morning; the briefing is on screen.'));
    emit('manager', { state: 'speaking' });
    speak(spoken, () => emit('manager', { state: 'idle' }));
    return { ok: true, text: finalText };
  } catch (e) { emit('agent', { agentId: 'inbox', state: 'idle' }); emit('manager', { state: 'idle' }); return { ok: false, error: (e && e.message) || String(e) }; }
});
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
// Two engines: (1) ElevenLabs neural TTS — a true cinematic "Jarvis" voice, used
// whenever an ElevenLabs key is configured; (2) macOS `say` (pitch-tuned Daniel)
// as an always-available fallback. Any ElevenLabs failure degrades to `say`.
const DEFAULT_ELEVEN_VOICE = 'onwK4e9ZLuTAKqWW03F9';   // "Daniel — Steady Broadcaster" (British, composed)
const DEFAULT_ELEVEN_MODEL = 'eleven_multilingual_v2'; // most cinematic; flash_v2_5 is the low-latency option
let sayProc = null, playProc = null, ttsAbort = null, speakGen = 0;

// Every new utterance (and every stop) bumps speakGen. All async continuations
// check their captured gen against the live speakGen and bail if superseded, so
// only ONE voice can ever be producing audio — no overlapping / leaking voices.
function stopSpeaking() {
  speakGen++;
  controlAbort = true;   // "stop" also halts any screen-control loop
  if (ttsAbort) { try { ttsAbort.abort(); } catch (_) {} ttsAbort = null; }
  if (playProc) { try { playProc.kill(); } catch (_) {} playProc = null; }
  if (sayProc)  { try { sayProc.kill(); }  catch (_) {} sayProc = null; }
}

function speakSay(clean, gen, onDone) {
  const cfg = loadConfig();
  const voice = cfg.voice || 'Daniel';
  const rate  = cfg.voiceRate  != null ? cfg.voiceRate  : 178;
  const pitch = cfg.voicePitch != null ? cfg.voicePitch : 28;
  const pmod  = cfg.voicePmod  != null ? cfg.voicePmod  : 22;
  const tuned = '[[pbas ' + pitch + ']] [[pmod ' + pmod + ']] ' + clean;
  sayProc = execFile('say', ['-v', voice, '-r', String(rate), tuned], (err) => {
    if (gen !== speakGen) return;   // killed/superseded → do NOT respawn a fallback voice
    if (err) {                      // Daniel genuinely unavailable — one plain retry
      sayProc = execFile('say', ['-r', '190', clean], () => { if (gen === speakGen) { sayProc = null; onDone && onDone(); } });
    } else { sayProc = null; onDone && onDone(); }
  });
}

async function speakEleven(clean, cfg, gen, onDone, attempt) {
  attempt = attempt || 0;
  const voice = cfg.elevenVoice || DEFAULT_ELEVEN_VOICE;
  const model = cfg.elevenModel || DEFAULT_ELEVEN_MODEL;
  const ac = new AbortController(); ttsAbort = ac;
  // Retry transient failures (429 rate-limit / 5xx / network) before falling back to the
  // system voice, so a brief overload doesn't switch Sea to the macOS voice.
  const retryOrFallback = (retriable, why) => {
    ttsAbort = null;
    if (gen !== speakGen) return;
    if (retriable && attempt < 2) {
      setTimeout(() => { if (gen === speakGen) speakEleven(clean, cfg, gen, onDone, attempt + 1); }, 350 + attempt * 450);
      return;
    }
    try { console.warn('[TTS] ElevenLabs failed (' + why + '), using system voice.'); } catch (_) {}
    speakSay(clean, gen, onDone);
  };
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice + '?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': cfg.elevenKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text: clean, model_id: model,
        voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
      }),
      signal: ac.signal,
    });
    if (gen !== speakGen) { ttsAbort = null; return; }  // a newer utterance took over
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const retriable = res.status === 429 || res.status >= 500;   // don't retry 401/403 auth / quota
      retryOrFallback(retriable, 'HTTP ' + res.status + ' ' + t.slice(0, 120));
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (gen !== speakGen) { ttsAbort = null; return; }
    ttsAbort = null;
    const tmp = path.join(os.tmpdir(), 'nexus-tts-' + gen + '-' + Date.now() + '.mp3');
    fs.writeFileSync(tmp, buf);
    playProc = execFile('afplay', [tmp], () => { try { fs.unlinkSync(tmp); } catch (_) {} if (gen === speakGen) { playProc = null; onDone && onDone(); } });
  } catch (err) {
    if ((err && err.name === 'AbortError') || ac.aborted || gen !== speakGen) { ttsAbort = null; return; }
    retryOrFallback(true, (err && err.message) || 'network');       // network error → retry then fall back
  }
}

function speak(text, onDone) {
  stopSpeaking();                 // kills anything playing + bumps the generation
  const gen = speakGen;           // this utterance owns this generation
  const clean = (text || '').slice(0, 4000).replace(/\[\[/g, '').replace(/\]\]/g, '');
  if (!clean.trim()) { onDone && onDone(); return; }
  const cfg = loadConfig();
  if (cfg.elevenKey) speakEleven(clean, cfg, gen, onDone);
  else speakSay(clean, gen, onDone);
}
ipcMain.on('buddy:stopSpeaking', () => { stopSpeaking(); });

// Only the newest request may speak — an older, slower reply must not talk over it.
let askGen = 0;

// --- Voice settings IPC (ElevenLabs key/voice/model + live test) -------------
ipcMain.handle('voice:get', () => {
  const c = loadConfig();
  return { hasElevenKey: !!c.elevenKey, voice: c.elevenVoice || DEFAULT_ELEVEN_VOICE, model: c.elevenModel || DEFAULT_ELEVEN_MODEL };
});
ipcMain.handle('voice:setKey', (_e, key) => {
  const c = loadConfig(); const t = String(key || '').trim();
  if (t) c.elevenKey = t; else delete c.elevenKey;
  saveConfig(c); return { ok: true, hasElevenKey: !!c.elevenKey };
});
ipcMain.handle('voice:setVoice', (_e, id) => { const c = loadConfig(); const t = String(id || '').trim(); if (t) c.elevenVoice = t; saveConfig(c); return true; });
ipcMain.handle('voice:setModel', (_e, m) => { const c = loadConfig(); const t = String(m || '').trim(); if (t) c.elevenModel = t; saveConfig(c); return true; });
ipcMain.handle('voice:listVoices', async () => {
  const c = loadConfig(); if (!c.elevenKey) return { ok: false, error: 'No ElevenLabs key set.' };
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': c.elevenKey } });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const d = await res.json();
    const voices = (d.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
    return { ok: true, voices };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('voice:test', (e) => {
  const emit = (evt, p) => { try { e.sender.send('orch:' + evt, p); } catch (_) {} };
  emit('manager', { state: 'speaking' });
  speak('Good evening, sir. All systems are online, and your specialists are standing by.', () => emit('manager', { state: 'idle' }));
  return { ok: true };
});

// --- Speech-to-text: ElevenLabs "Scribe" (reliable cloud STT, same key) ------
ipcMain.handle('stt:transcribe', async (_e, b64, mime) => {
  const c = loadConfig();
  if (!c.elevenKey) return { ok: false, error: 'no-key' };
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length) return { ok: false, error: 'empty-audio' };
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm');
    form.append('model_id', 'scribe_v1');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': c.elevenKey }, body: form,
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); return { ok: false, error: 'HTTP ' + res.status + ' ' + t.slice(0, 140) }; }
    const d = await res.json();
    return { ok: true, text: (d && typeof d.text === 'string') ? d.text.trim() : '' };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- Vision: Sea looks at a captured image (screen/camera) and answers ------
ipcMain.handle('orch:askVision', async (event, payload) => {
  const emit = (evt, p) => { try { event.sender.send('orch:' + evt, p); } catch (_) {} };
  if (!client) { emit('error', { message: 'Add your Anthropic API key first.' }); return { ok: false }; }
  const myGen = ++askGen;
  const text = (payload && payload.text) || 'What do you see?';
  const img = (payload && payload.image) || '';
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(img);
  if (!m) { emit('error', { message: 'No image captured.' }); return { ok: false }; }
  emit('manager', { state: 'thinking' });
  try {
    const stream = client.messages.stream({
      model: directorModel(), max_tokens: 1024,
      system: 'You are Agent Sea, a calm, refined Jarvis-like assistant. Look at the image and answer the user in ONE or two short spoken sentences — no markdown, no lists, no URLs.',
      messages: priorMessages().concat([{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: String(text) },
      ] }]),
    });
    const msg = await stream.finalMessage();
    const finalText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    recordExchange('[looked at my screen] ' + String(text), finalText);
    if (myGen !== askGen) return { ok: true, text: finalText, superseded: true };  // newer request won
    emit('manager', { state: 'speaking' });
    if (finalText) emit('delta', { text: finalText });
    emit('answer', { text: finalText });
    speak(finalText, () => emit('manager', { state: 'idle' }));
    return { ok: true, text: finalText };
  } catch (err) {
    const mm = (err && err.message) || String(err);
    emit('error', { message: mm }); emit('manager', { state: 'idle' });
    return { ok: false, error: mm };
  }
});

// --- Run one specialist -----------------------------------------------------
async function runSubAgent(id, task, emit) {
  const a = SUBAGENTS[id];
  emit('agent', { agentId: id, state: a.searching ? 'searching' : 'working' });
  const messages = [{ role: 'user', content: String(task || '') }];
  let text = '';
  for (let i = 0; i < 8; i++) {
    const stream = client.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 4096, system: a.system,
      tools: (a.tools && a.tools.length) ? a.tools : undefined, messages,
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }  // server tool (web_search) → resume
    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason === 'tool_use' && toolUses.length) {   // client tools (e.g. Wire's `make`) → execute
      messages.push({ role: 'assistant', content: msg.content });
      const results = [];
      for (const tu of toolUses) {
        try {
          const ip = tu.input || {};
          if (tu.name === 'make') { results.push({ type: 'tool_result', tool_use_id: tu.id, content: await makeAction(ip) }); }
          else if (tu.name === 'find_files') { results.push({ type: 'tool_result', tool_use_id: tu.id, content: await findFiles(ip.query, ip.name_only, ip.kind, ip.limit) }); }
          else if (tu.name === 'read_file') { results.push({ type: 'tool_result', tool_use_id: tu.id, content: toolResultContent(await readFileSmart(ip.path)) }); }
          else results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Unknown tool.', is_error: true });
        } catch (e) {
          const msgTxt = (e && e.message) || String(e);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Failed: ' + msgTxt + (/not connected/i.test(msgTxt) ? ' — tell the user to connect Make with the 🔗 button.' : ''), is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
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
  const myGen = ++askGen;

  // Capture any keys typed in chat and save them to the vault (encrypted at rest).
  const scan = scanForSecrets(text);
  if (scan.found.length) {
    for (const f of scan.found) setSecret(f.name, f.value, 'captured from chat');
    emit('notice', { text: 'Saved ' + scan.found.length + ' key' + (scan.found.length > 1 ? 's' : '') + ' to memory (' + scan.found.map((f) => f.name).join(', ') + ').' });
    emit('memory', { reason: 'secret-captured' });
  }
  const userText = String(text || '');

  // "start over" / "new conversation" clears the running short-term memory.
  if (RESET_RE.test(userText)) {
    resetConversation();
    const line = 'Starting fresh — I have cleared our conversation.';
    emit('manager', { state: 'speaking' });
    emit('answer', { text: line });
    speak(line, () => emit('manager', { state: 'idle' }));
    return { ok: true, text: line };
  }

  emit('manager', { state: 'thinking' });
  // Include the prior conversation so Sea remembers what we've been talking about.
  const messages = priorMessages().concat([{ role: 'user', content: userText }]);
  const system = DIRECTOR_SYSTEM + buildMemoryBlock();
  let finalText = '';

  try {
    for (let turn = 0; turn < 8; turn++) {
      const stream = client.messages.stream({
        model: directorModel(), max_tokens: 1024, system: cachedSystem(system), tools: DIRECTOR_TOOLS, messages,
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
          } else if (tu.name === 'show') {
            const kind = inp.kind === 'info' ? 'info' : 'map';
            emit('display', {
              kind,
              query: String(inp.query || inp.title || '').slice(0, 200),
              title: String(inp.title || '').slice(0, 120),
              body: String(inp.body || '').slice(0, 1200),
              zoom: (typeof inp.zoom === 'number' && isFinite(inp.zoom)) ? Math.max(2, Math.min(18, inp.zoom)) : null,
            });
            results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Displayed on the holographic HUD.' };
          } else if (tu.name === 'smartlead') {
            emit('agent', { agentId: 'api', state: 'working' });
            jobs.push((async () => {
              try {
                const out = await smartleadAction(inp.action, inp.campaign_id, inp.leads, inp.query);
                emit('agent', { agentId: 'api', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: out };
              } catch (e) {
                const msg = (e && e.message) || String(e);
                emit('agent', { agentId: 'api', state: 'idle' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Smartlead failed: ' + msg + (/not connected/i.test(msg) ? ' — tell the user to click ⚡ to add their Smartlead API key.' : ''), is_error: true };
              }
            })());
          } else if (tu.name === 'take_control') {
            emit('manager', { state: 'thinking' });
            emit('notice', { text: 'Sea is taking control of the screen…' });
            jobs.push((async () => {
              try {
                const r = await computerUse(inp.goal, emit);
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: r || 'Done.' };
              } catch (e) {
                const msg = (e && e.message) || String(e);
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Could not control the screen: ' + msg + '. The app likely needs Accessibility permission — tell the user to enable Nexus in System Settings → Privacy & Security → Accessibility.', is_error: true };
              }
            })());
          } else if (tu.name === 'find_files') {
            emit('agent', { agentId: 'api', state: 'searching' });
            jobs.push((async () => {
              try {
                const out = await findFiles(inp.query, inp.name_only, inp.kind, inp.limit);
                emit('agent', { agentId: 'api', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: out };
              } catch (e) { emit('agent', { agentId: 'api', state: 'idle' }); results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'File search failed: ' + ((e && e.message) || e), is_error: true }; }
            })());
          } else if (tu.name === 'read_file') {
            emit('agent', { agentId: 'files', state: 'working' });
            jobs.push((async () => {
              try {
                const r = await readFileSmart(inp.path);
                emit('agent', { agentId: 'files', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: toolResultContent(r) };
              } catch (e) { emit('agent', { agentId: 'files', state: 'idle' }); results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Read failed: ' + ((e && e.message) || e), is_error: true }; }
            })());
          } else if (tu.name === 'control') {
            try {
              const r = macControl(inp.action, inp.target);
              emit('notice', { text: r });
              results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: r };
            } catch (e) { results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Could not open that: ' + ((e && e.message) || e), is_error: true }; }
          } else if (tu.name === 'slack_search') {
            emit('agent', { agentId: 'inbox', state: 'searching' });
            jobs.push((async () => {
              try {
                const r = await slackSearch(inp.query, inp.count);
                emit('agent', { agentId: 'inbox', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: r.length ? r.map((m, i) => (i + 1) + '. #' + m.channel + ' @' + m.from + ': ' + m.text).join('\n') : 'No matching Slack messages.' };
              } catch (e) { emit('agent', { agentId: 'inbox', state: 'idle' }); results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Slack search failed: ' + ((e && e.message) || e), is_error: true }; }
            })());
          } else if (tu.name === 'slack_send') {
            emit('agent', { agentId: 'inbox', state: 'working' });
            jobs.push((async () => {
              try {
                const ts = await slackSend(inp.channel, inp.text);
                emit('notice', { text: 'Slack message sent to ' + inp.channel });
                emit('agent', { agentId: 'inbox', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Slack message sent to ' + inp.channel + ' (' + ts + ').' };
              } catch (e) { const msg = (e && e.message) || String(e); emit('agent', { agentId: 'inbox', state: 'idle' }); results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Could not send Slack: ' + msg + (/not connected/i.test(msg) ? ' — tell the user to click the 💬 button to connect Slack.' : ''), is_error: true }; }
            })());
          } else if (tu.name === 'gmail_search') {
            emit('agent', { agentId: 'inbox', state: 'searching' });
            jobs.push((async () => {
              try {
                const found = await gmailSearch(inp.query, inp.max);
                emit('agent', { agentId: 'inbox', state: 'done' });
                const txt = found.length
                  ? found.map((m, i) => (i + 1) + '. id=' + m.id + ' | From: ' + m.from + ' | To: ' + m.to + ' | Subject: ' + m.subject + ' | ' + m.date + '\n   ' + m.snippet).join('\n')
                  : 'No matching emails found.';
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: txt };
              } catch (e) {
                emit('agent', { agentId: 'inbox', state: 'idle' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Search failed: ' + ((e && e.message) || e), is_error: true };
              }
            })());
          } else if (tu.name === 'gmail_read') {
            emit('agent', { agentId: 'inbox', state: 'working' });
            jobs.push((async () => {
              try {
                const m = await gmailRead(inp.id);
                emit('agent', { agentId: 'inbox', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'From: ' + m.from + '\nTo: ' + m.to + '\nDate: ' + m.date + '\nSubject: ' + m.subject + '\n\n' + m.body };
              } catch (e) {
                emit('agent', { agentId: 'inbox', state: 'idle' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Read failed: ' + ((e && e.message) || e), is_error: true };
              }
            })());
          } else if (tu.name === 'send_email') {
            emit('agent', { agentId: 'inbox', state: 'working' });
            jobs.push((async () => {
              try {
                const id = await sendGmail(inp.to, inp.subject, inp.body);
                emit('notice', { text: 'Email sent to ' + inp.to });
                emit('agent', { agentId: 'inbox', state: 'done' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Email sent to ' + inp.to + ' (' + id + ').' };
              } catch (e) {
                const msg = (e && e.message) || String(e);
                emit('agent', { agentId: 'inbox', state: 'idle' });
                results[idx] = { type: 'tool_result', tool_use_id: tu.id, content: 'Could not send: ' + msg + (/not connected/i.test(msg) ? ' — tell the user to click the 📧 button to connect Gmail.' : ''), is_error: true };
              }
            })());
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

    recordExchange(userText, finalText);   // remember this turn for next time
    if (myGen !== askGen) return { ok: true, text: finalText, superseded: true };  // a newer request took over — stay silent
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
