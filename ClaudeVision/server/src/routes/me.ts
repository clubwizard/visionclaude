import { Router } from "express";
import {
  findUserById,
  getUserKeyStatus,
  getUserApiKey,
  setUserApiKey,
  type KeySlot,
} from "../users.js";
import {
  createUserMcpServer,
  listUserMcpServers,
  getUserMcpServer,
  getUserMcpServerAuth,
  setUserMcpServerEnabled,
  deleteUserMcpServer,
  validateMcpUrl,
} from "../user-mcp-servers.js";
import { requireAuth } from "../middleware.js";
import type { MCPManager } from "../mcp-manager.js";
import type { SkillLoader } from "../skill-loader.js";

export function createMeRouter(
  mcpManager: MCPManager,
  skillLoader: SkillLoader
): Router {
  const router = Router();
  router.use(requireAuth);

  // Current user info (no keys, just identity + key status)
  router.get("/", (req, res) => {
    const user = findUserById(req.session.userId!);
    if (!user) {
      res.status(404).json({ error: "User no longer exists" });
      return;
    }
    res.json({ user, keys: getUserKeyStatus(user.id) });
  });

  // GET key status only — never returns plaintext
  router.get("/api-keys", (req, res) => {
    res.json({ keys: getUserKeyStatus(req.session.userId!) });
  });

  // PUT key(s) — pass null/empty string to clear a slot
  router.put("/api-keys", (req, res) => {
    const body = req.body as { anthropic?: string | null; deepgram?: string | null; openai?: string | null };
    const userId = req.session.userId!;
    const updates: KeySlot[] = [];
    if (body.anthropic !== undefined) {
      setUserApiKey(userId, "anthropic", body.anthropic ?? null);
      updates.push("anthropic");
    }
    if (body.deepgram !== undefined) {
      setUserApiKey(userId, "deepgram", body.deepgram ?? null);
      updates.push("deepgram");
    }
    if (body.openai !== undefined) {
      setUserApiKey(userId, "openai", body.openai ?? null);
      updates.push("openai");
    }
    res.json({ ok: true, updated: updates, keys: getUserKeyStatus(userId) });
  });

  // GET /me/mcp-info — read-only view of what MCP servers and skills
  // this Gateway has loaded, plus a pointer to the Claude Desktop setup
  // guide. Not sensitive (no auth tokens, no env values) — just the
  // info a user needs to verify their Cowork-connector setup is wired up.
  router.get("/mcp-info", (_req, res) => {
    const servers = mcpManager.getServerStatus(); // [{name, toolCount, type}]
    const skills = skillLoader.getSkillList();    // [{name, description, trigger}]
    const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
    res.json({
      configPath: process.env.MCP_CONFIG_PATH || "(default: ~/Library/Application Support/Claude/claude_desktop_config.json)",
      servers,
      totalTools,
      skills,
      // Static doc URLs — point at the canonical GitHub copies so they
      // stay live even on a stale Gateway deploy.
      docs: {
        coworkSetup:
          "https://github.com/clubwizard/visionclaude/blob/main/ClaudeVision/docs/CLAUDE_DESKTOP_SETUP.md",
        helpGuide:
          "https://github.com/clubwizard/visionclaude/blob/main/ClaudeVision/docs/HELP.md",
      },
    });
  });

  // ── Per-user remote MCP servers ─────────────────────────────────────
  //
  // GET    /me/mcp-servers           — list the user's servers (no secrets)
  // POST   /me/mcp-servers           — add a new server { name, url, authHeader? }
  // PATCH  /me/mcp-servers/:id       — toggle enabled
  // DELETE /me/mcp-servers/:id       — remove
  // POST   /me/mcp-servers/:id/test  — open a probe connection and list tools

  router.get("/mcp-servers", (req, res) => {
    res.json({ servers: listUserMcpServers(req.session.userId!) });
  });

  router.post("/mcp-servers", (req, res) => {
    const body = req.body as { name?: unknown; url?: unknown; authHeader?: unknown };
    if (typeof body.name !== "string" || typeof body.url !== "string") {
      res.status(400).json({ error: "name and url are required strings" });
      return;
    }
    if (body.authHeader !== undefined && body.authHeader !== null && typeof body.authHeader !== "string") {
      res.status(400).json({ error: "authHeader must be a string if provided" });
      return;
    }
    try {
      const server = createUserMcpServer({
        userId: req.session.userId!,
        name: body.name,
        url: body.url,
        authHeader: (body.authHeader as string | undefined) ?? null,
      });
      res.json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid input" });
    }
  });

  router.patch("/mcp-servers/:id", (req, res) => {
    const body = req.body as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    const ok = setUserMcpServerEnabled(req.session.userId!, req.params.id, body.enabled);
    if (!ok) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/mcp-servers/:id", (req, res) => {
    const ok = deleteUserMcpServer(req.session.userId!, req.params.id);
    if (!ok) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    res.json({ ok: true });
  });

  // POST /me/mcp-servers/:id/test — probe the upstream server: open a
  // transient MCP connection, list its tools, close. Surfaces a useful
  // error message on failure so the user can diagnose without reading
  // the server logs. Independent of the per-user connection pool used
  // by /chat (we don't want the test to thrash the pool).
  router.post("/mcp-servers/:id/test", async (req, res) => {
    const userId = req.session.userId!;
    const server = getUserMcpServer(userId, req.params.id);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    const authHeader = getUserMcpServerAuth(userId, req.params.id);
    try {
      const tools = await mcpManager.probeRemoteServer(server.url, authHeader);
      res.json({ ok: true, toolCount: tools.length, toolNames: tools.map(t => t.name).slice(0, 50) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ ok: false, error: message });
    }
  });

  // POST /me/api-keys/test — verify a key actually works against the
  // upstream provider without burning real model usage. Body:
  //   { slot: "anthropic" | "deepgram" | "openai", candidate?: string }
  // If `candidate` is supplied it's tested as-is (not saved). Otherwise
  // the stored key for that slot is tested.
  router.post("/api-keys/test", async (req, res) => {
    const body = req.body as { slot?: KeySlot; candidate?: string };
    const slot = body.slot;
    if (slot !== "anthropic" && slot !== "deepgram" && slot !== "openai") {
      res.status(400).json({ error: "slot must be 'anthropic', 'deepgram', or 'openai'" });
      return;
    }
    const userId = req.session.userId!;
    const key =
      body.candidate?.trim() || getUserApiKey(userId, slot) || null;
    if (!key) {
      res
        .status(400)
        .json({ ok: false, reason: "no_key", message: "No key supplied or stored." });
      return;
    }
    try {
      const result =
        slot === "anthropic"
          ? await testAnthropic(key)
          : slot === "deepgram"
          ? await testDeepgram(key)
          : await testOpenAi(key);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ ok: false, reason: "network", message });
    }
  });

  return router;
}

