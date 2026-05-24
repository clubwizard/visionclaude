import { Router } from "express";
import {
  authenticate,
  findUserById,
  countUsers,
  getUserKeyStatus,
  signupWithInvite,
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
    // Effective key resolution — matches the precedence used by /chat and
    // /voice. Lets the client gate the Talk button accurately:
    //   "own"  → user set their own key
    //   "env"  → falling back to the operator's env-var key (admin only)
    //   "none" → no key available; calls will 412
    const status = getUserKeyStatus(user.id);
    const envAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim();
    const envDeepgram = !!process.env.DEEPGRAM_API_KEY?.trim();
    const envOpenai = !!process.env.OPENAI_API_KEY?.trim();
    const effective = {
      anthropic:
        status.anthropic === "set"
          ? "own"
          : user.isAdmin && envAnthropic
          ? "env"
          : "none",
      deepgram:
        status.deepgram === "set"
          ? "own"
          : user.isAdmin && envDeepgram
          ? "env"
          : "none",
      openai:
        status.openai === "set"
          ? "own"
          : user.isAdmin && envOpenai
          ? "env"
          : "none",
    } as const;
    res.json({
      authenticated: true,
      user,
      keys: status,
      effectiveKeys: effective,
      canChat: effective.anthropic !== "none",
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
    // Atomic: claim the invite + create the user in one transaction. If the
    // invite is invalid/expired/already used, the user is NOT created (so
    // we can't be bypassed by ignoring a 400 and logging in afterwards).
    // If two requests race on the same token, only one wins.
    const result = signupWithInvite(token, email, password);
    if (!result.ok) {
      if (result.reason === "email_taken") {
        res.status(409).json({ error: "Email is already registered" });
      } else {
        res
          .status(400)
          .json({ error: "Invite is invalid, expired, or already used" });
      }
      return;
    }
    req.session.userId = result.user.id;
    req.session.isAdmin = result.user.isAdmin;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.json({ ok: true, user: result.user });
    });
  });

  // Bootstrap status — public, no auth — used by /signup page to show
  // "no admin yet, set BOOTSTRAP_ADMIN_* on the host" if the system is fresh.
  router.get("/status", (_req, res) => {
    res.json({ userCount: countUsers() });
  });

  return router;
}
