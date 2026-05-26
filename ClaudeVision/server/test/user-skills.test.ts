import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  createUserSkill,
  listUserSkills,
  getUserSkill,
  updateUserSkill,
  deleteUserSkill,
  buildUserSkillsAppendix,
} from "../src/user-skills.js";
import { createUser } from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM user_skills; DELETE FROM users;");
});

describe("createUserSkill", () => {
  it("creates a skill with the provided fields", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const s = createUserSkill({
      userId: u.id,
      name: "Recipe converter",
      description: "Convert cooking measurements to grams",
      trigger: "convert, grams, weight",
      body: "Always convert to grams when the user mentions cooking quantities.",
    });
    expect(s.name).toBe("Recipe converter");
    expect(s.description).toMatch(/Convert/);
    expect(s.trigger).toBe("convert, grams, weight");
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it("trims whitespace and rejects empty required fields", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    expect(() =>
      createUserSkill({ userId: u.id, name: "  ", description: "x", body: "y" })
    ).toThrow(/name/);
    expect(() =>
      createUserSkill({ userId: u.id, name: "x", description: "", body: "y" })
    ).toThrow(/description/);
    expect(() =>
      createUserSkill({ userId: u.id, name: "x", description: "x", body: "  " })
    ).toThrow(/body/);
  });

  it("enforces length bounds (name 64, description 280, body 8KB)", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    expect(() =>
      createUserSkill({
        userId: u.id,
        name: "x".repeat(65),
        description: "ok",
        body: "ok",
      })
    ).toThrow();
    expect(() =>
      createUserSkill({
        userId: u.id,
        name: "ok",
        description: "x".repeat(281),
        body: "ok",
      })
    ).toThrow();
    expect(() =>
      createUserSkill({
        userId: u.id,
        name: "ok",
        description: "ok",
        body: "x".repeat(8 * 1024 + 1),
      })
    ).toThrow();
  });

  it("trigger is optional", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const s = createUserSkill({
      userId: u.id,
      name: "no-trigger",
      description: "always advertised, never auto-injected",
      body: "...",
    });
    expect(s.trigger).toBe("");
  });
});

describe("listUserSkills / getUserSkill — isolation", () => {
  it("returns only the requesting user's skills", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    createUserSkill({ userId: a.id, name: "A1", description: "x", body: "y" });
    createUserSkill({ userId: a.id, name: "A2", description: "x", body: "y" });
    createUserSkill({ userId: b.id, name: "B1", description: "x", body: "y" });

    const aList = listUserSkills(a.id);
    expect(aList.map(s => s.name).sort()).toEqual(["A1", "A2"]);
    expect(listUserSkills(b.id).map(s => s.name)).toEqual(["B1"]);
  });

  it("a user can't fetch another user's skill by id", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    const s = createUserSkill({ userId: a.id, name: "A", description: "x", body: "y" });
    expect(getUserSkill(a.id, s.id)).not.toBeNull();
    expect(getUserSkill(b.id, s.id)).toBeNull();
  });
});

describe("updateUserSkill", () => {
  it("updates only the supplied fields, bumps updated_at", async () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const s = createUserSkill({
      userId: u.id,
      name: "old name",
      description: "old desc",
      trigger: "old, words",
      body: "old body",
    });
    await new Promise(r => setTimeout(r, 5)); // ensure clock advances
    const updated = updateUserSkill(u.id, s.id, { description: "new desc" });
    expect(updated?.name).toBe("old name");        // unchanged
    expect(updated?.description).toBe("new desc"); // changed
    expect(updated?.body).toBe("old body");        // unchanged
    expect(updated?.updatedAt).toBeGreaterThan(s.updatedAt);
  });

  it("can toggle enabled without touching other fields", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const s = createUserSkill({ userId: u.id, name: "x", description: "y", body: "z" });
    const updated = updateUserSkill(u.id, s.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("x");
  });

  it("returns null for cross-user or unknown ids", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    const s = createUserSkill({ userId: a.id, name: "x", description: "y", body: "z" });
    expect(updateUserSkill(b.id, s.id, { enabled: false })).toBeNull();
    expect(updateUserSkill(a.id, "no-such-id", { enabled: false })).toBeNull();
  });
});

