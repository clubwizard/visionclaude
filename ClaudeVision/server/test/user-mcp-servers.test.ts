import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  validateMcpUrl,
  createUserMcpServer,
  listUserMcpServers,
  getUserMcpServer,
  getUserMcpServerAuth,
  setUserMcpServerEnabled,
  deleteUserMcpServer,
  markUserMcpServerUsed,
} from "../src/user-mcp-servers.js";
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
  db.exec("DELETE FROM user_mcp_servers; DELETE FROM users;");
});

describe("validateMcpUrl", () => {
  it("accepts plain https URLs", () => {
    const r = validateMcpUrl("https://mcp.example.com/sse");
    expect(r.ok).toBe(true);
  });

  it("rejects http://", () => {
    const r = validateMcpUrl("http://mcp.example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/i);
  });

  it("rejects loopback and private addresses (SSRF guard)", () => {
    expect(validateMcpUrl("https://localhost/x").ok).toBe(false);
    expect(validateMcpUrl("https://127.0.0.1/x").ok).toBe(false);
    expect(validateMcpUrl("https://10.0.0.1/x").ok).toBe(false);
    expect(validateMcpUrl("https://192.168.1.1/x").ok).toBe(false);
    expect(validateMcpUrl("https://172.16.0.1/x").ok).toBe(false);
    expect(validateMcpUrl("https://169.254.169.254/x").ok).toBe(false); // GCP metadata
  });

  it("rejects garbage / non-strings / oversized", () => {
    expect(validateMcpUrl("").ok).toBe(false);
    expect(validateMcpUrl("not a url").ok).toBe(false);
    expect(validateMcpUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateMcpUrl(null as unknown as string).ok).toBe(false);
    expect(validateMcpUrl("https://" + "a".repeat(3000) + ".com").ok).toBe(false);
  });
});

describe("createUserMcpServer", () => {
  it("creates a server with an auth header that's encrypted at rest", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const server = createUserMcpServer({
      userId: u.id,
      name: "My Notion",
      url: "https://mcp.notion.test/sse",
      authHeader: "Bearer secret-token-123",
    });
    expect(server.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.hasAuth).toBe(true);

    // Verify the raw row in the DB does NOT contain plaintext
    const db = getDb();
    const row = db.prepare("SELECT auth_header_enc FROM user_mcp_servers WHERE id = ?").get(server.id) as { auth_header_enc: string };
    expect(row.auth_header_enc).not.toContain("Bearer secret-token-123");
    expect(row.auth_header_enc).toMatch(/^gcm\$/);

    // But the decrypted accessor returns the original
    expect(getUserMcpServerAuth(u.id, server.id)).toBe("Bearer secret-token-123");
  });

  it("creates a server without auth (hasAuth: false)", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const server = createUserMcpServer({
      userId: u.id,
      name: "Public MCP",
      url: "https://mcp.public.test/sse",
    });
    expect(server.hasAuth).toBe(false);
    expect(getUserMcpServerAuth(u.id, server.id)).toBeNull();
  });

  it("rejects invalid URLs at write time", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    expect(() =>
      createUserMcpServer({ userId: u.id, name: "n", url: "http://x.com" })
    ).toThrow(/https/i);
    expect(() =>
      createUserMcpServer({ userId: u.id, name: "n", url: "https://localhost/" })
    ).toThrow();
  });

  it("rejects empty / oversized names", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    expect(() =>
      createUserMcpServer({ userId: u.id, name: "", url: "https://x.com" })
    ).toThrow();
    expect(() =>
      createUserMcpServer({
        userId: u.id,
        name: "x".repeat(100),
        url: "https://x.com",
      })
    ).toThrow();
  });
});

