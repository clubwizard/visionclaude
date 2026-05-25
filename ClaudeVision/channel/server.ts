#!/usr/bin/env bun
/**
 * VisionClaude Channel for Claude Code.
 *
 * Bridges an iOS app (camera + voice + Meta Ray-Ban glasses) into a running
 * Claude Code session via the MCP channel contract. Messages from the phone
 * arrive over WebSocket/HTTP and are pushed as channel notifications. Claude
 * replies via the reply tool, which forwards back to the iOS app.
 *
 * Supports:
 *  - Text messages (voice transcriptions)
 *  - Image uploads (camera frames, glasses frames)
 *  - Voice + image combo (describe what I see)
 *  - File attachments
 *  - ElevenLabs TTS for voice responses
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, existsSync } from 'fs'
import { homedir, networkInterfaces } from 'os'
import { join, extname, basename } from 'path'
import type { ServerWebSocket } from 'bun'

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.VISIONCLAUDE_PORT ?? 18790)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'visionclaude')
const INBOX_DIR = join(STATE_DIR, 'inbox')    // images from phone
const OUTBOX_DIR = join(STATE_DIR, 'outbox')  // files from Claude
const ENV_FILE = join(STATE_DIR, '.env')

// Load .env for ElevenLabs key
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

let ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? ''
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID ?? 'XB0fDUnXU5powFXDhCwa' // Charlotte
const ELEVENLABS_MODEL = 'eleven_flash_v2_5'

// ── Auth ──────────────────────────────────────────────────────────────────
// Generate a random token on first run, save it, reuse on restarts
function loadOrCreateToken(): string {
  const tokenFile = join(STATE_DIR, '.channel-token')
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch {}
  // Generate a 32-char hex token
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(tokenFile, token, { mode: 0o600 })
  return token
}
const CHANNEL_TOKEN = process.env.VISIONCLAUDE_TOKEN ?? loadOrCreateToken()

function checkAuth(req: Request): boolean {
  // Check Authorization header: "Bearer <token>"
  const authHeader = req.headers.get('authorization')
  if (authHeader === `Bearer ${CHANNEL_TOKEN}`) return true
  // Check query param: ?token=<token>
  const url = new URL(req.url)
  if (url.searchParams.get('token') === CHANNEL_TOKEN) return true
  return false
}

function unauthorized(): Response {
  return Response.json(
    { error: 'unauthorized', hint: 'Set the channel token in iOS app Settings → Channel Token' },
    { status: 401 }
  )
}

// ── Types ───────────────────────────────────────────────────────────────────
type WireOut =
  | { type: 'reply'; id: string; text: string; audio_url?: string }
  | { type: 'status'; status: string }
  | { type: 'thinking'; text: string }
  // Cowork-connector pull pattern: server asks the phone for fresh sensor
  // input. The phone fulfils the request by POSTing /upload (snapshot)
  // or /message (voice transcription) with the same request_id, which
  // resolves the pending promise on the server.
  | { type: 'request_snapshot'; request_id: string; source: 'iphone' | 'rayban'; prompt?: string }
  | { type: 'request_voice'; request_id: string; prompt: string; timeout_ms: number }

const clients = new Set<ServerWebSocket<unknown>>()
let seq = 0

// Pull-pattern correlation map: tool calls push a Wire message asking the
// phone to do something, then await a fulfilment on the inbound /upload
// or /message route keyed by the same request_id. Timeouts reject the
// promise so the MCP tool returns an error instead of hanging forever.
interface PendingSnapshot {
  kind: 'snapshot'
  resolve: (img: { path: string; mime: string; bytes: Buffer }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface PendingVoice {
  kind: 'voice'
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type PendingRequest = PendingSnapshot | PendingVoice
const pendingRequests = new Map<string, PendingRequest>()

function awaitPendingSnapshot(
  requestId: string,
  timeoutMs: number,
): Promise<{ path: string; mime: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error(`snapshot request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pendingRequests.set(requestId, { kind: 'snapshot', resolve, reject, timer })
  })
}

function awaitPendingVoice(
  requestId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error(`voice request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pendingRequests.set(requestId, { kind: 'voice', resolve, reject, timer })
  })
}

function resolveSnapshot(
  requestId: string,
  payload: { path: string; mime: string; bytes: Buffer },
): boolean {
  const pending = pendingRequests.get(requestId)
  if (!pending || pending.kind !== 'snapshot') return false
  clearTimeout(pending.timer)
  pendingRequests.delete(requestId)
  pending.resolve(payload)
  return true
}

function resolveVoice(requestId: string, text: string): boolean {
  const pending = pendingRequests.get(requestId)
  if (!pending || pending.kind !== 'voice') return false
  clearTimeout(pending.timer)
  pendingRequests.delete(requestId)
  pending.resolve(text)
  return true
}

// Activity log (last 50 messages)
type ActivityEntry = { ts: string; direction: 'in' | 'out'; source: string; text: string; hasImage?: boolean }
const activityLog: ActivityEntry[] = []
function logActivity(entry: ActivityEntry) {
  activityLog.unshift(entry)
  if (activityLog.length > 50) activityLog.length = 50
}

function nextId() { return `vc${Date.now()}-${++seq}` }

function broadcast(m: WireOut) {
  const data = JSON.stringify(m)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

function log(msg: string) {
  process.stderr.write(`[visionclaude] ${msg}\n`)
}

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────
async function generateTTS(text: string): Promise<string | undefined> {
  if (!ELEVENLABS_KEY) return undefined
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_KEY,
        },
        body: JSON.stringify({
          text: text.slice(0, 2000),
          model_id: ELEVENLABS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    )
    if (!resp.ok) {
      log(`TTS error: ${resp.status}`)
      return undefined
    }
    mkdirSync(OUTBOX_DIR, { recursive: true })
    const buf = Buffer.from(await resp.arrayBuffer())
    const name = `tts-${Date.now()}.mp3`
    writeFileSync(join(OUTBOX_DIR, name), buf)
    return `/files/${name}`
  } catch (e) {
    log(`TTS error: ${e}`)
    return undefined
  }
}

// ── MCP Channel Server ──────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'visionclaude', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'VisionClaude gives Claude (Code or Cowork) wearable eyes + ears via an iOS app and ',
      'optional Meta Ray-Ban Smart Glasses. Two interaction modes:',
      '',
      '1. PHONE-INITIATED (push). The user speaks or captures an image; a message arrives as',
      '   <channel source="visionclaude" ...>. If the tag has a file_path attribute, Read that',
      '   file — it is an image from the camera or glasses.',
      '',
      '2. AGENT-INITIATED (pull). Use these tools mid-task to ask the phone for fresh sensor input:',
      '   - get_camera_snapshot — grab a fresh photo. Use when you need to SEE something the user',
      '     is looking at right now (a screen, a receipt, a label) and they haven\'t just sent one.',
      '   - request_voice_input — speak ONE short clarifying question and wait for the user\'s',
      '     spoken reply. Use sparingly — only when you genuinely need a missing detail to proceed.',
      '',
      'REPLY through the reply tool — your transcript output never reaches the iOS app.',
      'Keep replies concise (1-3 sentences) for voice responses unless asked for detail.',
      '',
      'VISION INSTRUCTIONS when describing an image:',
      '- Read all visible text exactly (signs, screens, labels, brands, prices).',
      '- Use proper nouns: "silver MacBook Pro" not "a laptop".',
      '- Note spatial relationships: "to the left of", "behind the", "on top of".',
      '- Be conversational — the user is wearing glasses or holding a phone, speak naturally.',
      '',
      `The iOS app connects via WebSocket at ws://localhost:${PORT}/ws.`,
    ].join('\n'),
  },
)

// ── Tools: reply + sensor pulls ─────────────────────────────────────────────
//
// Two interaction patterns:
//
//   1. Phone-initiated (existing): the user speaks/captures, the phone
//      POSTs a message which arrives via deliver() as a channel
//      notification. Claude/Cowork replies through `reply`.
//
//   2. Server-initiated (new — Cowork connector pattern): the agent calls
//      `get_camera_snapshot` or `request_voice_input` mid-task to pull a
//      fresh image or short utterance from the phone. Implemented as a
//      WS message → phone fulfils → MCP tool returns the result inline.
//
// The new tools enable flows like: "look up Sarah's email, send the train
// confirmation. If unsure of the address, ask the user." Cowork can call
// `request_voice_input` to disambiguate without breaking the task loop.
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a text reply to the VisionClaude iOS app. If ElevenLabs is configured, TTS audio is generated automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The reply text' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
          files: { type: 'array', items: { type: 'string' }, description: 'File paths to attach' },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent reply.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'get_camera_snapshot',
      description:
        'Pull a fresh photo from the user\'s active camera (iPhone or Ray-Ban glasses). ' +
        'Returns an image content block. Use this when you need to SEE something the user is ' +
        'looking at right now — a screen, a receipt, a label — not when the user has already ' +
        'sent an image (those arrive as channel notifications). Default timeout is 15s.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['iphone', 'rayban'],
            description: 'Which camera to use. Defaults to iphone if both are available.',
          },
          prompt: {
            type: 'string',
            description: 'Optional one-line context the iOS app may show on screen (e.g. "Show me the laptop screen").',
          },
          timeout_ms: {
            type: 'number',
            description: 'Hard cap on how long to wait for the phone to deliver (default 15000).',
          },
        },
      },
    },
    {
      name: 'request_voice_input',
      description:
        'Speak a prompt aloud to the user (via ElevenLabs TTS if configured) and wait for their ' +
        'spoken reply. Returns the transcribed text. Use this for one clarifying question mid-task, ' +
        'NOT for free-form conversation — the user pushes those through the channel directly. ' +
        'Default timeout is 30s; the prompt should be ≤1 sentence.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What to ask the user. One sentence.',
          },
          timeout_ms: {
            type: 'number',
            description: 'How long to wait for the user to respond (default 30000).',
          },
        },
        required: ['prompt'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const id = nextId()

        // Generate TTS audio in parallel
        const audioPromise = generateTTS(text)

        // Handle file attachments
        const files = (args.files as string[] | undefined) ?? []
        if (files[0]) {
          mkdirSync(OUTBOX_DIR, { recursive: true })
          const ext = extname(files[0]).toLowerCase()
          const out = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          copyFileSync(files[0], join(OUTBOX_DIR, out))
        }

        const audioUrl = await audioPromise
        broadcast({ type: 'reply', id, text, audio_url: audioUrl })
        logActivity({ ts: new Date().toISOString(), direction: 'out', source: 'claude', text: text.slice(0, 100) })
        log(`→ reply: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`)

        return { content: [{ type: 'text', text: `sent ${id}${audioUrl ? ' (with audio)' : ''}` }] }
      }

      case 'edit_message': {
        broadcast({ type: 'reply', id: args.message_id as string, text: args.text as string })
        return { content: [{ type: 'text', text: 'ok' }] }
      }

      case 'get_camera_snapshot': {
        if (clients.size === 0) {
          return {
            content: [{ type: 'text', text: 'no iOS clients connected — cannot capture snapshot' }],
            isError: true,
          }
        }
        const source = ((args.source as string) === 'rayban' ? 'rayban' : 'iphone') as
          | 'iphone'
          | 'rayban'
        const promptText = (args.prompt as string | undefined) ?? undefined
        const timeoutMs = Math.min(Math.max(Number(args.timeout_ms ?? 15000) || 15000, 1000), 60000)
        const requestId = `req-snap-${Date.now()}-${++seq}`
        log(`↗ get_camera_snapshot (${source}) request=${requestId} timeout=${timeoutMs}ms`)

        const promise = awaitPendingSnapshot(requestId, timeoutMs)
        broadcast({ type: 'request_snapshot', request_id: requestId, source, prompt: promptText })

        try {
          const img = await promise
          const ext = extname(img.path).toLowerCase()
          const mimeType = mime(ext)
          log(`↙ snapshot received for ${requestId} (${(img.bytes.length / 1024).toFixed(0)}KB ${mimeType})`)
          return {
            content: [
              {
                type: 'image',
                data: img.bytes.toString('base64'),
                mimeType,
              },
              {
                type: 'text',
                text: `Captured from ${source}. Local path: ${img.path}`,
              },
            ],
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }
        }
      }

      case 'request_voice_input': {
        if (clients.size === 0) {
          return {
            content: [{ type: 'text', text: 'no iOS clients connected — cannot request voice input' }],
            isError: true,
          }
        }
        const promptText = args.prompt as string
        if (typeof promptText !== 'string' || !promptText.trim()) {
          return {
            content: [{ type: 'text', text: 'prompt is required and must be a non-empty string' }],
            isError: true,
          }
        }
        const timeoutMs = Math.min(Math.max(Number(args.timeout_ms ?? 30000) || 30000, 2000), 120000)
        const requestId = `req-voice-${Date.now()}-${++seq}`
        log(`↗ request_voice_input "${promptText.slice(0, 50)}" request=${requestId} timeout=${timeoutMs}ms`)

        // Generate TTS for the prompt so the user actually hears the question.
        // The audio is delivered alongside the request so the phone can play it.
        const audioUrl = await generateTTS(promptText)

        const promise = awaitPendingVoice(requestId, timeoutMs)
        broadcast({ type: 'request_voice', request_id: requestId, prompt: promptText, timeout_ms: timeoutMs })
        // Also push a reply-style message so the prompt shows up in the
        // transcript and (if TTS is on) is spoken aloud. The phone treats
        // request_voice as the "start listening" signal.
        broadcast({ type: 'reply', id: `${requestId}-prompt`, text: promptText, audio_url: audioUrl })

        try {
          const text = await promise
          log(`↙ voice reply for ${requestId}: "${text.slice(0, 60)}"`)
          return { content: [{ type: 'text', text }] }
        } catch (err) {
          return {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }
        }
      }

      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

// Connect MCP over stdio
await mcp.connect(new StdioServerTransport())

// ── Deliver messages from iOS to Claude ─────────────────────────────────────
function deliver(
  id: string,
  text: string,
  source: 'iphone' | 'rayban',
  image?: { path: string; name: string }
): void {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || (image ? `(image from ${source})` : '(empty)'),
      meta: {
        chat_id: source,
        message_id: id,
        user: 'phone',
        source,
        ts: new Date().toISOString(),
        ...(image ? { file_path: image.path } : {}),
      },
    },
  })
  log(`← ${source}: ${text.slice(0, 60)}${image ? ` [+image: ${image.name}]` : ''}`)
}

// ── HTTP + WebSocket Server ─────────────────────────────────────────────────
function mime(ext: string) {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',  // allow LAN connections from phone
  async fetch(req, server) {
    const url = new URL(req.url)

    // ── WebSocket upgrade ───────────────────────────────────────────────
    if (url.pathname === '/ws') {
      if (!checkAuth(req)) return unauthorized()
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }

    // ── Health check (no auth — just a ping) ─────────────────────────
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        mode: 'channel',
        clients: clients.size,
        tts: !!ELEVENLABS_KEY,
        auth: 'required',
      })
    }

    // ── Local IP endpoint ─────────────────────────────────────────────
    if (url.pathname === '/local-ip') {
      const nets = networkInterfaces()
      const ips: string[] = []
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
          if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
        }
      }
      return Response.json({ ips, preferred: ips[0] ?? 'unknown' })
    }

    // ── Token endpoint (localhost only — so user can grab it) ────────
    if (url.pathname === '/token') {
      const reqHost = req.headers.get('host') ?? ''
      const isLocal = reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1')
      if (!isLocal) {
        return Response.json({ error: 'token only available from localhost' }, { status: 403 })
      }
      return Response.json({ token: CHANNEL_TOKEN })
    }

    // ── Serve files (TTS audio, attachments) ────────────────────────────
    if (url.pathname.startsWith('/files/')) {
      const f = url.pathname.slice(7)
      if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
      try {
        return new Response(readFileSync(join(OUTBOX_DIR, f)), {
          headers: {
            'content-type': mime(extname(f).toLowerCase()),
            'access-control-allow-origin': '*',
          },
        })
      } catch {
        return new Response('404', { status: 404 })
      }
    }

    // ── Auth-protected endpoints ────────────────────────────────────────
    if (['/upload', '/message', '/files/'].some(p => url.pathname.startsWith(p)) && !checkAuth(req)) {
      return unauthorized()
    }

    // ── Image upload from iOS app ───────────────────────────────────────
    if (url.pathname === '/upload' && req.method === 'POST') {
      return (async () => {
        const form = await req.formData()
        const id = String(form.get('id') ?? nextId())
        const text = String(form.get('text') ?? '')
        const source = (String(form.get('source') ?? 'iphone')) as 'iphone' | 'rayban'
        const requestId = form.get('request_id') ? String(form.get('request_id')) : undefined
        const f = form.get('image') ?? form.get('file')

        let image: { path: string; name: string; bytes: Buffer } | undefined
        if (f instanceof File && f.size > 0) {
          mkdirSync(INBOX_DIR, { recursive: true })
          const ext = extname(f.name).toLowerCase() || '.jpg'
          const path = join(INBOX_DIR, `${Date.now()}-${source}${ext}`)
          const bytes = Buffer.from(await f.arrayBuffer())
          writeFileSync(path, bytes)
          image = { path, name: f.name, bytes }
          log(`📷 saved ${source} image: ${path} (${(f.size / 1024).toFixed(0)}KB)`)
        }

        // If this image is fulfilling a get_camera_snapshot tool call,
        // resolve the waiting promise INSTEAD of delivering it as a new
        // channel notification — the agent already has the message in the
        // tool result. Falls through to deliver() if the request_id is
        // unknown (e.g. a delayed response after the timeout fired).
        if (requestId && image) {
          const mimeType = mime(extname(image.path).toLowerCase())
          if (resolveSnapshot(requestId, { path: image.path, mime: mimeType, bytes: image.bytes })) {
            return new Response(null, { status: 204 })
          }
        }

        deliver(id, text, source, image)
        return new Response(null, { status: 204 })
      })()
    }

    // ── Text-only message via POST ──────────────────────────────────────
    if (url.pathname === '/message' && req.method === 'POST') {
      return (async () => {
        const body = await req.json() as { text?: string; source?: string; id?: string; request_id?: string }
        const id = body.id ?? nextId()
        const source = (body.source ?? 'iphone') as 'iphone' | 'rayban'
        const text = body.text ?? ''

        // Voice-input fulfilment path: don't deliver as a new channel
        // notification; resolve the waiting request_voice_input tool call.
        if (body.request_id && resolveVoice(body.request_id, text)) {
          logActivity({ ts: new Date().toISOString(), direction: 'in', source, text: `[voice-reply] ${text.slice(0, 100)}` })
          return Response.json({ ok: true, id, fulfilled: body.request_id })
        }

        deliver(id, text, source)
        logActivity({ ts: new Date().toISOString(), direction: 'in', source, text: text.slice(0, 100) })
        return Response.json({ ok: true, id, delivered_to: clients.size, clients: clients.size })
      })()
    }

    // ── Activity log ─────────────────────────────────────────────────────
    if (url.pathname === '/activity') {
      if (!checkAuth(req)) return unauthorized()
      return Response.json({ activity: activityLog })
    }

    // ── Send iMessage/SMS via AppleScript ──────────────────────────────
    if (url.pathname === '/send-sms' && req.method === 'POST') {
      if (!checkAuth(req)) return unauthorized()
      try {
        const body = await req.json() as { phone?: string; message?: string }
        if (!body.phone || !body.message) {
          return Response.json({ error: 'missing phone or message' }, { status: 400 })
        }
        // Support both phone numbers and email addresses (Apple ID)
        const recipient = body.phone.includes('@')
          ? body.phone.trim()  // email — use as-is
          : body.phone.replace(/[^0-9+]/g, '')  // phone — strip non-numeric
        const msg = body.message.replace(/\\/g, '\\\\').replace(/"/g, '\\"') // escape for AppleScript
        const script = `
          tell application "Messages"
            set targetService to 1st service whose service type = iMessage
            set targetBuddy to buddy "${recipient}" of targetService
            send "${msg}" to targetBuddy
          end tell
        `
        const proc = Bun.spawn(['osascript', '-e', script], { stderr: 'pipe', stdout: 'pipe' })
        const exitCode = await proc.exited
        if (exitCode === 0) {
          logActivity({ ts: new Date().toISOString(), direction: 'out', source: 'imessage', text: `→ ${recipient}: ${body.message.slice(0, 60)}` })
          return Response.json({ ok: true, method: 'imessage' })
        } else {
          const stderr = await new Response(proc.stderr).text()
          return Response.json({ ok: false, error: stderr.trim() || 'AppleScript failed' }, { status: 500 })
        }
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 })
      }
    }

    // ── CORS preflight ──────────────────────────────────────────────────
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      })
    }

    // ── Save ElevenLabs key ─────────────────────────────────────────────
    if (url.pathname === '/config/tts' && req.method === 'POST') {
      if (!checkAuth(req)) return unauthorized()
      try {
        const body = await req.json() as { key?: string }
        if (!body.key) return Response.json({ error: 'missing key' }, { status: 400 })
        mkdirSync(STATE_DIR, { recursive: true })
        // Read existing .env, update or add ELEVENLABS_API_KEY
        let envContent = ''
        try { envContent = readFileSync(ENV_FILE, 'utf8') } catch {}
        if (envContent.includes('ELEVENLABS_API_KEY=')) {
          envContent = envContent.replace(/ELEVENLABS_API_KEY=.*/, `ELEVENLABS_API_KEY=${body.key}`)
        } else {
          envContent += `\nELEVENLABS_API_KEY=${body.key}`
        }
        writeFileSync(ENV_FILE, envContent.trim() + '\n')
        // Update in-memory key immediately — no restart needed
        ELEVENLABS_KEY = body.key
        process.env.ELEVENLABS_API_KEY = body.key
        log(`🎙 ElevenLabs key updated (live, no restart needed)`)
        return Response.json({ ok: true, applied: true })
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 })
      }
    }

    // ── Root: show status page ──────────────────────────────────────────
    if (url.pathname === '/') {
      try {
        const html = readFileSync(join(import.meta.dir, 'status.html'), 'utf8')
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      } catch {
        return new Response('Status page not found', { status: 500 })
      }
    }

    return new Response('404', { status: 404 })
  },

  websocket: {
    open: ws => {
      clients.add(ws)
      log(`📱 client connected (${clients.size} total)`)
      ws.send(JSON.stringify({ type: 'status', status: 'connected' }))
    },
    close: ws => {
      clients.delete(ws)
      log(`📱 client disconnected (${clients.size} total)`)
    },
    message: (_, raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          id?: string
          text?: string
          source?: string
          image?: string  // base64
          request_id?: string
        }
        const id = msg.id ?? nextId()
        const source = (msg.source ?? 'iphone') as 'iphone' | 'rayban'

        // If image is included as base64, save to disk
        let image: { path: string; name: string; bytes: Buffer } | undefined
        if (msg.image) {
          mkdirSync(INBOX_DIR, { recursive: true })
          const buf = Buffer.from(msg.image, 'base64')
          const path = join(INBOX_DIR, `${Date.now()}-${source}.jpg`)
          writeFileSync(path, buf)
          image = { path, name: `${source}-frame.jpg`, bytes: buf }
          log(`📷 saved ${source} frame via WS (${(buf.length / 1024).toFixed(0)}KB)`)
        }

        // Pull-pattern fulfilment over WS — same correlation logic as the
        // HTTP routes. Snapshot fulfilment needs an image; voice
        // fulfilment needs text.
        if (msg.request_id) {
          if (image && resolveSnapshot(msg.request_id, { path: image.path, mime: mime(extname(image.path)), bytes: image.bytes })) {
            return
          }
          if (msg.text && resolveVoice(msg.request_id, msg.text)) {
            return
          }
          // request_id provided but doesn't match a pending request →
          // fall through to deliver() so the message isn't silently lost.
        }

        if (msg.text?.trim() || image) {
          deliver(id, msg.text?.trim() ?? '', source, image)
        }
      } catch (e) {
        log(`WS parse error: ${e}`)
      }
    },
  },
})

log(`🚀 VisionClaude channel running on http://0.0.0.0:${PORT}`)
log(`   WebSocket: ws://localhost:${PORT}/ws`)
log(`   Health:    http://localhost:${PORT}/health`)
log(`   Upload:    POST http://localhost:${PORT}/upload`)
log(`   TTS:       ${ELEVENLABS_KEY ? '✅ ElevenLabs configured' : '❌ No ElevenLabs key'}`)
log(``)
log(`   🔐 Channel Token: ${CHANNEL_TOKEN}`)
log(`   Dashboard:  http://localhost:${PORT}`)
log(`   Enter token in iOS app → Settings → Channel Token`)

// Auto-open dashboard in default browser (best-effort: `open` only exists on
// macOS; on Linux/Windows this is a no-op rather than a crash).
try {
  Bun.spawn(['open', `http://localhost:${PORT}`], { stdout: 'ignore', stderr: 'ignore' })
} catch {
  // expected on non-macOS hosts
}
