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

function fakeReq(session: Partial<{ userId: string; isAdmin: boolean }>): Request {
  return { session: { ...session } } as unknown as Request;
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

  it("passes through with a session userId", () => {
    const res = fakeRes();
    const { next, called } = runNext();
    requireAuth(fakeReq({ userId: "anything" }), res as unknown as Response, next);
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
