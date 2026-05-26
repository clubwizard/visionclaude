import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { c } from "./console-theme.js";
import {
  listUserMcpServers,
  getUserMcpServerAuth,
} from "./user-mcp-servers.js";
import type {
  MCPServerConfig,
  ClaudeDesktopConfig,
  DiscoveredTool,
  Tool,
} from "./types.js";

interface ConnectedServer {
  name: string;
  client: Client;
  tools: DiscoveredTool[];
  type: "stdio" | "remote";
}

// Per-user remote MCP connection. Keyed by `${userId}:${serverId}` in the
// pool. Cached lazily — we don't open anything until the user's first
// /chat call that needs MCP tools. Each entry tracks `lastUsedAt` so the
// LRU sweeper can evict cold entries without thrashing hot ones.
interface UserScopedConnection {
  userId: string;
  serverId: string;
  serverName: string;
  url: string;
  client: Client;
  tools: DiscoveredTool[];
  lastUsedAt: number;
}

// LRU cap on total concurrent user-MCP connections. Bounded so a flood of
// distinct active users can't exhaust the host's file descriptor budget.
// At ~1MB resident per HTTP/SSE connection, this maxes ~50MB — fine on a
// 2GB Plesk container.
const USER_MCP_POOL_MAX = 50;

// Connections older than this with no activity are closed by the sweeper.
const USER_MCP_IDLE_MS = 10 * 60 * 1000; // 10 minutes

// Hard cap on a single tool call. Protects /chat from being blocked by a
// hung upstream MCP server. The 30s figure matches the existing
// MAX_TOOL_ITERATIONS loop's implicit budget — a tool that takes longer
// than this almost certainly indicates a remote outage, not slow work.
const USER_MCP_TOOL_CALL_TIMEOUT_MS = 30_000;

// Probe timeout for the test endpoint — the user is waiting on the page.
const USER_MCP_PROBE_TIMEOUT_MS = 15_000;

export class MCPManager {
  private servers = new Map<string, ConnectedServer>();
  private toolToServer = new Map<string, string>(); // toolName → serverName

  // Per-user remote MCP — keyed by `${userId}:${serverId}`. Tools surfaced
  // by user-scoped servers are NAMESPACED with a `u_<short>__` prefix when
  // exposed to Claude, so they can't collide with operator tools or each
  // other. The reverse map (`toolName → {userId, serverId, originalName}`)
  // lets invokeToolForUser route a tool_use back to the right pool entry.
  private userPool = new Map<string, UserScopedConnection>();
  private userToolToConn = new Map<string, { key: string; original: string }>();
  private userPoolSweepStarted = false;

  async initialize(configPath?: string): Promise<void> {
    const config = await this.loadConfig(configPath);
    const serverEntries = Object.entries(config);

    if (serverEntries.length === 0) {
      console.log(c.label("[MCP]") + c.dim(" No MCP servers configured"));
      return;
    }

    console.log(
      c.label("[MCP]") + ` Connecting to ${serverEntries.length} server(s)...`
    );

    const results = await Promise.allSettled(
      serverEntries.map(([name, cfg]) => this.connectServer(name, cfg))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = serverEntries[i][0];
      if (result.status === "rejected") {
        console.error(
          c.label("[MCP]") + c.error(` Failed to connect to "${name}": `) + result.reason
        );
      }
    }

    console.log(
      c.label("[MCP]") +
        c.success(
          ` Connected to ${this.servers.size}/${serverEntries.length} servers, discovered ${this.toolToServer.size} tools`
        )
    );
  }

  private async loadConfig(
    configPath?: string
  ): Promise<Record<string, MCPServerConfig>> {
    // Priority: explicit path → env var → Claude Desktop config
    const paths = [
      configPath,
      process.env.MCP_CONFIG_PATH,
      join(
        homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      ),
    ].filter(Boolean) as string[];

    for (const path of paths) {
      try {
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw);

        // Support both { mcpServers: {} } and Claude Desktop format
        const servers: Record<string, MCPServerConfig> =
          parsed.mcpServers || {};

        if (Object.keys(servers).length > 0) {
          console.log(c.label("[MCP]") + ` Loaded config from ${path}`);
          return servers;
        }
      } catch {
        // Try next path
      }
    }

