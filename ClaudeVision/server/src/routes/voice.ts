import express, { Router, type Request } from "express";
import { getUserApiKey } from "../users.js";

// Voice IDs are namespaced by provider:
//   aura-2-…     → Deepgram Aura-2   (e.g. aura-2-thalia-en)
//   openai-…     → OpenAI gpt-4o-mini-tts (e.g. openai-alloy)
//
// Aura-1 was removed — Aura-2 is the same Deepgram key but warmer and
// more expressive, with no real downside. Keeping both made the picker
// have ~22 Deepgram voices, half of which most users would never pick.
// If we ever need ultra-low-latency back, add it as a separate "Fast"
// optgroup rather than the full 12-voice legacy set.
interface VoiceMeta {
  id: string;
  label: string;       // "Thalia · F · US"
  provider: "deepgram" | "openai";
}

const DEEPGRAM_VOICES: VoiceMeta[] = [
  { id: "aura-2-thalia-en",     label: "Thalia · F · US",     provider: "deepgram" },
  { id: "aura-2-andromeda-en",  label: "Andromeda · F · US",  provider: "deepgram" },
  { id: "aura-2-helena-en",     label: "Helena · F · US",     provider: "deepgram" },
  { id: "aura-2-luna-en",       label: "Luna · F · US",       provider: "deepgram" },
  { id: "aura-2-amalthea-en",   label: "Amalthea · F · US",   provider: "deepgram" },
  { id: "aura-2-apollo-en",     label: "Apollo · M · US",     provider: "deepgram" },
  { id: "aura-2-arcas-en",      label: "Arcas · M · US",      provider: "deepgram" },
  { id: "aura-2-atlas-en",      label: "Atlas · M · US",      provider: "deepgram" },
  { id: "aura-2-orion-en",      label: "Orion · M · US",      provider: "deepgram" },
  { id: "aura-2-aries-en",      label: "Aries · M · US",      provider: "deepgram" },
];

const OPENAI_VOICES: VoiceMeta[] = [
  { id: "openai-alloy",   label: "Alloy · neutral",       provider: "openai" },
  { id: "openai-ash",     label: "Ash · warm",            provider: "openai" },
  { id: "openai-ballad",  label: "Ballad · lyrical",      provider: "openai" },
  { id: "openai-coral",   label: "Coral · warm F",        provider: "openai" },
  { id: "openai-echo",    label: "Echo · warm M",         provider: "openai" },
  { id: "openai-fable",   label: "Fable · British",       provider: "openai" },
  { id: "openai-nova",    label: "Nova · energetic F",    provider: "openai" },
  { id: "openai-onyx",    label: "Onyx · deep M",         provider: "openai" },
  { id: "openai-sage",    label: "Sage · calm",           provider: "openai" },
  { id: "openai-shimmer", label: "Shimmer · warm F",      provider: "openai" },
];

const ALLOWED_DEEPGRAM_VOICES = new Set(DEEPGRAM_VOICES.map(v => v.id));
const ALLOWED_OPENAI_VOICES = new Set(OPENAI_VOICES.map(v => v.id));

const DEFAULT_VOICE = "aura-2-thalia-en";

function providerForVoice(voice: string): "deepgram" | "openai" | null {
  if (ALLOWED_OPENAI_VOICES.has(voice)) return "openai";
  if (ALLOWED_DEEPGRAM_VOICES.has(voice)) return "deepgram";
  return null;
}

// Per-user key with admin env-fallback. Same precedence as /chat.
function resolveProviderKey(
  req: Request,
  slot: "deepgram" | "openai",
  envVar: string
): string | null {
  const userId = req.session?.userId;
  if (userId) {
    const own = getUserApiKey(userId, slot);
    if (own) return own;
    if (req.session?.isAdmin) {
      return process.env[envVar]?.trim() || null;
    }
    return null;
  }
  return process.env[envVar]?.trim() || null;
}