describe("listUserMcpServers", () => {
  it("returns only the requesting user's servers (isolation)", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    createUserMcpServer({ userId: a.id, name: "A1", url: "https://a1.com" });
    createUserMcpServer({ userId: a.id, name: "A2", url: "https://a2.com" });
    createUserMcpServer({ userId: b.id, name: "B1", url: "https://b1.com" });

    const aList = listUserMcpServers(a.id);
    const bList = listUserMcpServers(b.id);
    expect(aList.map(s => s.name).sort()).toEqual(["A1", "A2"]);
    expect(bList.map(s => s.name)).toEqual(["B1"]);
  });

  it("returns empty array for a user with no servers", () => {
    const u = createUser({ email: "z@x.co", password: "longenough" });
    expect(listUserMcpServers(u.id)).toEqual([]);
  });
});

describe("getUserMcpServer / getUserMcpServerAuth — cross-user lookups blocked", () => {
  it("a user can't fetch another user's server even with the right id", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    const server = createUserMcpServer({
      userId: a.id,
      name: "A's secret",
      url: "https://a.com",
      authHeader: "Bearer A-token",
    });

    // Right user → fine
    expect(getUserMcpServer(a.id, server.id)).not.toBeNull();
    expect(getUserMcpServerAuth(a.id, server.id)).toBe("Bearer A-token");

    // Wrong user with the same id → null (not an error, not a leak)
    expect(getUserMcpServer(b.id, server.id)).toBeNull();
    expect(getUserMcpServerAuth(b.id, server.id)).toBeNull();
  });
});

describe("setUserMcpServerEnabled / deleteUserMcpServer", () => {
  it("toggling enabled is reflected in subsequent reads", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const server = createUserMcpServer({
      userId: u.id,
      name: "n",
      url: "https://x.com",
    });
    expect(server.enabled).toBe(true);
    expect(setUserMcpServerEnabled(u.id, server.id, false)).toBe(true);
    expect(getUserMcpServer(u.id, server.id)?.enabled).toBe(false);
  });

  it("delete + list confirms removal; auth is also gone", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const server = createUserMcpServer({
      userId: u.id,
      name: "n",
      url: "https://x.com",
      authHeader: "Bearer t",
    });
    expect(deleteUserMcpServer(u.id, server.id)).toBe(true);
    expect(getUserMcpServer(u.id, server.id)).toBeNull();
    expect(getUserMcpServerAuth(u.id, server.id)).toBeNull();
    expect(listUserMcpServers(u.id)).toEqual([]);
  });

  it("cross-user delete / toggle is a no-op (returns false)", () => {
    const a = createUser({ email: "a@b.co", password: "longenough" });
    const b = createUser({ email: "b@c.co", password: "longenough" });
    const server = createUserMcpServer({ userId: a.id, name: "n", url: "https://x.com" });
    expect(deleteUserMcpServer(b.id, server.id)).toBe(false);
    expect(setUserMcpServerEnabled(b.id, server.id, false)).toBe(false);
    // A's server is untouched
    expect(getUserMcpServer(a.id, server.id)?.enabled).toBe(true);
  });

  it("deleting a user cascades to their MCP servers", () => {
    const u = createUser({ email: "doomed@x.co", password: "longenough" });
    createUserMcpServer({ userId: u.id, name: "n", url: "https://x.com" });
    const db = getDb();
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    // ON DELETE CASCADE should have wiped the servers row.
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM user_mcp_servers WHERE user_id = ?")
      .get(u.id) as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe("markUserMcpServerUsed", () => {
  it("updates last_used_at without throwing on a missing row", () => {
    const u = createUser({ email: "a@b.co", password: "longenough" });
    const server = createUserMcpServer({ userId: u.id, name: "n", url: "https://x.com" });
    expect(getUserMcpServer(u.id, server.id)?.lastUsedAt).toBeNull();
    markUserMcpServerUsed(u.id, server.id);
    expect(getUserMcpServer(u.id, server.id)?.lastUsedAt).toBeGreaterThan(0);
    // Doesn't throw on unknown ids
    expect(() => markUserMcpServerUsed(u.id, "no-such-id")).not.toThrow();
  });
});