    console.log(
      c.label("[MCP]") + c.dim(" No MCP config found at any default location")
    );
    return {};
  }

  private async connectServer(
    name: string,
    config: MCPServerConfig
  ): Promise<void> {
    let client: Client;

    // Determine transport type: remote URL or local stdio
    if (config.url) {
      client = await this.connectRemoteServer(name, config);
    } else if (config.command) {
      client = await this.connectStdioServer(name, config);
    } else {
      throw new Error(`Server "${name}" has no command or url configured`);
    }

    // Discover tools
    const toolsResponse = await client.listTools();
    const tools: DiscoveredTool[] = (toolsResponse.tools || []).map((t) => ({
      serverName: name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    // Register
    const isRemote = !!config.url;
    const server: ConnectedServer = {
      name,
      client,
      tools,
      type: isRemote ? "remote" : "stdio",
    };
    this.servers.set(name, server);

    for (const tool of tools) {
      this.toolToServer.set(tool.name, name);
    }

    const typeLabel = isRemote ? c.cyan("[remote]") : c.dim("[local]");
    console.log(
      c.label("[MCP]") +
        ` "${name}" ${typeLabel} connected — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`
    );
  }

  private async connectRemoteServer(
    name: string,
    config: MCPServerConfig
  ): Promise<Client> {
    const url = new URL(config.url!);

    // Build headers (auth tokens, etc.)
    const headers: Record<string, string> = {};
    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    // Try StreamableHTTP first (newer protocol), fall back to SSE
    try {
      console.log(
        c.label("[MCP]") + c.dim(` "${name}" trying StreamableHTTP → ${config.url}`)
      );
      const client = new Client(
        { name: "visionclaude-gateway", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(transport);
      console.log(
        c.label("[MCP]") + c.success(` "${name}" connected via StreamableHTTP`)
      );
      return client;
    } catch (httpErr: any) {
      console.log(
        c.label("[MCP]") +
          c.dim(` "${name}" StreamableHTTP failed (${httpErr?.message || httpErr}), trying SSE...`)
      );

      try {
        const client = new Client(
          { name: "visionclaude-gateway", version: "1.0.0" },
          { capabilities: {} }
        );
        const sseTransport = new SSEClientTransport(url, {
          requestInit: { headers },
        });
        await client.connect(sseTransport);
        console.log(
          c.label("[MCP]") + c.success(` "${name}" connected via SSE`)
        );
        return client;
      } catch (sseErr: any) {
        throw new Error(
          `Both transports failed for "${name}":\n` +
            `  StreamableHTTP: ${httpErr?.message || httpErr}\n` +
            `  SSE: ${sseErr?.message || sseErr}`
        );
      }
    }
  }

  private async connectStdioServer(
    name: string,
    config: MCPServerConfig
  ): Promise<Client> {
    const client = new Client(
      { name: "visionclaude-gateway", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });

    await client.connect(transport);
    return client;
  }

  async invokeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const serverName = this.toolToServer.get(toolName);
    if (!serverName) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server "${serverName}" not connected`);
    }

    console.log(
      c.label("[MCP]") + ` Invoking ${c.value(toolName)} on "${serverName}"...`
    );

    const result = await server.client.callTool({
      name: toolName,
      arguments: args,
    });

    return result;
  }

  getToolsForClaude(): Tool[] {
    const tools: Tool[] = [];
    for (const server of this.servers.values()) {
      for (const tool of server.tools) {
        tools.push({
          name: tool.name,
          description: tool.description || "",
          input_schema: tool.inputSchema as Tool["input_schema"],
        });
      }
    }
    return tools;
  }

  getAllDiscoveredTools(): DiscoveredTool[] {
    const all: DiscoveredTool[] = [];
    for (const server of this.servers.values()) {
      all.push(...server.tools);
    }
    return all;
  }

  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  getServerStatus(): { name: string; toolCount: number; type: string }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      toolCount: s.tools.length,
      type: s.type,
    }));
  }

  async healthCheck(): Promise<{
    healthy: string[];
    unhealthy: string[];
  }> {
    const healthy: string[] = [];
    const unhealthy: string[] = [];

    for (const [name, server] of this.servers) {
      try {
        await server.client.listTools();
        healthy.push(name);
      } catch {
        unhealthy.push(name);
      }
    }

    return { healthy, unhealthy };
  }

  async shutdown(): Promise<void> {
    console.log(c.label("[MCP]") + " Shutting down all servers...");
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
        console.log(c.label("[MCP]") + c.dim(` "${name}" disconnected`));
      } catch (err) {
        console.error(
          c.label("[MCP]") + c.error(` Error disconnecting "${name}": `) + err
        );
      }
    }
    // Also close any user-scoped connections we opened
    for (const [key, conn] of this.userPool) {
      try {
        await conn.client.close();
      } catch {
        // Best-effort during shutdown
      }
      this.userPool.delete(key);
    }
    this.userToolToConn.clear();
    this.servers.clear();
    this.toolToServer.clear();
  }

  // ── User-scoped remote MCP ──────────────────────────────────────────
  //
  // The flow when a /chat from User A needs MCP tools:
  //   1. getToolsForChat(userA) returns operator's shared tools PLUS
  //      A's enabled MCP server tools (namespaced u_<short>__).
  //   2. Claude picks a tool. If it's a user-scoped tool name,
  //      invokeToolForUser(userA, toolName) routes it. Otherwise the
  //      classic invokeTool() path handles it.
  //   3. Connections are opened lazily on first use and cached with an
  //      LRU eviction policy. Idle connections are swept after 10min.
  //
  // We don't tag the operator's tools with userId because they're
  // genuinely shared. The pool only ever holds user-scoped servers.

  // Public, used by the /me/mcp-servers/:id/test route. Independent of
  // the pool — opens a probe connection, lists tools, closes. Doesn't
  // mutate state so a test doesn't influence the LRU.
  async probeRemoteServer(
    url: string,
    authHeader: string | null
  ): Promise<DiscoveredTool[]> {
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const client = await this.connectRemoteServer("probe", { url, headers });
    try {
      const resp = await Promise.race([
        client.listTools(),
        timeoutAfter(USER_MCP_PROBE_TIMEOUT_MS, "tools/list"),
      ]);
      const list = (resp as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools ?? [];
      return list.map(t => ({
        serverName: "probe",
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  // Returns the full tool list Claude should see for this user — the
  // operator's shared tools plus any of the user's enabled MCP servers'
  // tools (namespaced to prevent collision). Lazy: opens user-scoped
  // connections on first call, caches in the pool.
  async getToolsForChatForUser(userId: string): Promise<Tool[]> {
    this.ensureUserPoolSweeper();

    // Start with the shared operator tools.
    const tools = this.getToolsForClaude();

    // Wire each enabled user server (lazy connect).
    const userServers = listUserMcpServers(userId).filter(s => s.enabled);
    for (const userServer of userServers) {
      const key = `${userId}:${userServer.id}`;
      let conn = this.userPool.get(key);
      if (!conn) {
        try {
          conn = await this.openUserScopedConnection(userId, userServer.id, userServer.name, userServer.url);
          this.userPool.set(key, conn);
          this.evictUserPoolIfFull();
        } catch (err) {
          // A misconfigured user server should NOT break the whole chat.
          // Log and skip — Claude just won't see those tools this turn.
          console.error(
            c.label("[MCP/user]") +
              c.error(` "${userServer.name}" connect failed for user=${userId.slice(0, 8)}: `) +
              (err instanceof Error ? err.message : String(err))
          );
          continue;
        }
      }
      conn.lastUsedAt = Date.now();
      for (const tool of conn.tools) {
        const namespaced = namespaceUserTool(userServer.id, tool.name);
        tools.push({
          name: namespaced,
          description: tool.description || "",
          input_schema: tool.inputSchema as Tool["input_schema"],
        });
        this.userToolToConn.set(namespaced, { key, original: tool.name });
      }
    }

    return tools;
  }

  // Routes a tool_use from Claude back to the right server — checks the
  // user pool first (namespaced names) and falls back to operator-shared.
  async invokeToolForUser(
    userId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const userEntry = this.userToolToConn.get(toolName);
    if (userEntry) {
      const conn = this.userPool.get(userEntry.key);
      if (!conn) {
        throw new Error(`User MCP connection no longer cached for tool ${toolName}`);
      }
      // Defensive: a user could have a stale tool name pointing at a
      // connection from a different user (shouldn't happen, but guard).
      if (conn.userId !== userId) {
        throw new Error(`Tool ${toolName} doesn't belong to this user`);
      }
      conn.lastUsedAt = Date.now();
      console.log(
        c.label("[MCP/user]") +
          ` Invoking ${c.value(userEntry.original)} on "${conn.serverName}" (user=${userId.slice(0, 8)})`
      );
      const result = await Promise.race([
        conn.client.callTool({ name: userEntry.original, arguments: args }),
        timeoutAfter(USER_MCP_TOOL_CALL_TIMEOUT_MS, `tool ${userEntry.original}`),
      ]);
      return result;
    }
    // Not a user-scoped tool → operator-shared path
    return this.invokeTool(toolName, args);
  }

  private async openUserScopedConnection(
    userId: string,
    serverId: string,
    serverName: string,
    url: string
  ): Promise<UserScopedConnection> {
    const authHeader = getUserMcpServerAuth(userId, serverId);
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;

    const client = await this.connectRemoteServer(serverName, { url, headers });
    const toolsResp = await Promise.race([
      client.listTools(),
      timeoutAfter(USER_MCP_PROBE_TIMEOUT_MS, "tools/list"),
    ]);
    const list = (toolsResp as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }).tools ?? [];
    const tools: DiscoveredTool[] = list.map(t => ({
      serverName,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    console.log(
      c.label("[MCP/user]") +
        c.success(` "${serverName}" connected (user=${userId.slice(0, 8)}) — ${tools.length} tool(s)`)
    );
    return {
      userId,
      serverId,
      serverName,
      url,
      client,
      tools,
      lastUsedAt: Date.now(),
    };
  }

  private evictUserPoolIfFull(): void {
    if (this.userPool.size <= USER_MCP_POOL_MAX) return;
    // LRU eviction — close the oldest-used connections until we're back
    // under the cap.
    const sorted = [...this.userPool.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt
    );
    while (this.userPool.size > USER_MCP_POOL_MAX && sorted.length) {
      const [key, conn] = sorted.shift()!;
      void this.dropUserConnection(key, conn, "lru");
    }
  }

  private ensureUserPoolSweeper(): void {
    if (this.userPoolSweepStarted) return;
    this.userPoolSweepStarted = true;
    // Idle eviction every minute. .unref() so the timer doesn't keep a
    // test process alive after shutdown.
    setInterval(() => {
      const cutoff = Date.now() - USER_MCP_IDLE_MS;
      for (const [key, conn] of this.userPool) {
        if (conn.lastUsedAt < cutoff) {
          void this.dropUserConnection(key, conn, "idle");
        }
      }
    }, 60_000).unref();
  }

  private async dropUserConnection(
    key: string,
    conn: UserScopedConnection,
    reason: "lru" | "idle"
  ): Promise<void> {
    this.userPool.delete(key);
    // Drop tools that belonged to this connection from the lookup map.
    for (const [toolName, entry] of this.userToolToConn) {
      if (entry.key === key) this.userToolToConn.delete(toolName);
    }
    try {
      await conn.client.close();
    } catch {
      // Best-effort
    }
    console.log(
      c.label("[MCP/user]") +
        c.dim(` "${conn.serverName}" closed (user=${conn.userId.slice(0, 8)}, ${reason})`)
    );
  }
}

// ── Helpers (file-scoped) ────────────────────────────────────────────

// Tools from user-scoped servers get a stable prefix derived from the
// server's UUID so they can't collide with operator tools or each other.
// Eight chars of hex is plenty unique without making tool names ugly.
function namespaceUserTool(serverId: string, name: string): string {
  const short = serverId.replace(/-/g, "").slice(0, 8);
  return `u_${short}__${name}`;
}

function timeoutAfter<T>(ms: number, label: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms).unref();
  });
}
