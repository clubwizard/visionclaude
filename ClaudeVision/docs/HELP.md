# VisionClaude — Help Guide

The complete user-facing reference. If you only have 5 minutes, jump to [Quick start](#quick-start). If you're stuck, [Troubleshooting](#troubleshooting) covers the realistic failures. New to all the jargon? [Glossary](#glossary).

---

## Table of contents

1. [What VisionClaude is](#what-visionclaude-is)
2. [Three ways to use it](#three-ways-to-use-it)
3. [Quick start](#quick-start) — the 5-minute happy path
4. [Setup paths](#setup-paths) — full walkthroughs per mode
5. [Using VisionClaude](#using-visionclaude) — what to actually say
6. [Settings reference](#settings-reference) — iOS app + dashboard + env vars
7. [The MCP tool surface](#the-mcp-tool-surface) — what Claude can do on your behalf
8. [Updating & uninstalling](#updating--uninstalling)
9. [Troubleshooting](#troubleshooting)
10. [FAQ](#faq)
11. [Glossary](#glossary)

---

## What VisionClaude is

VisionClaude turns an iPhone (or Meta Ray-Ban Smart Glasses) into Claude's eyes and ears. You speak, the phone hears you, the camera sees what you see, Claude processes it, and you hear the answer through ElevenLabs voice — usually in under a second.

There are **two server-side modes** and **two ways to wire Claude in**, so four valid combinations. You'll only ever use one at a time.

| Mode | Where Claude lives | When to use |
|---|---|---|
| **Channel + Claude Desktop / Cowork** | On your Mac, running as Anthropic's desktop agent | You have a Claude Pro/Max subscription and want Claude to use your existing MCP tools, browser, computer use, and files |
| **Channel + Claude Code** | On your Mac, running as the CLI | You're a developer using Claude Code in a project and want phone-eyes wired into that exact session |
| **Gateway (standalone)** | On any host (Mac, Linux, cloud VM) | You want VisionClaude to run independently — multi-user accounts, hosted on a server, no desktop app needed |

If you don't know which to pick, start with **Channel + Claude Desktop / Cowork**. It's the path most users want.

---

## Three ways to use it

### 1. Channel + Claude Desktop / Cowork (recommended)

The Mac runs Claude Desktop. Cowork is its agent mode. You add VisionClaude as an MCP server in Claude Desktop's config; on next launch, Cowork gains four new tools (`reply`, `edit_message`, `get_camera_snapshot`, `request_voice_input`). Your iPhone or Ray-Bans become sensors Cowork can use mid-task.

You can also pair the phone with Cowork via **Dispatch** (Anthropic's QR-code feature) so you can drive the desktop agent from your phone — VisionClaude provides the eyes/ears whether you're sitting at the Mac or remote.

**Best for:** anyone with Claude Pro/Max who wants the most capable agent. Cowork has computer use, web browser access, and your full plugin/MCP/skills library.

→ [Full setup guide](CLAUDE_DESKTOP_SETUP.md)

### 2. Channel + Claude Code (developer mode)

You're working in a codebase with Claude Code (the CLI). Add VisionClaude as an MCP server in your project's `.mcp.json`. When you start a session with `claude --dangerously-load-development-channels "server:visionclaude"`, the phone's camera and voice are wired into THAT session. Your phone can look at your laptop screen and Claude Code can see what you see.

**Best for:** "look at this stack trace and tell me what's wrong" workflows, code reviews while away from the keyboard, building VisionClaude itself.

→ See the [Channel section in the main README](../../README.md#step-2-start-the-channel)

### 3. Gateway (standalone)

A multi-user web service (Node + Express + SQLite) that talks directly to the Anthropic API. Has its own user accounts, password reset flow, encrypted per-user API keys, and runs in Docker behind Nginx. No desktop app required — install it on a server, point your phone at it, anyone with an invite can use it.

**Best for:** sharing VisionClaude with a small team, running it on a home server, or any deployment where the desktop-app model doesn't fit.

→ See the [Gateway Mode section in the main README](../../README.md#gateway-mode-alternative)

---

## Quick start

The happy path for **Channel + Claude Desktop**. Other modes have their own walkthroughs linked above.

**Before you begin you need:** a Mac running macOS 14+, a Claude Pro or Max subscription, an iPhone running iOS 17+, and 10 minutes.

1. **Install prerequisites.**
   ```bash
   # Bun (a runtime VisionClaude's channel server uses)
   curl -fsSL https://bun.sh/install | bash
   # Claude Desktop
   open https://claude.ai/download
   ```
2. **Clone VisionClaude.**
   ```bash
   git clone https://github.com/clubwizard/visionclaude.git ~/visionclaude
   ```
3. **Run the setup script.** It generates `~/Library/Application Support/Claude/claude_desktop_config.json` entries, installs deps, and verifies the channel boots cleanly.
   ```bash
   cd ~/visionclaude/ClaudeVision
   ./setup.sh
   ```
4. **Restart Claude Desktop** (fully quit with ⌘Q, reopen).
5. **Build & install the iOS app.** Open `~/visionclaude/ClaudeVision/ios/ClaudeVision.xcodeproj` in Xcode, plug in your iPhone, hit ⌘R. (Simulator doesn't work — no camera.)
6. **Pair the phone.** The Mac dashboard at `http://localhost:18790` shows your LAN IP, port, and channel token. In the iOS app → Settings, enter all three, tap **Connect**.
7. **Talk to it.** Point your phone at something and say *"Claude, what am I looking at?"* You should hear an answer through ElevenLabs (or the phone's built-in TTS if you haven't set up ElevenLabs yet).

If anything in those steps fails, jump to [Troubleshooting](#troubleshooting).

---

## Setup paths

| Path | Walkthrough |
|---|---|
| Channel + Claude Desktop | [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md) |
| Channel + Claude Code | [README — Step 2](../../README.md#step-2-start-the-channel) |
| Gateway, local Mac | [README — Gateway Mode](../../README.md#gateway-mode-alternative) |
| Gateway, Docker on a server | [README — Docker](../../README.md#docker-deploy) and `docker-compose.yml` at the repo root |
| iOS app development build | [ClaudeVision/ios/README.md](../ios/README.md) |
| Ray-Ban Smart Glasses pairing | See the Ray-Ban section in the iOS app's Settings |

---

## Using VisionClaude

A few example flows so you have a sense of what's possible:

### "What am I looking at?"
Point camera at almost anything. Useful for label reading, identifying objects, reading signs in a foreign language, recognizing landmarks.

### "Read this aloud."
Point at a page, document, or screen. Claude transcribes the text and reads it back. Pairs nicely with Ray-Bans for visually-impaired use cases.

### "Add this to my expenses spreadsheet."
Point at a receipt. If Cowork (or Claude Code) has a sheet/numbers MCP, it'll extract the line items and add them. Requires the appropriate MCP server configured.

### "Book the train Thursday at 2pm to Edinburgh."
Multi-step task. Claude searches train times via web, finds available tickets, may call `request_voice_input` to ask which card to use, completes the booking. Requires browser / payment MCP servers.

### "Send this picture to Sarah."
Point at something, tell Claude who to send it to. Works with iMessage MCP (Mac-only via AppleScript bridge) or any messaging MCP server you have configured.

### "Describe this in detail."
The default response is one short sentence (voice-friendly). When you explicitly ask for detail, Claude gives a full description.

### "Watch this for changes."
Long-running: keeps the camera open and notifies you when something changes. Useful as an unattended alarm or to watch a download progress bar from another room.

---

## Settings reference

### iOS app — Settings screen

Open the VisionClaude iOS app and tap the gear icon.

**Connection**
| Field | What it does |
|---|---|
| **Host** | Mac's LAN IP (e.g. `192.168.1.42`) or `localhost` if running on-device |
| **Port** | `18790` by default |
| **Channel Token** | Auth secret from `~/.claude/channels/visionclaude/.channel-token` or the dashboard at `http://localhost:18790` |

**Modes**
| Mode | What it injects into the system prompt |
|---|---|
| **General** (default) | Voice-first vision assistant — short answers, no markdown |
| **Read aloud** | Optimized for OCR + reading flow |
| **Describe in detail** | Bypasses brevity rules, gives full descriptions |
| **Cooking / Tour guide / etc.** | Custom modes the user can configure |

**Camera Source**
- iPhone rear or front camera
- Meta Ray-Ban Smart Glasses (pair via Meta View app first; VisionClaude uses the `meta-wearables-dat-ios` SPM dependency)
- Frame interval (0.5s–5s) — how often to capture a still frame in continuous mode
- JPEG quality (0.1–1.0) — tradeoff between size and detail

**Voice**
- Pause threshold — how long of silence to treat as end-of-utterance
- ElevenLabs voice ID — paste from your ElevenLabs voice library; defaults to "Charlotte"

### Channel server dashboard

`http://localhost:18790` (when the server is running). Shows:
- Mac's LAN IPs (so you know what to put in the iOS app)
- Channel token (with copy button)
- Recent activity log
- ElevenLabs key configuration form (saves to `~/.claude/channels/visionclaude/.env` live, no restart)
- "Send to phone" — manually push a message for testing

### Environment variables

**Channel server** (`~/.claude/channels/visionclaude/.env`):
| Variable | Purpose |
|---|---|
| `VISIONCLAUDE_PORT` | Override the default 18790 |
| `VISIONCLAUDE_TOKEN` | Override the auto-generated channel token |
| `ELEVENLABS_API_KEY` | Enable ElevenLabs TTS (set via the dashboard) |
| `ELEVENLABS_VOICE_ID` | Voice to use (defaults to Charlotte) |

**Gateway server** (`ClaudeVision/server/.env`):
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required — Claude API access for the admin's fallback |
| `KEYS_ENCRYPTION_KEY` | AES-256 master key for encrypting per-user API keys |
| `SESSION_SECRET` | Web session signing key |
| `CLAUDE_MODEL` | Pin a specific model (auto-falls-back on deprecation regardless) |
| `POSTMARK_API_KEY` + `POSTMARK_FROM_EMAIL` | Enable email-based password reset |
| `PUBLIC_BASE_URL` | The URL emailed in password-reset links |
| `GATEWAY_API_KEY` | If set, locks down /chat to clients sending `X-Gateway-Key` header |
| `CORS_ORIGINS` | Comma-separated list of allowed cross-origin domains |

See `ClaudeVision/server/.env.example` for the canonical list with comments.

---

## The MCP tool surface

The Channel server exposes these MCP tools to whatever Claude is connected (Code or Desktop/Cowork):

| Tool | What it does | Direction |
|---|---|---|
| `reply` | Send text + optional TTS audio + optional file attachment back to the iOS app | Claude → phone |
| `edit_message` | Edit a previously-sent reply | Claude → phone |
| `get_camera_snapshot` | Pull a fresh still frame from the phone's active camera (iPhone or Ray-Ban). Returns an image content block | Claude → phone, with response |
| `request_voice_input` | Speak a one-line clarifying question via TTS, wait for the user's spoken reply, return the transcription | Claude → phone, with response |

The first two are **push-style** (Claude initiates). The last two are **pull-style** — Claude asks the phone for something mid-task and waits for the answer inline. Default timeouts: 15s for snapshot, 30s for voice. Tool calls return `isError: true` if the phone doesn't fulfil in time.

---

## Updating & uninstalling

### Update

```bash
cd ~/visionclaude
git pull
cd ClaudeVision/channel && bun install
```

If you're running **Channel + Claude Desktop**: fully quit Claude Desktop (⌘Q) and reopen — it'll respawn the channel server with the new code on startup.

If you're running **Gateway**: rebuild and restart:
```bash
cd ClaudeVision/server
npm install && npm run build && npm restart
```

For Docker deployments, `./deploy.sh` from the repo root does `git pull && docker compose up --build -d`.

### Uninstall

1. **Remove from Claude Desktop's MCP config.** Delete the `visionclaude` block from `~/Library/Application Support/Claude/claude_desktop_config.json`. Restart Claude Desktop.
2. **Delete state.**
   ```bash
   rm -rf ~/.claude/channels/visionclaude
   ```
3. **(Optional) Remove the iOS app** like any other.
4. **(Optional) Remove the repo:**
   ```bash
   rm -rf ~/visionclaude
   ```

If you ran Gateway Mode in Docker, `docker compose down -v` from the repo root removes the volume too (this wipes user accounts — irreversible).

---

## Troubleshooting

### Phone shows "Connecting..." forever

- **Wrong host or port.** Double-check what the dashboard at `http://localhost:18790` says.
- **Different Wi-Fi networks.** Mac on wired, phone on guest network. Put both on the same SSID.
- **AP isolation.** Some routers prevent clients from talking to each other. Switch to a network without isolation, or run the iPhone on a hotspot the Mac also joins.
- **Channel server not running.** If you're in Cowork mode, Claude Desktop launches it for you — restart Claude Desktop. If you're running it standalone, `cd ClaudeVision/channel && bun server.ts`.

### Phone connects but Cowork doesn't see the tools

- **Restart Claude Desktop fully.** ⌘Q, then reopen. Closing the window isn't enough.
- **Check the MCP logs.** macOS: `~/Library/Logs/Claude/mcp.log`. Look for `[visionclaude]` lines. If startup failed, the stack trace is there.
- **Check the `bun` path** in `claude_desktop_config.json`. If Claude Desktop's PATH doesn't include `~/.bun/bin`, use the absolute path: `/Users/you/.bun/bin/bun`.

### Tool calls time out

- **Phone screen locked + app backgrounded** — iOS suspends the websocket after a few minutes. Re-foreground the app.
- **Camera permission denied** — Settings → VisionClaude → Camera → Allow.
- **Different Wi-Fi networks** — see above.

### No voice / TTS sounds robotic

- ElevenLabs key not configured. Open `http://localhost:18790`, paste your ElevenLabs API key into the form, hit Save. Works immediately.
- Without ElevenLabs, the iOS app falls back to Apple's built-in TTS, which works but sounds noticeably worse.

### Gateway: "SESSION_SECRET is not set"

The server refuses to start without it. Generate one and add to `.env`:
```bash
openssl rand -hex 32
# Paste output into SESSION_SECRET=... in ClaudeVision/server/.env
```

### Gateway: "KEYS_ENCRYPTION_KEY is not set"

The server starts but storing any API key throws. Generate one and add to `.env`:
```bash
openssl rand -hex 32
```
**Do not rotate this key without re-encrypting the DB** — losing it makes all stored user API keys unreadable.

### Gateway: locked out of admin account

Two recovery paths:
1. **Email reset** — click "Forgot your password?" on the login page (requires Postmark configured).
2. **CLI reset** —
   ```bash
   docker exec -it <container> npm run reset-password -- list
   docker exec -it <container> npm run reset-password -- you@example.com newpassword
   ```
   This also invalidates active sessions on other devices.

### "[Model] CLAUDE_MODEL=... is not the latest in its family."

Just a hint. The configured model still works; Anthropic just shipped a newer one. Update `CLAUDE_MODEL` in `.env` to the suggested value, or ignore and trust the auto-fallback to kick in when Anthropic eventually retires your pinned model.

### "no iOS clients connected — cannot capture snapshot"

Cowork called `get_camera_snapshot` but the iOS app isn't connected to the channel right now. Re-tap **Connect** in the iOS app, check the dashboard shows >0 clients.

### Ray-Ban glasses won't pair

- Pair via the Meta View app first. VisionClaude can't pair them — it consumes the already-paired Bluetooth connection.
- Bluetooth permission must be granted to the VisionClaude iOS app.
- Glasses must be on, not in their case.

---

## FAQ

**Do I need both Claude Desktop AND Claude Code installed?**
No. Pick one. Each works fine alone with VisionClaude. You can install both if you want — they don't conflict.

**Does VisionClaude work without an internet connection?**
The transcription (Apple's SFSpeechRecognizer) and TTS (Apple's local voices) work offline. The actual Claude calls don't — they go through Anthropic's API. ElevenLabs also requires internet.

**Is voice recorded continuously? Where does it go?**
Voice is processed locally on the iPhone via SFSpeechRecognizer. Only the resulting text transcript is sent over the channel. Audio is never uploaded.

**What about camera frames? Stored where?**
Pushed frames land in `~/.claude/channels/visionclaude/inbox/` on the Mac. They're not automatically cleaned up — if you care about disk hygiene, delete the dir periodically. Frames sent via the `get_camera_snapshot` pull tool are also written there (and returned inline to the agent as base64).

**Can I run the channel server on a different machine than Claude Desktop?**
Yes, but it's fiddly — Claude Desktop expects an stdio MCP server, not an HTTP one. To run remotely you'd need to wrap it with [supergateway](https://github.com/supercorp-ai/supergateway). Easier to run them on the same Mac.

**Can multiple iPhones connect at once?**
Yes — the channel server broadcasts replies to all connected clients. Pull-pattern tools (`get_camera_snapshot`, `request_voice_input`) currently take the response from whichever client fulfils first.

**How do I expose VisionClaude to the public internet?**
Don't, unless you really know what you're doing. The channel token gives full access to the phone's camera and voice. For a public-internet deployment, use **Gateway Mode** with the proper auth (gateway API key + user accounts + Nginx + Let's Encrypt). See `docker-compose.yml`.

**What models does VisionClaude use?**
Channel mode delegates to whatever model Claude Desktop or Claude Code is running. Gateway mode defaults to Claude Sonnet 4.6 but is configurable via `CLAUDE_MODEL=` in `.env`. On model deprecation, the Gateway auto-falls-back to the latest in the same family (sonnet/opus/haiku) with a one-time retry.

**Why do I need Bun?**
The channel server uses Bun-specific APIs (`Bun.serve`, `Bun.spawn`) for its HTTP+WebSocket layer. Bun is faster than Node for this workload and ships TypeScript directly without a build step.

---

## Glossary

| Term | What it is |
|---|---|
| **VisionClaude** | This project — iOS app + Mac server that gives Claude eyes/ears |
| **Channel Mode** | The Bun MCP server in `ClaudeVision/channel/`. Talks to Claude Code OR Claude Desktop/Cowork |
| **Gateway Mode** | The Node multi-user web service in `ClaudeVision/server/`. Talks to the Anthropic API directly |
| **Claude Desktop** | Anthropic's macOS/Windows desktop app for talking to Claude |
| **Cowork** | Claude Desktop's agent mode. Can use MCP servers, browser, local files, computer use |
| **Dispatch** | Anthropic's feature for QR-pairing your phone to a desktop Cowork session so you can drive it from anywhere |
| **Claude Code** | Anthropic's CLI for coding with Claude. Different surface from Claude Desktop, also speaks MCP |
| **MCP** | Model Context Protocol — the standard for connecting Claude to tools and data sources |
| **MCP server** | A program (local stdio or remote HTTP) that exposes tools to a Claude client |
| **MCP client** | A Claude application (Desktop, Code, Cowork, the Gateway, etc.) that consumes MCP server tools |
| **Channel token** | The shared secret between channel server and iOS app. Lives in `~/.claude/channels/visionclaude/.channel-token` |
| **Gateway API key** | Optional shared secret for the Gateway's machine-to-machine `/chat` endpoint |
| **ElevenLabs** | Third-party text-to-speech provider for natural-sounding voice replies |
| **SFSpeechRecognizer** | Apple's on-device speech-to-text framework. Used for transcribing user voice |
| **Skill** | A `SKILL.md` directory with YAML frontmatter that adds instructions to the system prompt for specific tasks. Loaded by both modes |
| **`.mcp.json`** | Claude Code's project-level MCP server config |
| **`claude_desktop_config.json`** | Claude Desktop's global MCP server config |

---

## Where to ask for help

- **Bug reports / feature requests** — [github.com/clubwizard/visionclaude/issues](https://github.com/clubwizard/visionclaude/issues)
- **Channel server / MCP plumbing** — `ClaudeVision/channel/server.ts` is one file; reading it top to bottom takes ten minutes
- **Gateway server / multi-user features** — `ClaudeVision/server/CLAUDE.md` has architectural notes
- **iOS app** — `ClaudeVision/ios/README.md` covers build steps and known device-specific quirks
- **Architecture deep dive** — `ARCHITECTURE.md` at the repo root
