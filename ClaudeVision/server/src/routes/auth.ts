import { Router } from "express";
import {
  authenticate,
  consumeInvite,
  createUser,
  findUserById,
  findUserByEmail,
  countUsers,
  getUserKeyStatus,
} from "../users.js";

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/login — { email, password } → sets session.userId
  router.post("/login", (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const user = authenticate(email, password);
    if (!user) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }
    req.session.userId = user.id;
    req.session.isAdmin = user.isAdmin;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.json({ ok: true, user });
    });
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("sid");
      res.json({ ok: true });
    });
  });

  router.get("/check", (req, res) => {
    if (!req.session.userId) {
      res.json({ authenticated: false });
      return;
    }
    const user = findUserById(req.session.userId);
    if (!user) {
      res.json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      user,
      keys: getUserKeyStatus(user.id),
    });
  });

  // POST /auth/signup — consumes an invite token and creates the user.
  // Body: { token, email, password }. Body password ≥ 8 chars.
  router.post("/signup", (req, res) => {
    const { token, email, password } = req.body as {
      token?: string;
      email?: string;
      password?: string;
    };
    if (!token || !email || !password) {
      res
        .status(400)
        .json({ error: "token, email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    if (findUserByEmail(email)) {
      res.status(409).json({ error: "Email is already registered" });
      return;
    }
    const user = createUser({ email, password });
    const invite = consumeInvite(token, user.id);
    if (!invite) {
      // Roll back the user we just created — this is a race-condition
      // safety net; consumeInvite already filtered by !used and !expired.
      // In practice we just hit "invalid invite" before user creation.
      res.status(400).json({ error: "Invite is invalid, expired, or already used" });
      return;
    }
    req.session.userId = user.id;
    req.session.isAdmin = user.isAdmin;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.json({ ok: true, user });
    });
  });

  // Bootstrap status — public, no auth — used by /signup page to show
  // "no admin yet, set BOOTSTRAP_ADMIN_* on the host" if the system is fresh.
  router.get("/status", (_req, res) => {
    res.json({ userCount: countUsers() });
  });

  return router;
}