export function createVoiceRouter() {
  const router = Router();

  // GET /voice/list — returns the voices the *currently authenticated user*
  // can actually use, grouped by provider. Hides any provider the user has
  // no working key for (own key OR — for admins — the env fallback). This
  // is what the web client paints into the dropdown; hardcoding the full
  // list client-side meant users saw 30+ options, most of which 503'd at
  // click time.
  router.get("/list", (req, res) => {
    const groups: Array<{
      provider: "deepgram" | "openai";
      label: string;
      voices: Array<{ id: string; label: string }>;
    }> = [];

    const hasDeepgram = !!resolveProviderKey(req, "deepgram", "DEEPGRAM_API_KEY");
    const hasOpenAI = !!resolveProviderKey(req, "openai", "OPENAI_API_KEY");

    if (hasDeepgram) {
      groups.push({
        provider: "deepgram",
        label: "Deepgram Aura-2",
        voices: DEEPGRAM_VOICES.map(v => ({ id: v.id, label: v.label })),
      });
    }
    if (hasOpenAI) {
      groups.push({
        provider: "openai",
        label: "OpenAI",
        voices: OPENAI_VOICES.map(v => ({ id: v.id, label: v.label })),
      });
    }

    // Default voice: prefer Aura-2 (low-latency + warm), fall back to
    // OpenAI Alloy if only OpenAI is available, null if nothing is set.
    let defaultVoice: string | null = null;
    if (hasDeepgram) defaultVoice = DEFAULT_VOICE;
    else if (hasOpenAI) defaultVoice = "openai-alloy";

    res.json({
      groups,
      default: defaultVoice,
      // Surface this so the client can show a "Configure a TTS key" hint
      // instead of an empty dropdown.
      configured: hasDeepgram || hasOpenAI,
    });
  });

  router.post("/speak", async (req, res) => {
    const { text, voice } = req.body as { text?: string; voice?: string };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const chosen = voice && providerForVoice(voice) ? voice : DEFAULT_VOICE;
    const provider = providerForVoice(chosen)!; // safe — DEFAULT_VOICE is allowlisted

    try {
      if (provider === "openai") {
        const key = resolveProviderKey(req, "openai", "OPENAI_API_KEY");
        if (!key) {
          res.status(503).json({
            error: "No OpenAI API key configured. Add yours on the Account page.",
          });
          return;
        }
        await pipeOpenAi(res, key, chosen, text);
      } else {
        const key = resolveProviderKey(req, "deepgram", "DEEPGRAM_API_KEY");
        if (!key) {
          res.status(503).json({
            error:
              "No Deepgram API key configured. Add yours on the Account page (browser TTS will be used as fallback).",
          });
          return;
        }
        await pipeDeepgram(res, key, chosen, text);
      }
    } catch {
      if (!res.headersSent) res.status(502).json({ error: "TTS request failed" });
    }
  });

  // POST /voice/transcribe — Deepgram Nova STT fallback (unchanged provider)
  router.post(
    "/transcribe",
    express.raw({ type: "*/*", limit: "10mb" }),
    async (req, res) => {
      const deepgramKey = resolveProviderKey(req, "deepgram", "DEEPGRAM_API_KEY");
      if (!deepgramKey) {
        res.status(503).json({ error: "No Deepgram API key configured." });
        return;
      }
      try {
        const response = await fetch(
          "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
          {
            method: "POST",
            headers: {
              Authorization: `Token ${deepgramKey}`,
              "Content-Type":
                (req.headers["content-type"] as string) || "audio/webm",
            },
            body: req.body as any,
          }
        );
        if (!response.ok) {
          res.status(502).json({ error: "Deepgram STT failed" });
          return;
        }
        const data = (await response.json()) as {
          results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
        };
        const transcript =
          data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
        res.json({ text: transcript });
      } catch {
        res.status(502).json({ error: "STT request failed" });
      }
    }
  );

  return router;
}

async function pipeDeepgram(
  res: express.Response,
  apiKey: string,
  voice: string,
  text: string
): Promise<void> {
  const response = await fetch(
    `https://api.deepgram.com/v1/speak?model=${voice}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );
  if (!response.ok) {
    res.status(502).json({ error: `Deepgram TTS failed (${response.status})` });
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
}

async function pipeOpenAi(
  res: express.Response,
  apiKey: string,
  voice: string,
  text: string
): Promise<void> {
  // Strip the "openai-" prefix to get the actual OpenAI voice name.
  const voiceName = voice.replace(/^openai-/, "");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voiceName,
      input: text,
      // Default MP3 response — matches the Audio element path in the
      // client. Could expose `instructions` per-request later for vibes
      // ("speak warmly", "with subtle British accent") but keep v1 simple.
    }),
  });
  if (!response.ok) {
    res
      .status(502)
      .json({ error: `OpenAI TTS failed (${response.status})` });
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  const buffer = await response.arrayBuffer();
  res.send(Buffer.from(buffer));
}
