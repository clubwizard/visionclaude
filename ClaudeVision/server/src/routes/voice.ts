import express, { Router } from "express";

const ALLOWED_VOICES = new Set([
  "aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-athena-en", "aura-hera-en",
  "aura-orion-en", "aura-arcas-en", "aura-perseus-en", "aura-angus-en",
  "aura-orpheus-en", "aura-helios-en", "aura-zeus-en",
]);
const DEFAULT_VOICE = "aura-asteria-en";

export function createVoiceRouter() {
  const router = Router();

  // POST /voice/speak — Deepgram Aura TTS
  router.post("/speak", async (req, res) => {
    const { text, voice } = req.body as { text?: string; voice?: string };
    const deepgramKey = process.env.DEEPGRAM_API_KEY;

    if (!deepgramKey) {
      res.status(503).json({ error: "DEEPGRAM_API_KEY not configured" });
      return;
    }
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    // Allowlist the voice to keep the URL parameter trustworthy.
    const model = voice && ALLOWED_VOICES.has(voice) ? voice : DEFAULT_VOICE;

    try {
      const response = await fetch(
        `https://api.deepgram.com/v1/speak?model=${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
        }
      );

      if (!response.ok) {
        res.status(502).json({ error: "Deepgram TTS failed" });
        return;
      }

      res.setHeader("Content-Type", "audio/mpeg");
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch {
      res.status(502).json({ error: "TTS request failed" });
    }
  });

  // POST /voice/transcribe — Deepgram Nova STT fallback
  router.post(
    "/transcribe",
    express.raw({ type: "*/*", limit: "10mb" }),
    async (req, res) => {
      const deepgramKey = process.env.DEEPGRAM_API_KEY;

      if (!deepgramKey) {
        res.status(503).json({ error: "DEEPGRAM_API_KEY not configured" });
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
          results?: {
            channels?: Array<{
              alternatives?: Array<{ transcript?: string }>;
            }>;
          };
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
