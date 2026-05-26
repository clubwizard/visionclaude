import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import { MCPManager } from "./mcp-manager.js";
import { ClaudeClient } from "./claude-client.js";
import { ConversationStore } from "./conversation.js";
import { SkillLoader } from "./skill-loader.js";
import { gatewayAuth, rateLimiter, requireAuth, requireAnyAuth, RequestQueue } from "./middleware.js";
import { showBanner, showServerInfo, c } from "./console-theme.js";
import { createChatRouter } from "./routes/chat.js";
import { createHealthRouter } from "./routes/health.js";
import { createConfigRouter } from "./routes/config.js";
import { createToolsRouter } from "./routes/tools.js";
import { createAuthRouter } from "./routes/auth.js";
import { createVoiceRouter } from "./routes/voice.js";
import { createMeRouter } from "./routes/me.js";
import { createAdminRouter } from "./routes/admin.js";
import { getDb, closeDb } from "./db.js";
import { countUsers, createUser, findUserByEmail } from "./users.js";
import { suggestMasterKey } from "./crypto.js";
import { detectFamily, isLatestInFamily, getSuccessor } from "./model-registry.js";
import type { ServerConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "18790", 10);

// LOW: HTML pages get a Content-Security-Policy in addition to the global headers.
// Google Fonts requires fonts.googleapis.com (styles) + fonts.gstatic.com (font files).
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
].join("; ");

function sendHtml(file: string) {
  return (_req: Request, res: Response) => {
    res.setHeader("Content-Security-Policy", HTML_CSP);
    res.sendFile(path.join(__dirname, `../public/${file}`));
  };
}

const BUILT_IN_SYSTEM_PROMPT = `You are a helpful voice-first visual assistant. The user talks to you and hears your reply through text-to-speech.

BREVITY IS THE TOP PRIORITY.
- Default to 1 short sentence. 2 only if the answer genuinely needs it.
- Only give longer, structured answers when the user explicitly asks ("describe in detail", "tell me everything", "explain").
- No markdown, no bullet lists, no headings — the response is spoken aloud.
- Never start with "I can see", "In the image", "Looking at the picture" — just answer directly.
- If you need one missing detail to help, ask ONE short follow-up question instead of guessing.

EXAMPLES:
- User: "What am I looking at?" → "A hot tub in your back garden."
- User: "What's in this carton?" → "Whole milk, 2.4 litres, best before 12 June."
- User: "Where's my phone?" → "On the kitchen counter, next to the kettle."
- User: "Describe this in detail." → (then it's fine to give a full description.)

TOOLS:
- When the user asks for something that requires a tool (send email, search web, check calendar, etc.), use the appropriate tool.`;

const DEFAULT_SYSTEM_PROMPT =
  process.env.VOICE_ASSISTANT_PROMPT?.trim() || BUILT_IN_SYSTEM_PROMPT;

function bootstrapAdminIfNeeded(): void {
  // On first run, create the admin user from BOOTSTRAP_ADMIN_EMAIL +
  // BOOTSTRAP_ADMIN_PASSWORD. Idempotent: if a user with that email
  // already exists we just promote them to admin if they weren't.
  if (countUsers() > 0) return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (!email || !password) {
    console.log(
      c.warn(
        "[Bootstrap] No users yet. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in .env on first run to create the admin."
      )
    );
    return;
  }
  if (findUserByEmail(email)) return;
  createUser({ email, password, isAdmin: true });
  console.log(c.success(`[Bootstrap] Admin user created: ${email}`));
  console.log(c.dim("   Remove BOOTSTRAP_ADMIN_* from .env now — login from the web UI."));
}

