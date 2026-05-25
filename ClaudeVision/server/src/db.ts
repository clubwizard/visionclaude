import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DB location: ${DATA_DIR:-./data}/aside.db. Docker mounts a volume here.
function resolveDbPath(): string {
  const dataDir =
    process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "aside.db");
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  runMigrations(_db);
  return _db;
}

function runMigrations(db: Database.Database): void {
  // Initial schema — idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      api_key_anthropic_enc TEXT,
      api_key_deepgram_enc TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by TEXT REFERENCES users(id),
      used_at INTEGER
    );

    -- Persisted chat history. id is the scoped form "user:<uid>|<convId>"
    -- or "gateway|<convId>" so isolation is enforced at the key level.
    -- user_id is nullable (gateway/iOS path has no session) but indexed
    -- so we can cascade-delete a user's conversations and so future admin
    -- views can list per-user.
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      messages TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id
      ON conversations(user_id);

    -- Password reset tokens. token_hash is sha256(raw token) so a leaked
    -- DB still doesn't yield replayable links — the raw token only ever
    -- lives in the user's email + URL. Single-use: used_at gates redemption.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_id
      ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at
      ON password_resets(expires_at);
  `);

  // Incremental columns — SQLite has no IF NOT EXISTS for ADD COLUMN, so
  // we check first via PRAGMA and only add when missing. Add new
  // additive migrations here when expanding the schema.
  addColumnIfMissing(db, "users", "api_key_openai_enc", "TEXT");
  // Per-user usage tracking — admin-visible counters; not authoritative
  // billing, just a "what's happening" view in the Account → Users list.
  addColumnIfMissing(db, "users", "request_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "users", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "users", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "users", "last_used_at", "INTEGER");
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
