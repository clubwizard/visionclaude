# Connecting VisionClaude to Claude Desktop / Cowork

This guide walks through wiring **VisionClaude's Channel server** into **Claude Desktop's Cowork** mode so Anthropic's desktop agent gains wearable eyes and ears — your iPhone (or Meta Ray-Ban Smart Glasses) become a sensor layer Cowork can call mid-task.

> If you don't know what Cowork is: it's the agent mode of Claude Desktop that runs on your Mac/PC with access to local files, MCP servers, your browser, and computer use. **Dispatch** is the companion feature that lets you scan a QR code to drive that desktop agent from your phone. Both shipped in March 2026 and require a Pro ($20/mo) or Max subscription.

If you're connecting to **Claude Code** instead, skip this file and follow the `.mcp.json` instructions in the main README.

---

## What you get

After this setup, Cowork has four new tools:

| Tool | What it does | Use case |
|---|---|---|
| `reply` | Send a text reply (with optional TTS audio) to the phone | Speak the answer aloud through the user's glasses |
| `edit_message` | Edit a previously-sent reply | Correct a misspeak |
| `get_camera_snapshot` | Pull a fresh photo from the phone's active camera | "Look at this screen" mid-task |
| `request_voice_input` | Ask the user a one-line clarifying question, get back the transcribed reply | Disambiguate without breaking the task loop |

The first two are **push** (phone speaks first, Claude replies). The last two are **pull** (Cowork asks the phone for sensor input during a task) — this is what makes VisionClaude a proper Cowork connector rather than just a chat bridge.

---

## Prerequisites

