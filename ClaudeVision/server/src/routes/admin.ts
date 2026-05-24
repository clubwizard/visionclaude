import { Router } from "express";
import {
  createInvite,
  listInvites,
  revokeInvite,
  listUsers,
  deleteUser,
  setAdminFlag,
  countAdmins,
  findUserById,
} from "../users.js";
import { requireAdmin } from "../middleware.js";

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  // List users (no keys leaked)
  router.get("/users", (_req, res) => {
    res.json({ users: listUsers() });
  });

  // Delete a user — frees their unused invites so the codes can be reused.
  // Refuses to delete the calling admin (lock-out guard) and the last
  // remaining admin (server-bricking guard).
  router.delete("/users/:id", (req, res) => {
    const targetId = req.params.id;
    const callerId = req.session.userId!;
    if (targetId === callerId) {
      res.status(400).json({ error: "You cannot delete your own account from this UI." });
      return;
    }
    const target = findUserById(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (target.isAdmin && countAdmins() <= 1) {
      res.status(400).json({ error: "Refusing — this would leave the system with no admin." });
      return;
    }
    const ok = deleteUser(targetId);
    if (!ok) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ ok: true });
  });

  // Promote / demote a user.
  router.put("/users/:id/admin", (req, res) => {
    const targetId = req.params.id;
    const callerId = req.session.userId!;
    const body = req.body as { isAdmin?: boolean };
    if (typeof body.isAdmin !== "boolean") {
      res.status(400).json({ error: "isAdmin (boolean) is required" });
      return;
    }
    const target = findUserById(targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    // Don't let the only admin demote themselves and orphan the system.
    if (target.isAdmin && !body.isAdmin && countAdmins() <= 1) {
      res
        .status(400)
        .json({ error: "Refusing — this would leave the system with no admin." });
      return;
    }
    if (target.id === callerId && !body.isAdmin) {
      res
        .status(400)
        .json({ error: "Refusing — you cannot demote yourself. Ask another admin." });
      return;
    }
    setAdminFlag(targetId, body.isAdmin);
    const updated = findUserById(targetId);
    res.json({ ok: true, user: updated });
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