describe("deleteUserSkill", () => {
  it("removes the row; cross-user delete is a no-op", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    const s = createUserSkill({ userId: a.id, name: "x", description: "y", body: "z" });
    expect(deleteUserSkill(b.id, s.id)).toBe(false);
    expect(deleteUserSkill(a.id, s.id)).toBe(true);
    expect(getUserSkill(a.id, s.id)).toBeNull();
  });

  it("cascades when the user is deleted", () => {
    const u = createUser({ email: "doomed@x.co", password: "longenough" });
    createUserSkill({ userId: u.id, name: "x", description: "y", body: "z" });
    const db = getDb();
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM user_skills WHERE user_id = ?")
      .get(u.id) as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe("buildUserSkillsAppendix", () => {
  it("returns empty string when the user has no enabled skills", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    expect(buildUserSkillsAppendix(u.id, "anything")).toBe("");
    // Disabled skill is still empty
    const s = createUserSkill({ userId: u.id, name: "x", description: "y", body: "z" });
    updateUserSkill(u.id, s.id, { enabled: false });
    expect(buildUserSkillsAppendix(u.id, "anything")).toBe("");
  });

  it("advertises every enabled skill in the description list", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    createUserSkill({ userId: u.id, name: "Alpha", description: "first thing", body: "abody" });
    createUserSkill({ userId: u.id, name: "Beta",  description: "second thing", body: "bbody" });
    const out = buildUserSkillsAppendix(u.id, "unrelated message");
    expect(out).toContain("Alpha");
    expect(out).toContain("first thing");
    expect(out).toContain("Beta");
    expect(out).toContain("second thing");
  });

  it("inlines the body ONLY for skills whose trigger keywords match the message", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    createUserSkill({
      userId: u.id,
      name: "Cook",
      description: "recipe helper",
      trigger: "recipe, ingredients, grams",
      body: "BODY_COOK_INLINED",
    });
    createUserSkill({
      userId: u.id,
      name: "Translate",
      description: "language helper",
      trigger: "translate, in spanish",
      body: "BODY_TRANSLATE_INLINED",
    });

    const cookHit = buildUserSkillsAppendix(u.id, "Convert 2 cups of flour to grams please");
    expect(cookHit).toContain("BODY_COOK_INLINED");
    expect(cookHit).not.toContain("BODY_TRANSLATE_INLINED");

    const translateHit = buildUserSkillsAppendix(u.id, "Translate this menu");
    expect(translateHit).toContain("BODY_TRANSLATE_INLINED");
    expect(translateHit).not.toContain("BODY_COOK_INLINED");

    // Neither matches → both descriptions present, neither body inlined.
    const nothing = buildUserSkillsAppendix(u.id, "what's the weather");
    expect(nothing).not.toContain("BODY_COOK_INLINED");
    expect(nothing).not.toContain("BODY_TRANSLATE_INLINED");
    expect(nothing).toContain("Cook");
    expect(nothing).toContain("Translate");
  });

  it("matches triggers case-insensitively", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    createUserSkill({
      userId: u.id,
      name: "Cook",
      description: "x",
      trigger: "GRAMS",
      body: "MATCHED_BODY",
    });
    expect(buildUserSkillsAppendix(u.id, "convert to grams")).toContain("MATCHED_BODY");
    expect(buildUserSkillsAppendix(u.id, "convert to GRAMS")).toContain("MATCHED_BODY");
  });

  it("a skill with no trigger is advertised but never auto-injected", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    createUserSkill({
      userId: u.id,
      name: "Always available",
      description: "ambient skill",
      body: "AMBIENT_BODY",
    });
    const out = buildUserSkillsAppendix(u.id, "any message");
    expect(out).toContain("Always available");
    expect(out).not.toContain("AMBIENT_BODY");
  });
});
