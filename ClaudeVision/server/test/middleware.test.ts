import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { requireAuth, requireAdmin } from "../src/middleware.js";
import { createUser, setAdminFlag } from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";
import type { Request, Response, NextFunction } from "express";

beforeAll(() => { getDb(); });
afterAll(() => { closeDb(); });
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM invites; DELETE FROM users;");
});

interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}

interface FakeSessionShape {
  userId?: string;
  isAdmin?: boolean;
  pwVersion?: number;
  destroyed?: boolean;
  destroy: (cb?: (err?: Error) => void) => void;
}

function fakeReq(
  init: Partial<{ userId: string; isAdmin: boolean; pwVersion: number }>
): Request {
  const session: FakeSessionShape = {
    ...init,
    destroyed: false,
    destroy(cb) {
      this.destroyed = true;
      cb?.();
    },
  };
  return { session } as unknown as Request;
}

function fakeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; return this; },
  };
  return r;
}

function runNext(): { next: NextFunction; called: () => boolean } {
  let was = false;
  return {
    next: (() => { was = true; }) as NextFunction,
    called: () => was,
  };
}

describe("requireAuth", () => {
  it("blocks anonymous requests with 401", () => {
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(fakeReq({}), res as unknown as Response, next);
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("passes through with a session userId for a live user", () => {
    const u = createUser({ email: "live@x.com", password: "longenough" });
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(
      fakeReq({ userId: u.id, pwVersion: u.pwVersion }),
      res as unknown as Response,
      next
    );
    expect(called()).toBe(true);
  });

  it("blocks (and destroys session of) a deleted user", () => {
    const u = createUser({ email: "ghosted@x.com", password: "longenough" });
    const db = getDb();
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    const req = fakeReq({ userId: u.id, pwVersion: u.pwVersion });
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(req, res as unknown as Response, next);
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((req.session as unknown as FakeSessionShape).destroyed).toBe(true);
  });

  it("blocks (and destroys session of) a stale pw_version", () => {
    const u = createUser({ email: "old-cookie@x.com", password: "longenough" });
    // Bump live version past the cached one (simulates a password reset
    // on another device since this session was minted).
    const db = getDb();
    db.prepare("UPDATE users SET pw_version = pw_version + 1 WHERE id = ?").run(u.id);
    const req = fakeReq({ userId: u.id, pwVersion: u.pwVersion });
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(req, res as unknown as Response, next);
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((req.session as unknown as FakeSessionShape).destroyed).toBe(true);
  });

  it("treats sessions with no cached pwVersion as version 1 (backwards-compat)", () => {
    // Users default to pw_version = 1 at creation, so a legacy session
    // cookie minted before this field existed should still pass.
    const u = createUser({ email: "legacy@x.com", password: "longenough" });
    expect(u.pwVersion).toBe(1);
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(
      fakeReq({ userId: u.id }), // no pwVersion in session
      res as unknown as Response,
      next
    );
    expect(called()).toBe(true);
  });
});

describe("requireAdmin", () => {
  it("blocks non-admins with 403", () => {
    const u = createUser({ email: "user@x.com", password: "longenough" });
    const res = fakeRes();
    const { next, called } = runNext();
    requireAdmin(fakeReq({ userId: u.id }), res as unknown as Response, next);
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("lets admins through", () => {
    const u = createUser({ email: "boss@x.com", password: "longenough", isAdmin: true });
    const res = fakeRes();
    const { next, called } = runNext();
    requireAdmin(fakeReq({ userId: u.id, isAdmin: true }), res as unknown as Response, next);
    expect(called()).toBe(true);
  });

  it("rejects a demoted admin even with stale isAdmin=true on the session (re-queries DB)", () => {
    const u = createUser({ email: "soon-ex@x.com", password: "longenough", isAdmin: true });
    // Demote in the DB without touching the session
    setAdminFlag(u.id, false);
    const res = fakeRes();
    const { next, called } = runNext();
    requireAdmin(
      fakeReq({ userId: u.id, isAdmin: true }), // stale session flag
      res as unknown as Response,
      next
    );
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("blocks deleted users (DB row gone)", () => {
    const u = createUser({ email: "ghost@x.com", password: "longenough", isAdmin: true });
    const db = getDb();
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    const res = fakeRes();
    const { next, called } = runNext();
    requireAdmin(
      fakeReq({ userId: u.id, isAdmin: true }),
      res as unknown as Response,
      next
    );
    expect(called()).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