// Anthropic doesn't expose a free "ping" endpoint, but /v1/models is a
// no-cost authenticated GET that returns 200 on a valid key, 401 on a bad
// one, 403 on a disabled one, and 429 if rate-limited.
async function testAnthropic(
  apiKey: string
): Promise<{ ok: boolean; reason?: string; message?: string; detail?: unknown }> {
  const r = await fetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      data?: Array<{ id: string }>;
    };
    return {
      ok: true,
      message: `Authenticated. ${data?.data?.length ?? 0} models available.`,
    };
  }
  if (r.status === 401) {
    return { ok: false, reason: "auth", message: "Anthropic rejected the key (401)." };
  }
  if (r.status === 403) {
    return { ok: false, reason: "forbidden", message: "Key valid but lacks access (403)." };
  }
  if (r.status === 429) {
    return { ok: false, reason: "rate_limited", message: "Rate-limited (429). Key looks valid." };
  }
  return { ok: false, reason: "http", message: `HTTP ${r.status}` };
}

// Deepgram exposes /v1/projects on every account — authenticated GET, no
// model usage, returns 200 with the project list on success.
async function testDeepgram(
  apiKey: string
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const r = await fetch("https://api.deepgram.com/v1/projects", {
    method: "GET",
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      projects?: Array<{ name?: string }>;
    };
    const names = (data?.projects ?? []).map((p) => p.name).filter(Boolean);
    return {
      ok: true,
      message: names.length
        ? `Authenticated. Projects: ${names.join(", ")}.`
        : "Authenticated.",
    };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: "auth", message: `Deepgram rejected the key (${r.status}).` };
  }
  return { ok: false, reason: "http", message: `HTTP ${r.status}` };
}

// OpenAI exposes /v1/models on every key — authenticated GET, no model
// usage, returns 200 with the model list on success.
async function testOpenAi(
  apiKey: string
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const r = await fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      data?: Array<{ id: string }>;
    };
    return {
      ok: true,
      message: `Authenticated. ${data?.data?.length ?? 0} models available.`,
    };
  }
  if (r.status === 401) {
    return { ok: false, reason: "auth", message: "OpenAI rejected the key (401)." };
  }
  if (r.status === 429) {
    return { ok: false, reason: "rate_limited", message: "Rate-limited (429). Key looks valid." };
  }
  return { ok: false, reason: "http", message: `HTTP ${r.status}` };
}
