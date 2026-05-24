import { Router } from "express";
import {
  findUserById,
  getUserKeyStatus,
  getUserApiKey,
  setUserApiKey,
  type KeySlot,
} from "../users.js";
import { requireAuth } from "../middleware.js";

export function createMeRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // Current user info (no keys, just identity + key status)
  router.get("/", (req, res) => {
    const user = findUserById(req.session.userId!);
    if (!user) {
      res.status(404).json({ error: "User no longer exists" });
      return;
    }
    res.json({ user, keys: getUserKeyStatus(user.id) });
  });

  // GET key status only — never returns plaintext
  router.get("/api-keys", (req, res) => {
    res.json({ keys: getUserKeyStatus(req.session.userId!) });
  });

  // PUT key(s) — pass null/empty string to clear a slot
  router.put("/api-keys", (req, res) => {
    const body = req.body as { anthropic?: string | null; deepgram?: string | null };
    const userId = req.session.userId!;
    const updates: KeySlot[] = [];
    if (body.anthropic !== undefined) {
      setUserApiKey(userId, "anthropic", body.anthropic ?? null);
      updates.push("anthropic");
    }
    if (body.deepgram !== undefined) {
      setUserApiKey(userId, "deepgram", body.deepgram ?? null);
      updates.push("deepgram");
    }
    res.json({ ok: true, updated: updates, keys: getUserKeyStatus(userId) });
  });

  // POST /me/api-keys/test — verify a key actually works against the
  // upstream provider without burning real model usage. Body:
  //   { slot: "anthropic" | "deepgram", candidate?: string }
  // If `candidate` is supplied it's tested as-is (not saved). Otherwise
  // the stored key for that slot is tested.
  router.post("/api-keys/test", async (req, res) => {
    const body = req.body as { slot?: KeySlot; candidate?: string };
    const slot = body.slot;
    if (slot !== "anthropic" && slot !== "deepgram") {
      res.status(400).json({ error: "slot must be 'anthropic' or 'deepgram'" });
      return;
    }
    const userId = req.session.userId!;
    const key =
      body.candidate?.trim() || getUserApiKey(userId, slot) || null;
    if (!key) {
      res
        .status(400)
        .json({ ok: false, reason: "no_key", message: "No key supplied or stored." });
      return;
    }
    try {
      const result = slot === "anthropic"
        ? await testAnthropic(key)
        : await testDeepgram(key);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ ok: false, reason: "network", message });
    }
  });

  return router;
}

// Anthropic doesn't expose a free "ping" endpoint, but /v1/models is a
// no-cost authenticated GET that returns 200 on a valid key, 401 on a bad
// one, 403 on a disabled one, and 429 if rate-limited.
async function testAnthropic(
  apiKey: string
): Promise<{ ok: boolean; reason?: string; message?: string; detail?: unknown }> {
  const r = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      data?: Array<{ id: string }>;
    };
    return {
      ok: true,
      message: `Authenticated. ${data?.data?.length ?? 0} models available.`,
    };
  }
  if (r.status === 401) {
    return { ok: false, reason: "auth", message: "Anthropic rejected the key (401)." };
  }
  if (r.status === 403) {
    return { ok: false, reason: "forbidden", message: "Key valid but lacks access (403)." };
  }
  if (r.status === 429) {
    return { ok: false, reason: "rate_limited", message: "Rate-limited (429). Key looks valid." };
  }
  return { ok: false, reason: "http", message: `HTTP ${r.status}` };
}

// Deepgram exposes /v1/projects on every account — authenticated GET, no
// model usage, returns 200 with the project list on success.
async function testDeepgram(
  apiKey: string
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const r = await fetch("https://api.deepgram.com/v1/projects", {
    method: "GET",
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      projects?: Array<{ name?: string }>;
    };
    const names = (data?.projects ?? []).map((p) => p.name).filter(Boolean);
    return {
      ok: true,
      message: names.length
        ? `Authenticated. Projects: ${names.join(", ")}.`
        : "Authenticated.",
    };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: "auth", message: `Deepgram rejected the key (${r.status}).` };
  }
  return { ok: false, reason: "http", message: `HTTP ${r.status}` };
}
