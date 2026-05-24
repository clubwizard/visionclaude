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
  `);

  // Incremental columns — SQLite has no IF NOT EXISTS for ADD COLUMN, so
  // we check first via PRAGMA and only add when missing. Add new
  // additive migrations here when expanding the schema.
  addColumnIfMissing(db, "users", "api_key_openai_enc", "TEXT");
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