async function main() {
  showBanner();

  // HIGH: Refuse to start without a session secret — a missing or default
  // secret allows attackers to forge session cookies.
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret) {
    console.error(
      c.error(
        "[Fatal] SESSION_SECRET is not set in .env. " +
          "Generate one with `openssl rand -hex 32` and add it, then restart."
      )
    );
    process.exit(1);
  }

  // Warn the operator if envelope-encryption is unconfigured — startup
  // still proceeds, but any attempt to store a user key will throw.
  if (!process.env.KEYS_ENCRYPTION_KEY?.trim()) {
    console.log(c.warn("[Crypto] KEYS_ENCRYPTION_KEY is not set in .env."));
    console.log(c.dim("   Suggested value: " + suggestMasterKey()));
    console.log(c.dim("   Add it to .env and restart. The server starts without it but storing API keys will fail."));
  }

  // Open DB + run migrations + create bootstrap admin if first run
  getDb();
  bootstrapAdminIfNeeded();

  const mcpManager = new MCPManager();
  await mcpManager.initialize();

  const skillLoader = new SkillLoader();
  skillLoader.load();

  const systemPrompt = DEFAULT_SYSTEM_PROMPT + skillLoader.buildSystemPromptSection();

  const configuredModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
  const config: ServerConfig = {
    systemPrompt,
    model: configuredModel,
    maxTokens: 4096,
  };
  // Surface stale-model hints at boot. Doesn't fail startup — even a stale
  // model usually still works for a while after a fresher one ships.
  // If/when it gets retired, ClaudeClient.callWithDeprecationRetry recovers
  // automatically. This banner just nudges the operator to update .env.
  if (detectFamily(configuredModel) && !isLatestInFamily(configuredModel)) {
    const latest = getSuccessor(configuredModel);
    console.log(
      c.warn(
        `[Model] CLAUDE_MODEL="${configuredModel}" is not the latest in its family. ` +
          `Latest known: "${latest}". When Anthropic retires the configured model, ` +
          `the server will auto-fall-back to the latest — but you should update .env at some point.`
      )
    );
  } else if (!detectFamily(configuredModel)) {
    console.log(
      c.warn(
        `[Model] CLAUDE_MODEL="${configuredModel}" doesn't match any known family (sonnet/opus/haiku). ` +
          `Auto-fallback on deprecation will use the default Sonnet — verify this is what you want.`
      )
    );
  }

  const claudeClient = new ClaudeClient(mcpManager, config);
  const conversations = new ConversationStore();
  const requestQueue = new RequestQueue(2);

  const app = express();
  app.set("trust proxy", 1); // trust Nginx reverse proxy for secure cookies

  // MEDIUM: Restrict cross-origin access. By default (no CORS_ORIGINS set)
  // cross-origin requests are blocked. Set CORS_ORIGINS=https://your-domain.com
  // (comma-separated) to allow specific origins.
  const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(
    cors(
      corsOrigins?.length
        ? { origin: corsOrigins, credentials: true }
        : { origin: false }
    )
  );

  app.use(express.json({ limit: "50mb" }));

  // LOW: Security headers applied globally
  app.use((_req: Request, res: Response, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // ── Session ──
  app.use(session({
    name: "sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }));

  // ── Public: static landing page ──
  app.use(express.static(path.join(__dirname, "../public")));

  // ── Public: auth + signup ──
  // Brute-force protection (5/min) is applied PER-ROUTE inside the auth
  // router, not blanket-wrapped here. Earlier this lived on app.use("/auth",
  // …) which counted every /auth/check read against the same bucket as
  // /auth/login — five page refreshes locked the user out of their own
  // session. Now only credential-touching endpoints (login/signup/
  // forgot-password/reset-password) get the strict cap; cheap reads
  // (check/status/reset-password/check/logout) fall through.
  app.use("/auth", createAuthRouter());

  // ── Public: health ──
  app.use("/health", createHealthRouter(mcpManager, conversations, skillLoader));

  // ── Static HTML for voice client, signup, account (CSP applied via sendHtml) ──
  app.get("/app", sendHtml("app.html"));
  app.get("/signup", sendHtml("signup.html"));
  app.get("/account", sendHtml("account.html"));
  app.get("/reset-password", sendHtml("reset-password.html"));
  app.get("/help", sendHtml("help.html"));

  // ── Rate limiter (applied to all API routes below) ──
  app.use(rateLimiter(30));

  // ── User self-service: /me/api-keys etc. ──
  app.use("/me", createMeRouter(mcpManager, skillLoader));

  // ── Admin: invites + user list ──
  app.use("/admin", createAdminRouter());

  // ── Session or gateway key: chat + voice ──
  app.use("/chat", requireAnyAuth, createChatRouter(claudeClient, conversations, requestQueue));
  app.use("/voice", requireAuth, createVoiceRouter());

  // ── Gateway key only: native app admin routes ──
  app.use(gatewayAuth());
  app.use("/config", createConfigRouter(claudeClient));
  app.use("/tools", createToolsRouter(mcpManager));

  app.get("/skills", (_req, res) => {
    res.json({ skills: skillLoader.getSkillList(), count: skillLoader.count });
  });

  app.post("/skills/reload", (_req, res) => {
    skillLoader.reload();
    const newPrompt = DEFAULT_SYSTEM_PROMPT + skillLoader.buildSystemPromptSection();
    claudeClient.updateConfig({ systemPrompt: newPrompt });
    res.json({ message: "Skills reloaded", skills: skillLoader.getSkillList(), count: skillLoader.count });
  });

  // ── Start ──
  const server = app.listen(PORT, "0.0.0.0", () => {
    const mcpServers = mcpManager.getServerNames();
    const toolCount = mcpManager.getToolsForClaude().length;
    showServerInfo(PORT, mcpServers.length, toolCount, skillLoader.count);
  });

  const shutdown = async () => {
    console.log(c.orange("\n   ▸ Shutting down VisionClaude Gateway..."));
    conversations.destroy();
    closeDb();
    await mcpManager.shutdown();
    server.close(() => {
      console.log(c.dim("   Gateway stopped.\n"));
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(c.error("Fatal error:"), err);
  process.exit(1);
});