- **Mac** running macOS 14+ (Windows works for the server side, but `iMessage` and other Mac-only tools obviously don't)
- **Claude Desktop** installed (download from [claude.ai/download](https://claude.ai/download))
- **Pro or Max subscription** on Anthropic — Cowork is not on Free
- **Bun** installed: `curl -fsSL https://bun.sh/install | bash`
- **VisionClaude repo** cloned somewhere on disk

---

## Step 1 — Run the channel server (once, to verify)

Make sure the server starts cleanly outside of Claude Desktop first. This way if anything's wrong, you'll see it immediately in your terminal rather than buried in Claude Desktop's MCP logs.

```bash
cd /path/to/visionclaude/ClaudeVision/channel
bun install
bun server.ts
```

You should see something like:

```
[visionclaude] 🚀 VisionClaude channel running on http://0.0.0.0:18790
[visionclaude]    WebSocket: ws://localhost:18790/ws
[visionclaude]    🔐 Channel Token: e7a2f1c9d3b0...     ← save this
[visionclaude]    Dashboard:  http://localhost:18790
```

The dashboard at `http://localhost:18790` shows your Mac's LAN IP, the channel token (with copy button), recent activity, and an ElevenLabs TTS config form.

The token is generated on first run and persisted to `~/.claude/channels/visionclaude/.channel-token` (mode `0600`). You'll need it for the iPhone.

`Ctrl-C` to stop the server once you've verified it boots.

---

## Step 2 — Wire VisionClaude into Claude Desktop

Edit Claude Desktop's MCP config file:

**macOS:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

Add an `mcpServers` entry (merge with anything that's already there — do NOT replace the whole file if you have other servers):

```json
{
  "mcpServers": {
    "visionclaude": {
      "command": "bun",
      "args": [
        "run",
        "/Users/you/path/to/visionclaude/ClaudeVision/channel/server.ts"
      ]
    }
  }
}
```

**Use the absolute path** to `server.ts` — Claude Desktop runs its own working directory and won't resolve relatives. You can `cd` to the channel dir and run `pwd` to get the right path.

### Verify the path before saving

```bash
# Should print the full path; if it doesn't, the file isn't where you think.
ls -la /Users/you/path/to/visionclaude/ClaudeVision/channel/server.ts
```

### If `bun` isn't on Claude Desktop's PATH

Claude Desktop inherits the PATH it was launched with (usually a minimal one). If `bun` isn't found, use the absolute path instead:

```json
{
  "mcpServers": {
    "visionclaude": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["run", "/Users/you/path/to/visionclaude/ClaudeVision/channel/server.ts"]
    }
  }
}
```

Run `which bun` to find your bun binary.

---

## Step 3 — Restart Claude Desktop

Fully quit (⌘Q on macOS — closing the window isn't enough; Claude Desktop keeps a background process). Reopen.

Claude Desktop only loads MCP servers on startup, so this restart is mandatory after every change to `claude_desktop_config.json`.

---

## Step 4 — Verify the tools are loaded

Open Claude Desktop, start a Cowork conversation, and ask:

> *"List the MCP tools you have."*

In the response you should see `visionclaude:reply`, `visionclaude:edit_message`, `visionclaude:get_camera_snapshot`, `visionclaude:request_voice_input` (alongside any other servers you already had).

If you don't see them:

1. **Check Claude Desktop's MCP logs.** macOS: `~/Library/Logs/Claude/mcp.log`. Look for `[visionclaude]` lines. If startup failed, you'll see the stack trace there.
2. **Check the path** to `server.ts` in `claude_desktop_config.json` is absolute and correct.
3. **Check `bun` is reachable** from Claude Desktop's PATH (see "If `bun` isn't on Claude Desktop's PATH" above).
4. **Check the channel server can start standalone** — go back to Step 1.

---

## Step 5 — Pair your iPhone

Once Cowork has the tools loaded, it'll spawn the channel server automatically. The server is now listening for the phone.

1. **Install the VisionClaude iOS app** — build from `ClaudeVision/ios/` in Xcode (`xcodegen generate`, then ⌘R) and install on a physical iPhone running iOS 17+. Simulator won't work (no camera, no Bluetooth).
2. **Find your Mac's IP** — open Claude Desktop, ask Cowork *"What's my Mac's local IP?"* (it can use computer use to look it up), OR open `http://localhost:18790` in Safari on the Mac and read the IP off the dashboard.
3. **Find your channel token** — either from the dashboard (same page) or by running:
   ```bash
   cat ~/.claude/channels/visionclaude/.channel-token
   ```
4. **In the iOS app → Settings**, set:
   | Field | Value |
   |---|---|
   | Host | Your Mac's LAN IP (e.g. `192.168.1.42`) |
   | Port | `18790` |
   | Channel Token | Paste from above |
5. **Tap Connect.** Green indicator = wired up.

Both your Mac and iPhone must be on the same Wi-Fi network. If you're on a corporate or guest network with AP isolation, this won't work — you'll need to either join a different network or run the iPhone on a hotspot the Mac also joins.

---

## Step 6 — Use it

Two interaction patterns from here:

### Phone-initiated

You wear the glasses or hold the phone, speak a request, and Cowork picks it up.

> *"Claude, what's on this label?"*

The phone sends voice + a fresh camera frame; Cowork reads the label and speaks the answer back through the iOS app's TTS.

### Cowork-initiated (the new bit)

You start a multi-step task in Cowork via the Desktop UI or via Dispatch from the Anthropic mobile app:

> *"Book the train to Edinburgh on Thursday at 2 PM. If you need to see my calendar or my bank card, just ask."*

Mid-task, Cowork can call `get_camera_snapshot` to grab your card or screen, or `request_voice_input` to ask *"Should I use the Sainsbury's card or the Monzo one?"* The phone speaks the question; you reply naturally; Cowork resumes.

### (Optional) Pair Dispatch

Anthropic's mobile app has its own QR-pair flow for Dispatch. That gives you a chat-style remote control for the Mac's Cowork agent. VisionClaude and Dispatch are independent — you can use one, both, or neither. When you use both, Dispatch is the "drive the task from afar" channel and VisionClaude is the "give the agent eyes/ears while it works" channel.

---

## Troubleshooting

### "No iOS clients connected" when Cowork tries `get_camera_snapshot`

The channel server is running but no phone is on the websocket. Open the iOS app and re-tap Connect; check the dashboard at `http://localhost:18790` shows >0 clients.

### Tool calls time out

Default timeouts: 15s for snapshots, 30s for voice. The phone has that long to fulfil. Common causes:

- **Phone screen locked + app backgrounded** — iOS suspends the websocket after a few minutes. Re-foreground the app.
- **Different Wi-Fi networks** — Mac on wired, phone on guest network. Put both on the same SSID.
- **Camera not initialized** — the iOS app needs to be in a session with the camera permission granted. Tap the camera icon if it's idle.

### Cowork doesn't speak the answer

The reply tool generates TTS audio only if `ELEVENLABS_API_KEY` is set. Configure it from the dashboard at `http://localhost:18790` — the form saves to `~/.claude/channels/visionclaude/.env` and takes effect immediately (no restart). Without ElevenLabs, the iOS app falls back to Apple's built-in TTS, which works but sounds noticeably worse.

### After a Claude Desktop update, MCP servers stopped working

Claude Desktop sometimes silently regenerates `claude_desktop_config.json` on major version bumps. Diff against your backup; if `visionclaude` is gone, paste it back and restart.

### "Pre-existing user found, but pw_version mismatch — sessions destroyed"

That's the Gateway server (different mode). You're looking at the wrong logs — Channel Mode doesn't have user accounts.

---

## What this setup does NOT do

- **It does not turn VisionClaude into an agent.** Cowork is the agent. VisionClaude is its sensors/actuators. If you want VisionClaude to plan and act on its own when no Mac is in the loop, use Gateway Mode (`ClaudeVision/server/`) — that has its own Anthropic API client and MCP loop.
- **It does not require Dispatch.** Dispatch is convenient but optional. Even without Dispatch, you can sit at the Mac and use Cowork normally; VisionClaude adds eyes/ears to whatever it's doing.
- **It does not invalidate your existing Claude Code `.mcp.json` setup.** You can keep both configs pointing at the same `server.ts` — but only run ONE at a time on port 18790. Channel server checks-and-fails on port conflict.

---

## Quick reference

| What | Where |
|---|---|
| MCP config (Claude Desktop) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Channel state + token | `~/.claude/channels/visionclaude/` |
| Channel server entrypoint | `ClaudeVision/channel/server.ts` |
| Dashboard | `http://localhost:18790` |
| Default port | 18790 (override with `VISIONCLAUDE_PORT`) |
| Claude Desktop MCP logs | `~/Library/Logs/Claude/mcp.log` |

---

## Updating

To pull new tools or fixes:

```bash
cd /path/to/visionclaude
git pull
cd ClaudeVision/channel && bun install
```

Then **fully quit and reopen Claude Desktop** so it respawns the channel server with the new code. No config-file changes needed unless this guide says otherwise.
