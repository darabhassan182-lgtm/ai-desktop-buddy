# Scout — your first desktop AI character

A small Mac app: a character named **Scout** that you talk to (by typing or voice),
who searches the web and answers **out loud**. This is milestone 1 of a bigger
"team of AI characters on your desktop" project.

## One-time setup

1. **Get an API key** at https://console.anthropic.com/settings/keys (starts with `sk-ant-`).
2. In this folder, make your key file:
   ```sh
   cp .env.example .env
   ```
   Then open `.env` and paste your key after `ANTHROPIC_API_KEY=`.
3. Install the app's building blocks (run once):
   ```sh
   npm install
   npm install @anthropic-ai/sdk dotenv
   npm install --save-dev electron
   ```

## Run it

```sh
npm start
```

Type a question and press **Ask**, or click 🎤 and speak. Scout searches the web
when needed and reads the answer aloud.

## What's under the hood

**Nexus** is a hub: a home screen with a grid of AI "team members" (sub-agents).
Scout (Research) is live; the others are placeholders for now. Each opens its own
chat. The window scales to full screen.

| Piece | File | Role |
|------|------|------|
| App window + agents + AI brain + speech | `main.js` | Defines the agents, calls Claude (web-search tool), speaks answers with macOS `say` |
| Secure bridge | `preload.js` | Lets the UI talk to the brain safely |
| The hub + chat UI | `index.html`, `styles.css`, `renderer.js` | The agent menu, chat, and mic button |
| Offline voice | `voice.js` | Records the mic and transcribes it on-device with Whisper |

### Voice input (offline Whisper)

Click 🎤 to start recording, click again to stop. The first time, it downloads a
small (~40 MB) Whisper model from a public CDN, then caches it — after that it
works offline and your audio never leaves the Mac. Needs internet **once** for
that first download. If macOS blocks the mic, allow it in
**System Settings → Privacy & Security → Microphone**.

## Notes / troubleshooting

- **No sound?** macOS `say` must be enabled; test in Terminal with `say hello`.
- **Voice input does nothing?** Browser speech recognition can be blocked in some
  Electron builds. Typing always works; a more robust voice-input option is the
  next upgrade.
- **"something went wrong"** in the bubble usually means the API key is missing or
  wrong in `.env`.

## Building the .dmg (a real installable app)

```sh
npm install --save-dev electron-builder   # one time
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

The `.dmg` lands in `dist/` (e.g. `dist/Scout-0.1.0-arm64.dmg`). Double-click it,
drag **Scout** to Applications, and launch it. On first launch it asks for your
Anthropic API key and stores it privately on that Mac (in the app's data folder,
never inside the `.dmg`) — so the `.dmg` is safe to share. Change the key anytime
via the ⚙️ button.

### Important notes about the .dmg

- **"Scout can't be opened / unidentified developer"** — the app is *unsigned*.
  Right-click the app → **Open** → **Open** (only needed the first time). This is
  normal for personal builds.
- **Apple Silicon only** — this `.dmg` is `arm64` (M1/M2/M3/M4). To also build for
  older Intel Macs, run `electron-builder --mac dmg --x64` (or `--universal`).
- **Sharing widely without the warning** requires an Apple Developer account
  ($99/yr) and *notarization* — a later step if you ever distribute publicly.
- **No custom icon yet** — it uses the default Electron icon. Add a 512×512 (or
  1024×1024) `icon.png`/`icon.icns` and point `build.mac.icon` at it to brand it.

## Next characters to add

- 📝 A Document character (edit files, make .docx/.xlsx) — graduates to the Claude **Agent SDK**.
- 💬 A Slack/Email character (via MCP servers).
- 🔌 An API character (custom tools that call your services).
