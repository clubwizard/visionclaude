import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  isValidEmail,
  createUser,
  authenticate,
  signupWithInvite,
  createInvite,
  findUserByEmail,
  findUserById,
  countUsers,
  incrementUsage,
  setUserApiKey,
  getUserApiKey,
  getUserKeyStatus,
} from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";

beforeAll(() => {
  getDb(); // run migrations
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  // Clean state for every test
  const db = getDb();
  db.exec("DELETE FROM invites; DELETE FROM users;");
});

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("alice.smith+tag@example.com")).toBe(true);
  });

  it("rejects injections and malformed input", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false); // no TLD
    expect(isValidEmail("a@.com")).toBe(false);
    expect(isValidEmail("><script>alert(1)</script>@x.com")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false); // space
  });

  it("rejects oversized input (DoS guard)", () => {
    const long = "a".repeat(250) + "@b.co";
    expect(isValidEmail(long)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidEmail(null as unknown as string)).toBe(false);
    expect(isValidEmail(undefined as unknown as string)).toBe(false);
  });
});

describe("createUser + authenticate", () => {
  it("creates a user that can log back in", () => {
    const u = createUser({ email: "Alice@Example.com", password: "hunter2hunter2" });
    expect(u.email).toBe("alice@example.com"); // normalized
    const authed = authenticate("alice@example.com", "hunter2hunter2");
    expect(authed?.id).toBe(u.id);
  });

  it("rejects an invalid email at the model layer", () => {
    expect(() => createUser({ email: "nope", password: "longenough" })).toThrow();
  });

  it("uniqueness — second create with same email throws", () => {
    createUser({ email: "dup@x.com", password: "longenough" });
    expect(() =>
      createUser({ email: "dup@x.com", password: "differentpw" })
    ).toThrow();
  });

  it("authenticate returns null for wrong password", () => {
    createUser({ email: "bob@x.com", password: "rightpassword" });
    expect(authenticate("bob@x.com", "wrongpassword")).toBeNull();
    expect(authenticate("ghost@x.com", "anything")).toBeNull();
  });
});

describe("signupWithInvite — atomicity", () => {
  function newInvite(adminId: string) {
    return createInvite(adminId).token;
  }

  it("succeeds with a valid token and creates the user", () => {
    const admin = createUser({ email: "admin@x.com", password: "longenough", isAdmin: true });
    const token = newInvite(admin.id);
    const r = signupWithInvite(token, "invitee@x.com", "longenough");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.email).toBe("invitee@x.com");
  });

  it("invalid token — no user is created (TOCTOU guard)", () => {
    const before = countUsers();
    const r = signupWithInvite("not-a-real-token", "ghost@x.com", "longenough");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_invite");
    expect(countUsers()).toBe(before);
    expect(findUserByEmail("ghost@x.com")).toBeNull();
  });

  it("invalid email — no user is created, no invite consumed", () => {
    const admin = createUser({ email: "admin@x.com", password: "longenough", isAdmin: true });
    const token = newInvite(admin.id);
    const before = countUsers();
    const r = signupWithInvite(token, "><script>@x.com", "longenough");
    expect(r.ok).toBe(false);
    expect(countUsers()).toBe(before);
    // Token still usable
    const r2 = signupWithInvite(token, "real@x.com", "longenough");
    expect(r2.ok).toBe(true);
  });

  it("same token cannot be reused after success (race guard)", () => {
    const admin = createUser({ email: "admin@x.com", password: "longenough", isAdmin: true });
    const token = newInvite(admin.id);
    const r1 = signupWithInvite(token, "first@x.com", "longenough");
    expect(r1.ok).toBe(true);
    const r2 = signupWithInvite(token, "second@x.com", "longenough");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("invalid_invite");
  });

  it("duplicate email — invite is NOT consumed (rolled back), user count unchanged", () => {
    const admin = createUser({ email: "admin@x.com", password: "longenough", isAdmin: true });
    createUser({ email: "taken@x.com", password: "longenough" });
    const token = newInvite(admin.id);
    const before = countUsers();
    const r = signupWithInvite(token, "taken@x.com", "longenough");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("email_taken");
    expect(countUsers()).toBe(before);
    // Token still usable
    const r2 = signupWithInvite(token, "fresh@x.com", "longenough");
    expect(r2.ok).toBe(true);
  });
});

describe("incrementUsage", () => {
  it("bumps counters and last_used_at", () => {
    const u = createUser({ email: "u@x.com", password: "longenough" });
    expect(u.requestCount).toBe(0);
    expect(u.inputTokens).toBe(0);

    incrementUsage(u.id, 100, 50);
    incrementUsage(u.id, 200, 75);
    const fresh = findUserById(u.id)!;
    expect(fresh.requestCount).toBe(2);
    expect(fresh.inputTokens).toBe(300);
    expect(fresh.outputTokens).toBe(125);
    expect(fresh.lastUsedAt).toBeTypeOf("number");
    expect(fresh.lastUsedAt!).toBeGreaterThan(Date.now() - 5_000);
  });

  it("silently no-ops for unknown user (never throws into request path)", () => {
    expect(() => incrementUsage("not-a-real-id", 100, 50)).not.toThrow();
  });
});

describe("API key storage (encrypted at rest)", () => {
  it("round-trips a key per user", () => {
    const a = createUser({ email: "a@x.com", password: "longenough" });
    const b = createUser({ email: "b@x.com", password: "longenough" });
    setUserApiKey(a.id, "anthropic", "sk-ant-a-secret");
    setUserApiKey(b.id, "anthropic", "sk-ant-b-secret");
    expect(getUserApiKey(a.id, "anthropic")).toBe("sk-ant-a-secret");
    expect(getUserApiKey(b.id, "anthropic")).toBe("sk-ant-b-secret");
  });

  it("status reports set/unset without leaking plaintext", () => {
    const u = createUser({ email: "u@x.com", password: "longenough" });
    expect(getUserKeyStatus(u.id)).toEqual({
      anthropic: "unset",
      deepgram: "unset",
      openai: "unset",
    });
    setUserApiKey(u.id, "openai", "sk-openai-xyz");
    expect(getUserKeyStatus(u.id).openai).toBe("set");
  });

  it("clears a slot when null/empty is passed", () => {
    const u = createUser({ email: "u@x.com", password: "longenough" });
    setUserApiKey(u.id, "anthropic", "sk-ant-1");
    expect(getUserApiKey(u.id, "anthropic")).toBe("sk-ant-1");
    setUserApiKey(u.id, "anthropic", null);
    expect(getUserApiKey(u.id, "anthropic")).toBeNull();
    expect(getUserKeyStatus(u.id).anthropic).toBe("unset");
  });
});
