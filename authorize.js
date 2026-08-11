// One-time Gmail authorization for Nexus (run once): opens the Google consent
// screen, then saves an OAuth refresh token straight into the Nexus app config
// so Sea can send email. Uses the loopback flow (Desktop app credentials).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { google } = require('googleapis');

const CREDS_FILE = fs.readdirSync(__dirname).find((f) => /^client_secret_.*\.apps\.googleusercontent\.com\.json$/.test(f));
if (!CREDS_FILE) { console.error('NO_CREDS: client_secret_*.json not found in project root'); process.exit(1); }

const PORT = 42813;
const REDIRECT = 'http://localhost:' + PORT;
const SCOPES = ['https://mail.google.com/', 'https://www.googleapis.com/auth/userinfo.email'];
const APP_CONFIG = path.join(os.homedir(), 'Library', 'Application Support', 'ai-desktop-buddy', 'config.json');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, CREDS_FILE), 'utf8'));
const creds = raw.installed || raw.web;
const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT);
const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  if (req.url.indexOf('/?') !== 0 && req.url.indexOf('/favicon') === 0) { res.end(''); return; }
  try {
    const code = new URL(req.url, REDIRECT).searchParams.get('code');
    if (!code) { res.end('Waiting for Google…'); return; }
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    let email = '';
    try { const ui = await google.oauth2('v2').userinfo.get({ auth: oauth2 }); email = ui.data.email || ''; } catch (_) {}
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(APP_CONFIG, 'utf8')); } catch (_) {}
    if (email) cfg.gmailUser = email;
    cfg.gmailOAuth = { user: email || cfg.gmailUser || '', clientId: creds.client_id, clientSecret: creds.client_secret, refreshToken: tokens.refresh_token || (cfg.gmailOAuth && cfg.gmailOAuth.refreshToken) || '' };
    fs.mkdirSync(path.dirname(APP_CONFIG), { recursive: true });
    fs.writeFileSync(APP_CONFIG, JSON.stringify(cfg, null, 2));
    res.setHeader('Content-Type', 'text/html');
    res.end('<body style="font:600 20px system-ui;background:#0b0e17;color:#eaf4ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>✅ Gmail connected' + (email ? ' for ' + email : '') + '.<br><br>You can close this tab and go back to Nexus.</div></body>');
    console.log('OAUTH_SAVED email=' + email + ' refresh_token=' + (tokens.refresh_token ? 'yes' : 'MISSING'));
    setTimeout(() => { try { server.close(); } catch (_) {} process.exit(tokens.refresh_token ? 0 : 2); }, 800);
  } catch (e) {
    res.end('Error: ' + (e && e.message));
    console.error('OAUTH_ERROR', (e && e.message) || e);
    setTimeout(() => process.exit(1), 300);
  }
});
server.listen(PORT, () => {
  console.log('AUTH_URL ' + authUrl);
  console.log('Opening the Google consent screen in your browser…');
  execFile('open', [authUrl], () => {});
});
