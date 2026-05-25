import type { Request, Response, NextFunction } from "express";
import { c } from "./console-theme.js";
import { findUserById } from "./users.js";
import type { User } from "./users.js";

// Extend express-session with our custom fields
declare module "express-session" {
  interface SessionData {
    userId?: string;
    isAdmin?: boolean;
    // Snapshot of users.pw_version at the moment this session was minted.
    // On every authenticated request we re-read the live value; a mismatch
    // (caused by a password reset on this or another device) destroys the
    // session.
    pwVersion?: number;
  }
}

// Loads the session user and validates that the cached pw_version still
// matches the live one. Returns null if there's no session, the user has
// been deleted, or a password reset has happened since this session was
// minted — in the latter two cases it also destroys the session so the
// client's cookie stops working.
//
// Versions default to 1 on both sides, so sessions minted before this
// field existed don't get force-logged-out on deploy — they only become
// invalid after the next reset bumps the live counter past 1.
export function getAuthenticatedUser(req: Request): User | null {
  if (!req.session?.userId) return null;
  const user = findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return null;
  }
  const sessionVersion = req.session.pwVersion ?? 1;
  const userVersion = user.pwVersion ?? 1;
  if (sessionVersion !== userVersion) {
    req.session.destroy(() => {});
    return null;
  }
  return user;
}

// ── Gateway Auth Middleware ──────────────────────────────────────────
// Optional API key auth. If GATEWAY_API_KEY is set in .env, all
// non-health endpoints require it via X-Gateway-Key header.
// If not set, all requests are allowed (localhost-only use).

export function gatewayAuth() {
  const gatewayKey = process.env.GATEWAY_API_KEY || "";

  return (req: Request, res: Response, next: NextFunction): void => {
    // Health endpoint is always public
    if (req.path === "/health" || req.path === "/") {
      next();
      return;
    }

    // If no key configured, allow all (localhost mode)
    if (!gatewayKey) {
      next();
      return;
    }

    // Check header
    const provided = req.headers["x-gateway-key"] as string;
    if (provided === gatewayKey) {
      next();
      return;
    }

    console.log(
      c.warn(`[Auth] Rejected request to ${req.path} — invalid or missing X-Gateway-Key`)
    );
    res.status(401).json({ error: "Unauthorized — provide X-Gateway-Key header" });
  };
}

// ── Rate Limiter / Request Queue ─────────────────────────────────────

export class RequestQueue {
  private queue: Array<{
    execute: () => Promise<void>;
    resolve: () => void;
  }> = [];
  private maxConcurrent: number;
  private activeCount = 0;

  constructor(maxConcurrent: number = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };

      this.queue.push({
        execute,
        resolve: () => {},
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent) return;
    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    try {
      await item.execute();
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.activeCount;
  }
}

// ── Simple Rate Limiter ──────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function rateLimiter(
  maxRequests: number = 30,
  windowMs: number = 60_000
) {
  const clients = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (now > entry.resetAt) clients.delete(key);
    }
  }, windowMs);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health" || req.path === "/") {
      next();
      return;
    }

    // Per-user limits when authenticated, otherwise per-IP.
    const key = req.session?.userId
      ? `u:${req.session.userId}`
      : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const now = Date.now();
    let entry = clients.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(key, entry);
    }

    entry.count++;

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      console.log(c.warn(`[RateLimit] ${key} exceeded ${maxRequests} req/${windowMs / 1000}s`));
      res.status(429).json({
        error: "Too many requests — try again later",
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}

// ── Session Auth Middleware ──────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (getAuthenticatedUser(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized — please log in" });
}

// ── Combined: session or gateway key ─────────────────────────────────
// Used by /chat — accepts either a logged-in user or a native client
// bearing the X-Gateway-Key header. The gateway-key path bypasses user
// scoping and uses env-var API keys (operator-managed shared use).

export function requireAnyAuth(req: Request, res: Response, next: NextFunction): void {
  // Prefer the session path so /chat sees req.session.userId and can scope
  // per-user. getAuthenticatedUser also destroys stale sessions (deleted
  // user / bumped pw_version), so a revoked session falls through to the
  // gateway-key check instead of being silently honoured.
  if (getAuthenticatedUser(req)) {
    next();
    return;
  }
  const gatewayKey = process.env.GATEWAY_API_KEY || "";
  if (gatewayKey && req.headers["x-gateway-key"] === gatewayKey) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ── Admin Auth Middleware ────────────────────────────────────────────

// Re-queries the DB on every admin request so revoked admin sessions are
// rejected immediately rather than waiting for the 24-hour cookie to expire.
// Also runs the password-version check via getAuthenticatedUser so a stale
// admin session (post-reset) is dropped instead of treated as admin.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = getAuthenticatedUser(req);
  if (!user?.isAdmin) {
    if (req.session) req.session.isAdmin = false;
    res.status(403).json({ error: "Admin only" });
    return;
  }
  next();
}
