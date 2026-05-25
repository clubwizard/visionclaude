import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type { MessageParam } from "./types.js";

// 30-day retention by default — long enough for users to resume a thread
// after a break, short enough to keep the DB lean. Override with
// CONVERSATION_TTL_DAYS in .env to tune.
const TTL_DAYS = Math.max(
  1,
  parseInt(process.env.CONVERSATION_TTL_DAYS || "30", 10)
);
const CONVERSATION_TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface ConversationRow {
  id: string;
  user_id: string | null;
  messages: string;
  updated_at: number;
}

// SQLite-backed conversation store. Survives restarts and lets users
// resume an earlier thread. Per-user isolation is enforced via the
// scoped id ("user:<uid>|<convId>") chosen by the caller — no global
// id can ever collide with another user's history.
export class ConversationStore {
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Run an initial sweep on startup so a long-restarted server doesn't
    // hold onto rows that are already past TTL.
    try { this.cleanup(); } catch { /* noop — DB may not be ready in tests */ }
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't keep the event loop alive just for cleanup.
    if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
  }

  // Look up or create a conversation row. Returns a fresh-from-DB copy of
  // the messages — callers should not assume the returned array is "live";
  // any mutation must be persisted via append() or pruneImageHistory().
  getOrCreate(
    conversationId?: string,
    userId?: string | null
  ): { id: string; messages: MessageParam[] } {
    const db = getDb();
    const id = conversationId || uuidv4();
    const row = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;

    if (row) {
      // Touch updated_at so the row isn't TTL'd while the user is still
      // active, and refresh user_id in case the row was originally
      // anonymous (gateway scope) and is now being read by a user.
      db.prepare(
        "UPDATE conversations SET updated_at = ? WHERE id = ?"
      ).run(Date.now(), id);
      return { id, messages: this.parseMessages(row.messages) };
    }

    db.prepare(
      `INSERT INTO conversations (id, user_id, messages, updated_at)
       VALUES (?, ?, '[]', ?)`
    ).run(id, userId ?? null, Date.now());
    return { id, messages: [] };
  }

  append(conversationId: string, ...messages: MessageParam[]): void {
    if (messages.length === 0) return;
    const db = getDb();
    const row = db
      .prepare("SELECT messages FROM conversations WHERE id = ?")
      .get(conversationId) as { messages: string } | undefined;
    if (!row) return; // unknown id — caller should have called getOrCreate first
    const existing = this.parseMessages(row.messages);
    existing.push(...messages);
    db.prepare(
      "UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(existing), Date.now(), conversationId);
  }

  // Walk history and replace all but the most recent `maxImages` image
  // content blocks with short text placeholders. Persists the result and
  // returns the pruned array so callers can use it directly without
  // re-reading. This bounds vision-token cost across a long thread —
  // without it, every turn re-sends every prior frame.
  pruneImageHistory(conversationId: string, maxImages: number): MessageParam[] {
    const db = getDb();
    const row = db
      .prepare("SELECT messages FROM conversations WHERE id = ?")
      .get(conversationId) as { messages: string } | undefined;
    if (!row) return [];
    const messages = this.parseMessages(row.messages);
    if (maxImages < 0) maxImages = 0;

    let kept = 0;
    let mutated = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j] as { type?: string };
        if (block.type !== "image") continue;
        if (kept < maxImages) {
          kept++;
        } else {
          msg.content[j] = {
            type: "text",
            text: "[earlier image — not retained in context]",
          };
          mutated = true;
        }
      }
    }

    if (mutated) {
      db.prepare(
        "UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(messages), Date.now(), conversationId);
    }
    return messages;
  }

  // Sweep expired rows. Called on a 1-hour interval; also runs at startup.
  cleanup(): void {
    const cutoff = Date.now() - CONVERSATION_TTL_MS;
    getDb()
      .prepare("DELETE FROM conversations WHERE updated_at < ?")
      .run(cutoff);
  }

  get size(): number {
    try {
      const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM conversations")
        .get() as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }

  private parseMessages(raw: string): MessageParam[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt row — return empty rather than crashing the request path.
      return [];
    }
  }
}
