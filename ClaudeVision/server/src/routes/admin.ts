import { Router } from "express";
import {
  createInvite,
  listInvites,
  revokeInvite,
  listUsers,
} from "../users.js";
import { requireAdmin } from "../middleware.js";

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  // List users (no keys leaked)
  router.get("/users", (_req, res) => {
    res.json({ users: listUsers() });
  });

  // List all invites (used + unused)
  router.get("/invites", (_req, res) => {
    res.json({ invites: listInvites() });
  });

  // Mint a new invite, copy-pasted by the admin to the invitee
  router.post("/invites", (req, res) => {
    const userId = req.session.userId!;
    const invite = createInvite(userId);
    res.json({
      invite,
      // Convenience: pre-built signup URL the admin can copy
      signupUrl: `/signup?token=${invite.token}`,
    });
  });

  // Revoke an unused invite
  router.delete("/invites/:token", (req, res) => {
    const ok = revokeInvite(req.params.token);
    if (!ok) {
      res.status(404).json({ error: "Invite not found or already used" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
