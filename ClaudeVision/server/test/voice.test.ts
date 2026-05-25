import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import session from "express-session";
import request from "supertest";
import { createVoiceRouter } from "../src/routes/voice.js";
import { createUser, setUserApiKey } from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";

// Minimal app to mount the voice router with a fake session.
// The router needs a logged-in user (or env-var fallback) to surface
// voices, so we install a tiny middleware that injects req.session.
function buildApp(opts: {
  userId?: string;
  isAdmin?: boolean;
  envDeepgram?: string;
  envOpenAI?: string;
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "sid",
      secret: "test-secret-test-secret-test-secret-test-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, sameSite: "lax" },
    })
  );
  app.use((req, _res, next) => {
    if (opts.userId) {
      req.session.userId = opts.userId;
      req.session.isAdmin = opts.isAdmin ?? false;
    }
    next();
  });
  // resolveProviderKey reads env vars directly, so set them per-test
  process.env.DEEPGRAM_API_KEY = opts.envDeepgram ?? "";
  process.env.OPENAI_API_KEY = opts.envOpenAI ?? "";
  app.use("/voice", createVoiceRouter());
  return app;
}

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM users;");
  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

describe("GET /voice/list", () => {
  it("returns no providers when no keys are configured anywhere", async () => {
    const app = buildApp({});
    const res = await request(app).get("/voice/list");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.groups).toEqual([]);
    expect(res.body.default).toBeNull();
  });

  it("returns ONLY Deepgram voices when only a Deepgram key is set", async () => {
    const u = createUser({ email: "dg@x.com", password: "longenough" });
    setUserApiKey(u.id, "deepgram", "dg-key-123");
    const app = buildApp({ userId: u.id });

    const res = await request(app).get("/voice/list");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].provider).toBe("deepgram");
    expect(res.body.default).toBe("aura-2-thalia-en");
  });

  it("returns ONLY Aura-2 voices (Aura-1 has been removed)", async () => {
    const u = createUser({ email: "dg@x.com", password: "longenough" });
    setUserApiKey(u.id, "deepgram", "dg-key-123");
    const app = buildApp({ userId: u.id });

    const res = await request(app).get("/voice/list");
    const dgVoices = res.body.groups[0].voices as Array<{ id: string }>;
    // Every Deepgram voice ID must start with "aura-2-" — no bare "aura-..." (Aura-1).
    for (const v of dgVoices) {
      expect(v.id).toMatch(/^aura-2-/);
    }
    // And specifically, none of the old Aura-1 IDs should appear.
    const ids = new Set(dgVoices.map(v => v.id));
    for (const legacy of [
      "aura-asteria-en", "aura-luna-en", "aura-stella-en", "aura-athena-en",
      "aura-orion-en", "aura-zeus-en", "aura-perseus-en",
    ]) {
      expect(ids.has(legacy)).toBe(false);
    }
  });

  it("returns ONLY OpenAI voices when only an OpenAI key is set", async () => {
    const u = createUser({ email: "oa@x.com", password: "longenough" });
    setUserApiKey(u.id, "openai", "sk-test-123");
    const app = buildApp({ userId: u.id });

    const res = await request(app).get("/voice/list");
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].provider).toBe("openai");
    // Default falls back to an OpenAI voice when no Deepgram is available.
    expect(res.body.default).toBe("openai-alloy");
  });

  it("returns BOTH groups when both per-user keys are set", async () => {
    const u = createUser({ email: "both@x.com", password: "longenough" });
    setUserApiKey(u.id, "deepgram", "dg-key");
    setUserApiKey(u.id, "openai", "sk-key");
    const app = buildApp({ userId: u.id });

    const res = await request(app).get("/voice/list");
    expect(res.body.groups).toHaveLength(2);
    const providers = res.body.groups.map((g: { provider: string }) => g.provider);
    expect(providers).toContain("deepgram");
    expect(providers).toContain("openai");
    // Deepgram is the preferred default when present
    expect(res.body.default).toBe("aura-2-thalia-en");
  });

  it("falls back to env-var keys ONLY for admin users", async () => {
    const adminUser = createUser({ email: "admin@x.com", password: "longenough", isAdmin: true });
    const regularUser = createUser({ email: "user@x.com", password: "longenough" });

    // Admin should see env-provided voices
    const adminApp = buildApp({
      userId: adminUser.id,
      isAdmin: true,
      envDeepgram: "env-dg",
    });
    const adminRes = await request(adminApp).get("/voice/list");
    expect(adminRes.body.groups).toHaveLength(1);
    expect(adminRes.body.groups[0].provider).toBe("deepgram");

    // Regular user with no own key + env set should see nothing
    const userApp = buildApp({
      userId: regularUser.id,
      isAdmin: false,
      envDeepgram: "env-dg",
    });
    const userRes = await request(userApp).get("/voice/list");
    expect(userRes.body.configured).toBe(false);
    expect(userRes.body.groups).toEqual([]);
  });
});
