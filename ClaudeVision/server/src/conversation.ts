import { v4 as uuidv4 } from "uuid";
import type { MessageParam } from "./types.js";

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface ConversationEntry {
  messages: MessageParam[];
  lastAccess: number;
}

export class ConversationStore {
  private store = new Map<string, ConversationEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  getOrCreate(conversationId?: string): { id: string; messages: MessageParam[] } {
    const id = conversationId || uuidv4();
    const entry = this.store.get(id);

    if (entry) {
      entry.lastAccess = Date.now();
      return { id, messages: entry.messages };
    }

    const newEntry: ConversationEntry = {
      messages: [],
      lastAccess: Date.now(),
    };
    this.store.set(id, newEntry);
    return { id, messages: newEntry.messages };
  }

  append(conversationId: string, ...messages: MessageParam[]): void {
    const entry = this.store.get(conversationId);
    if (entry) {
      entry.messages.push(...messages);
      entry.lastAccess = Date.now();
    }
  }

  /**
   * Walk the stored history and replace all but the most recent `maxImages`
   * image content blocks with short text placeholders. This keeps cost and
   * latency bounded on long voice conversations — without this, every turn
   * re-sends every prior frame, and a 10-turn chat balloons to 10× the
   * vision tokens by the last turn.
   *
   * Mutates the stored messages array in place; the original base64 data is
   * dropped (the conversation is ephemeral and capped at 30 min anyway).
   */
  pruneImageHistory(conversationId: string, maxImages: number): void {
    const entry = this.store.get(conversationId);
    if (!entry) return;
    if (maxImages < 0) maxImages = 0;

    let kept = 0;
    for (let i = entry.messages.length - 1; i >= 0; i--) {
      const msg = entry.messages[i];
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
        }
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (now - entry.lastAccess > CONVERSATION_TTL_MS) {
        this.store.delete(id);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }
}
