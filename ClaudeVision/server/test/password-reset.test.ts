import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  createUser,
  authenticate,
  createPasswordResetToken,
  consumePasswordResetToken,
  isPasswordResetTokenValid,
} from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM password_resets; DELETE FROM users;");
});

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("createPasswordResetToken", () => {
  it("returns a long hex token and stores only its sha256", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const { rawToken, expiresAt } = createPasswordResetToken(user.id);

    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThan(Date.now() + 60 * 60 * 1000 + 5_000);

    const db = getDb();
    const row = db
      .prepare("SELECT token_hash, user_id FROM password_resets WHERE user_id = ?")
      .get(user.id) as { token_hash: string; user_id: string };
    expect(row.token_hash).toBe(sha256(rawToken));
    expect(row.token_hash).not.toBe(rawToken);
  });

  it("garbage-collects expired tokens on insert", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const db = getDb();
    // Insert a fake expired row directly.
    db.prepare(
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run("deadbeef", user.id, 1, 2);
    expect(db.prepare("SELECT COUNT(*) AS c FROM password_resets").get()).toMatchObject({ c: 1 });

    createPasswordResetToken(user.id);
    const rows = db.prepare("SELECT token_hash FROM password_resets ORDER BY expires_at").all() as Array<{ token_hash: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe("deadbeef");
  });
});

describe("consumePasswordResetToken", () => {
  it("updates the password and invalidates the token after use", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const { rawToken } = createPasswordResetToken(user.id);

    const r = consumePasswordResetToken(rawToken, "brandNewPW456");
    expect(r).toEqual({ ok: true, userId: user.id });

    // Old password no longer works
    expect(authenticate("a@b.co", "originalPW123")).toBeNull();
    // New password does
    const reauth = authenticate("a@b.co", "brandNewPW456");
    expect(reauth).not.toBeNull();
    expect(reauth?.id).toBe(user.id);

    // Token cannot be replayed
    const replay = consumePasswordResetToken(rawToken, "thirdPassword789");
    expect(replay).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects an unknown token without leaking timing differences", () => {
    expect(consumePasswordResetToken("not-a-real-token", "anyPassword12")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(consumePasswordResetToken("", "anyPassword12")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("rejects expired tokens", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const { rawToken } = createPasswordResetToken(user.id);
    // Backdate the row so expires_at is in the past
    const db = getDb();
    db.prepare(
      "UPDATE password_resets SET expires_at = 1 WHERE user_id = ?"
    ).run(user.id);

    const r = consumePasswordResetToken(rawToken, "brandNewPW456");
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
    // Password unchanged
    expect(authenticate("a@b.co", "originalPW123")).not.toBeNull();
  });

  it("invalidates every other outstanding reset for that user on success", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const t1 = createPasswordResetToken(user.id).rawToken;
    const t2 = createPasswordResetToken(user.id).rawToken;
    const t3 = createPasswordResetToken(user.id).rawToken;

    // Consume the second one — the first and third must die too.
    expect(consumePasswordResetToken(t2, "brandNewPW456").ok).toBe(true);
    expect(consumePasswordResetToken(t1, "anotherPW789")).toEqual({ ok: false, reason: "invalid_token" });
    expect(consumePasswordResetToken(t3, "anotherPW789")).toEqual({ ok: false, reason: "invalid_token" });

    // And the user's password is the one set by the t2 redemption.
    expect(authenticate("a@b.co", "brandNewPW456")).not.toBeNull();
    expect(authenticate("a@b.co", "anotherPW789")).toBeNull();
  });
});

describe("isPasswordResetTokenValid", () => {
  it("returns true for a freshly minted token and false after consumption", () => {
    const user = createUser({ email: "a@b.co", password: "originalPW123" });
    const { rawToken } = createPasswordResetToken(user.id);
    expect(isPasswordResetTokenValid(rawToken)).toBe(true);
    consumePasswordResetToken(rawToken, "brandNewPW456");
    expect(isPasswordResetTokenValid(rawToken)).toBe(false);
  });

  it("returns false for unknown / empty / non-string input", () => {
    expect(isPasswordResetTokenValid("does-not-exist")).toBe(false);
    expect(isPasswordResetTokenValid("")).toBe(false);
    expect(isPasswordResetTokenValid(undefined as unknown as string)).toBe(false);
  });
});
