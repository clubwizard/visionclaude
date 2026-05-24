import { Router } from "express";
import {
  findUserById,
  getUserKeyStatus,
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

  return router;
}
