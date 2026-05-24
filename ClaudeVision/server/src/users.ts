import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  encryptApiKey,
  decryptApiKey,
  generateToken,
} from "./crypto.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface User {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_admin: number;
  created_at: number;
  api_key_anthropic_enc: string | null;
  api_key_deepgram_enc: string | null;
}

interface InviteRow {
  token: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_by: string | null;
  used_at: number | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
  };
}

// ── User CRUD ──

export function findUserByEmail(email: string): UserRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email.toLowerCase()) as UserRow | undefined) ?? null
  );
}

export function findUserById(id: string): User | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
  return row ? rowToUser(row) : null;
}

export function countUsers(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get() as {
    c: number;
  };
  return row.c;
}

export function listUsers(): User[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all() as UserRow[];
  return rows.map(rowToUser);
}

export function countAdmins(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1")
    .get() as { c: number };
  return row.c;
}

export function deleteUser(id: string): boolean {
  const db = getDb();
  // Free up any unused invites this user issued so they can be reused.
  // Used invites stay so the audit trail (created_by, used_by) survives.
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM invites WHERE created_by = ? AND used_by IS NULL").run(id);
    const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return r.changes > 0;
  });
  return tx();
}

export function setAdminFlag(id: string, isAdmin: boolean): boolean {
  const db = getDb();
  const r = db
    .prepare("UPDATE users SET is_admin = ? WHERE id = ?")
    .run(isAdmin ? 1 : 0, id);
  return r.changes > 0;
}

export interface CreateUserInput {
  email: string;
  password: string;
  isAdmin?: boolean;
}

export function createUser(input: CreateUserInput): User {
  const db = getDb();
  const id = uuidv4();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    input.email.toLowerCase(),
    hashPassword(input.password),
    input.isAdmin ? 1 : 0,
    now
  );
  return { id, email: input.email.toLowerCase(), isAdmin: !!input.isAdmin, createdAt: now };
}

export function authenticate(
  email: string,
  password: string
): User | null {
  const row = findUserByEmail(email);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return rowToUser(row);
}

// ── API key storage (encrypted at rest) ──

export type KeySlot = "anthropic" | "deepgram";

const slotColumn: Record<KeySlot, "api_key_anthropic_enc" | "api_key_deepgram_enc"> = {
  anthropic: "api_key_anthropic_enc",
  deepgram: "api_key_deepgram_enc",
};

export function setUserApiKey(
  userId: string,
  slot: KeySlot,
  plaintext: string | null
): void {
  const db = getDb();
  const col = slotColumn[slot];
  const enc = plaintext && plaintext.trim() ? encryptApiKey(plaintext.trim()) : null;
  db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(enc, userId);
}

export function getUserApiKey(userId: string, slot: KeySlot): string | null {
  const db = getDb();
  const col = slotColumn[slot];
  const row = db
    .prepare(`SELECT ${col} AS enc FROM users WHERE id = ?`)
    .get(userId) as { enc: string | null } | undefined;
  if (!row || !row.enc) return null;
  return decryptApiKey(row.enc);
}

// Returns "set" / "unset" for each slot — never returns plaintext.
export function getUserKeyStatus(
  userId: string
): { anthropic: "set" | "unset"; deepgram: "set" | "unset" } {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT api_key_anthropic_enc, api_key_deepgram_enc FROM users WHERE id = ?"
    )
    .get(userId) as { api_key_anthropic_enc: string | null; api_key_deepgram_enc: string | null } | undefined;
  return {
    anthropic: row?.api_key_anthropic_enc ? "set" : "unset",
    deepgram: row?.api_key_deepgram_enc ? "set" : "unset",
  };
}

// ── Invites ──

export interface Invite {
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

function rowToInvite(row: InviteRow): Invite {
  return {
    token: row.token,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: !!row.used_by,
  };
}

export function createInvite(adminUserId: string): Invite {
  const db = getDb();
  const token = generateToken(24);
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  db.prepare(
    `INSERT INTO invites (token, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(token, adminUserId, now, expiresAt);
  return {
    token,
    createdBy: adminUserId,
    createdAt: now,
    expiresAt,
    used: false,
  };
}

export function listInvites(): Invite[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM invites ORDER BY created_at DESC")
    .all() as InviteRow[];
  return rows.map(rowToInvite);
}

export function revokeInvite(token: string): boolean {
  const db = getDb();
  const r = db
    .prepare("DELETE FROM invites WHERE token = ? AND used_by IS NULL")
    .run(token);
  return r.changes > 0;
}

// Atomically claim an invite + create the user in a single transaction.
// The invite is consumed via a conditional UPDATE that requires used_by IS
// NULL at write time, so two concurrent signups racing on the same token
// cannot both succeed — the second sees changes = 0 and the transaction
// rolls back, leaving no orphan user behind. Same applies when the email
// is already taken (UNIQUE constraint triggers a rollback that also
// re-frees the invite).
export type SignupResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid_invite" | "email_taken" };

export function signupWithInvite(
  token: string,
  email: string,
  password: string
): SignupResult {
  const db = getDb();
  const userId = uuidv4();
  const now = Date.now();
  const normalizedEmail = email.toLowerCase();
  const passwordHash = hashPassword(password);

  const claimInvite = db.prepare(
    `UPDATE invites
     SET used_by = ?, used_at = ?
     WHERE token = ? AND used_by IS NULL AND expires_at > ?`
  );
  const insertUser = db.prepare(
    `INSERT INTO users (id, email, password_hash, is_admin, created_at)
     VALUES (?, ?, ?, 0, ?)`
  );

  const run = db.transaction(() => {
    const r = claimInvite.run(userId, now, token, now);
    if (r.changes === 0) {
      // Sentinel — caught below and translated to a structured result.
      const e = new Error("INVALID_INVITE");
      (e as Error & { code?: string }).code = "INVALID_INVITE";
      throw e;
    }
    insertUser.run(userId, normalizedEmail, passwordHash, now);
  });

  try {
    run();
    return {
      ok: true,
      user: { id: userId, email: normalizedEmail, isAdmin: false, createdAt: now },
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "INVALID_INVITE") return { ok: false, reason: "invalid_invite" };
    if (code === "SQLITE_CONSTRAINT_UNIQUE")
      return { ok: false, reason: "email_taken" };
    throw err;
  }
}
