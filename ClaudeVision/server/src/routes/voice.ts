import express, { Router, type Request } from "express";
import { getUserApiKey } from "../users.js";

// Voice IDs are namespaced by provider:
//   aura-…       → Deepgram Aura-1   (e.g. aura-asteria-en)
//   aura-2-…     → Deepgram Aura-2   (e.g. aura-2-thalia-en)
//   openai-…     → OpenAI gpt-4o-mini-tts (e.g. openai-alloy)
const ALLOWED_DEEPGRAM_VOICES = new Set([
  // Aura-1 (legacy — flatter delivery, lower latency)
  "aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-athena-en", "aura-hera-en",
  "aura-orion-en", "aura-arcas-en", "aura-perseus-en", "aura-angus-en",
  "aura-orpheus-en", "aura-helios-en", "aura-zeus-en",
  // Aura-2 (warmer, more expressive — same Deepgram key)
  "aura-2-thalia-en", "aura-2-andromeda-en", "aura-2-helena-en", "aura-2-luna-en",
  "aura-2-apollo-en", "aura-2-arcas-en", "aura-2-atlas-en", "aura-2-orion-en",
  "aura-2-amalthea-en", "aura-2-aries-en",
]);

const ALLOWED_OPENAI_VOICES = new Set([
  "openai-alloy", "openai-ash", "openai-ballad", "openai-coral",
  "openai-echo", "openai-fable", "openai-nova", "openai-onyx",
  "openai-sage", "openai-shimmer",
]);

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
