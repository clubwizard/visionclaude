import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { encryptApiKey, decryptApiKey } from "./crypto.js";

// Per-user remote MCP servers — CRUD + decryption boundary.
//
// Storage shape: { id, user_id, name, url, auth_header_enc, enabled, ... }.
// The auth header (typically "Authorization: Bearer ...") is encrypted at
// rest with the same envelope as users.api_key_*_enc. It only ever leaves
// the DB at chat time, when MCPManager needs to open a connection to the
// upstream URL.
//
// We deliberately do NOT support stdio MCP servers here — those mean
// spawning a process per user, which doesn't scale on a shared host
// (10 users × 5 servers × ~75MB per node process ≈ OOM on Plesk). Stdio
// stays operator-controlled via claude_desktop_config.json. Per-user
// MCP is HTTP/SSE only.

export interface UserMcpServer {
  id: string;
  userId: string;
  name: string;
  url: string;
  hasAuth: boolean;       // surfaced to UI; the actual header never is
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface UserMcpServerRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  auth_header_enc: string | null;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
}

function rowToPublic(row: UserMcpServerRow): UserMcpServer {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    url: row.url,
    hasAuth: !!row.auth_header_enc,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// ── Validation ──
// Tight URL check at the storage boundary. Rejects obvious malice:
// - non-HTTPS (we won't ship auth headers over plaintext)
// - localhost / 127.* / private RFC1918 ranges (SSRF guard — a user
//   shouldn't be able to point their "MCP server" at internal-only
//   addresses on the Plesk host)
// - file://, javascript:, data:, etc.
const PRIVATE_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|::1$|0\.|metadata\.google\.internal$|169\.254\.169\.254$)/i;

export function validateMcpUrl(input: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof input !== "string" || input.length < 8 || input.length > 2048) {
    return { ok: false, reason: "URL must be 8–2048 characters." };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "URL must use https:// — auth headers can't go over plaintext." };
  }
  if (PRIVATE_HOSTS.test(url.hostname)) {
    return { ok: false, reason: "Private / loopback / metadata hosts aren't allowed." };
  }
  return { ok: true, url };
}

// ── CRUD ──

export interface CreateMcpServerInput {
  userId: string;
  name: string;
  url: string;
  authHeader?: string | null;
}

export function createUserMcpServer(input: CreateMcpServerInput): UserMcpServer {
  const trimmedName = input.name?.trim();
  if (!trimmedName || trimmedName.length > 64) {
    throw new Error("Name must be 1–64 characters.");
  }
  const v = validateMcpUrl(input.url);
  if (!v.ok) throw new Error(v.reason);

  const id = uuidv4();
  const now = Date.now();
  const authEnc =
    input.authHeader && input.authHeader.trim()
      ? encryptApiKey(input.authHeader.trim())
      : null;

  const db = getDb();
  db.prepare(
    `INSERT INTO user_mcp_servers (id, user_id, name, url, auth_header_enc, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, input.userId, trimmedName, v.url.toString(), authEnc, now);

  return {
    id,
    userId: input.userId,
    name: trimmedName,
    url: v.url.toString(),
    hasAuth: !!authEnc,
    enabled: true,
    createdAt: now,
    lastUsedAt: null,
  };
}

export function listUserMcpServers(userId: string): UserMcpServer[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM user_mcp_servers WHERE user_id = ? ORDER BY created_at ASC"
    )
    .all(userId) as UserMcpServerRow[];
  return rows.map(rowToPublic);
}

export function getUserMcpServer(userId: string, id: string): UserMcpServer | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM user_mcp_servers WHERE id = ? AND user_id = ?")
    .get(id, userId) as UserMcpServerRow | undefined;
  return row ? rowToPublic(row) : null;
}

// Returns the decrypted auth header for runtime use (MCPManager only).
// Never expose this through any HTTP route — auth headers must never
// round-trip back to the browser.
export function getUserMcpServerAuth(userId: string, id: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT auth_header_enc FROM user_mcp_servers WHERE id = ? AND user_id = ?")
    .get(id, userId) as { auth_header_enc: string | null } | undefined;
  if (!row?.auth_header_enc) return null;
  return decryptApiKey(row.auth_header_enc);
}

export function setUserMcpServerEnabled(userId: string, id: string, enabled: boolean): boolean {
  const db = getDb();
  const r = db
    .prepare("UPDATE user_mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?")
    .run(enabled ? 1 : 0, id, userId);
  return r.changes > 0;
}

export function deleteUserMcpServer(userId: string, id: string): boolean {
  const db = getDb();
  const r = db
    .prepare("DELETE FROM user_mcp_servers WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return r.changes > 0;
}

export function markUserMcpServerUsed(userId: string, id: string): void {
  try {
    const db = getDb();
    db.prepare(
      "UPDATE user_mcp_servers SET last_used_at = ? WHERE id = ? AND user_id = ?"
    ).run(Date.now(), id, userId);
  } catch {
    // Best-effort — never throw into the chat path
  }
}
