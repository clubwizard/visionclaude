import { Router, type Request } from "express";
import {
  authenticate,
  findUserByEmail,
  countUsers,
  getUserKeyStatus,
  signupWithInvite,
  isValidEmail,
  createPasswordResetToken,
  consumePasswordResetToken,
  isPasswordResetTokenValid,
} from "../users.js";
import { getAuthenticatedUser } from "../middleware.js";
import { sendPasswordResetEmail } from "../postmark.js";

// ── Per-email rate limit for /auth/forgot-password ──────────────────
//
// The existing 5/min/IP cap on /auth limits the rate any one IP can hit
// any auth endpoint — but it doesn't stop an attacker (or a botnet)
// from spamming many resets to the SAME victim's inbox by rotating IPs.
// This bounds the number of emails actually sent per address regardless
// of how many sources request them.
//
// The check runs BEFORE the user lookup so the timing and response are
// identical whether the email is registered, unregistered, or rate-
// limited. Exceeded requests are silently dropped (still a 200) — that
// keeps the no-enumeration property; an attacker can't probe by watching
// for "rate-limited" responses.
const FORGOT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FORGOT_MAX_PER_WINDOW = 3;
const forgotHistory = new Map<string, number[]>();
let forgotSweepStarted = false;

function startForgotSweeper(): void {
  if (forgotSweepStarted) return;
  forgotSweepStarted = true;
  // .unref() so the timer doesn't keep the test process alive after
  // assertions complete — and so Ctrl-C in dev still exits cleanly.
  setInterval(() => {
    const cutoff = Date.now() - FORGOT_WINDOW_MS;
    for (const [key, history] of forgotHistory) {
      const fresh = history.filter((t) => t > cutoff);
      if (fresh.length === 0) forgotHistory.delete(key);
      else forgotHistory.set(key, fresh);
    }
  }, FORGOT_WINDOW_MS).unref();
}

export function _consumeForgotQuotaForTests(emailNorm: string): boolean {
  return consumeForgotQuota(emailNorm);
}

function consumeForgotQuota(emailNorm: string): boolean {
  startForgotSweeper();
  const now = Date.now();
  const cutoff = now - FORGOT_WINDOW_MS;
  const history = (forgotHistory.get(emailNorm) ?? []).filter((t) => t > cutoff);
  if (history.length >= FORGOT_MAX_PER_WINDOW) {
    // Still write back the filtered history so the sweeper's window stays
    // accurate even while the email is rate-limited.
    forgotHistory.set(emailNorm, history);
    return false;
  }
  history.push(now);
  forgotHistory.set(emailNorm, history);
  return true;
}

// Test-only: reset the per-email quota between tests.
export function _resetForgotQuotaForTests(): void {
  forgotHistory.clear();
}

// Reset URL base. Prefers PUBLIC_BASE_URL (set this on prod behind Nginx
// so the link is always https://your-domain regardless of which Host
// header the request came in with). Falls back to req.protocol + Host
// when unset — works for local dev. `trust proxy = 1` in index.ts makes
// req.protocol respect X-Forwarded-Proto.
function buildResetUrl(req: Request, rawToken: string): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (base) return `${base}/reset-password?token=${rawToken}`;
  return `${req.protocol}://${req.get("host")}/reset-password?token=${rawToken}`;
}

export function createAuthRouter(): Router {
  const router = Router();

  // POST /auth/login — { email, password } → sets session.userId
  router.post("/login", (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    // Runtime type guard — req.body is a cast, not validated. Without
    // this a request like {"email": {}} reaches authenticate() and
    // crashes inside email.toLowerCase(). No regex check on purpose:
    // login must accept any email that was accepted at signup, even
    // after EMAIL_RE was tightened. authenticate() returns null for
    // unknown emails anyway, producing the same 401.
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password
    ) {
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
    req.session.pwVersion = user.pwVersion;
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
    // getAuthenticatedUser handles the "no session" case AND drops the
    // session if a password reset has bumped pw_version since this session
    // was minted. Either way the client sees authenticated: false and
    // can re-prompt for login.
    const user = getAuthenticatedUser(req);
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
      token?: unknown;
      email?: unknown;
      password?: unknown;
    };
    if (
      typeof token !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !token ||
      !email ||
      !password
    ) {
      res
        .status(400)
        .json({ error: "token, email and password are required" });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
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
    req.session.pwVersion = result.user.pwVersion;
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

  // POST /auth/forgot-password — { email } → 200 always (no enumeration).
  // If the email maps to a real user, mints a reset token, persists its
  // sha256, and sends the raw token via Postmark. The 5/min/IP cap on the
  // /auth router covers brute force; failures (Postmark errors, missing
  // user) are logged server-side but invisible to the caller.
  router.post("/forgot-password", async (req, res) => {
    const { email } = req.body as { email?: unknown };
    if (typeof email !== "string" || !email) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    const generic = { ok: true };
    // Same shape regardless of outcome — never tell the client whether
    // the email existed, whether Postmark accepted it, or whether the
    // address was malformed past basic type checks.
    if (!isValidEmail(email)) {
      res.json(generic);
      return;
    }
    const emailNorm = email.toLowerCase();
    // Per-email cap, applied BEFORE the user lookup so timing + response
    // are identical for registered, unregistered, and rate-limited emails.
    if (!consumeForgotQuota(emailNorm)) {
      res.json(generic);
      return;
    }
    const userRow = findUserByEmail(emailNorm);
    if (!userRow) {
      res.json(generic);
      return;
    }
    try {
      const { rawToken } = createPasswordResetToken(userRow.id);
      const url = buildResetUrl(req, rawToken);
      // Fire and await so a Postmark outage shows up in logs synchronously
      // with the request, but the client always sees the same response.
      await sendPasswordResetEmail(userRow.email, url);
    } catch (err) {
      console.error("[forgot-password] internal error:", err);
    }
    res.json(generic);
  });

  // GET /auth/reset-password/check?token=... — does this token still let
  // the user set a password? Returns { valid: bool } only, no email.
  router.get("/reset-password/check", (req, res) => {
    const token = req.query.token;
    if (typeof token !== "string") {
      res.json({ valid: false });
      return;
    }
    res.json({ valid: isPasswordResetTokenValid(token) });
  });

  // POST /auth/reset-password — { token, password } → consumes the
  // token atomically (single-use) and updates password_hash. Does NOT
  // log the user in — they get bounced back to the login form so they
  // confirm the new password works.
  router.post("/reset-password", (req, res) => {
    const { token, password } = req.body as {
      token?: unknown;
      password?: unknown;
    };
    if (
      typeof token !== "string" ||
      typeof password !== "string" ||
      !token ||
      !password
    ) {
      res.status(400).json({ error: "token and password are required" });
      return;
    }
    if (password.length < 8) {
      res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
      return;
    }
    const result = consumePasswordResetToken(token, password);
    if (!result.ok) {
      res
        .status(400)
        .json({ error: "This reset link has expired or already been used." });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
