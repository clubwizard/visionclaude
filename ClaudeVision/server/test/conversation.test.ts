import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { ConversationStore } from "../src/conversation.js";
import { createUser } from "../src/users.js";
import { getDb, closeDb } from "../src/db.js";
import type { MessageParam } from "../src/types.js";

beforeAll(() => { getDb(); });
afterAll(() => { closeDb(); });
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM conversations; DELETE FROM invites; DELETE FROM users;");
});

function textMsg(role: "user" | "assistant", text: string): MessageParam {
  return { role, content: [{ type: "text", text }] };
}

function imageMsg(role: "user", b64: string): MessageParam {
  return {
    role,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: b64 },
      },
    ],
  };
}

describe("ConversationStore basics", () => {
  it("creates a new conversation with a generated id when none is supplied", () => {
    const store = new ConversationStore();
    const { id, messages } = store.getOrCreate();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(messages).toEqual([]);
    store.destroy();
  });

  it("appends messages and returns them on a subsequent load", () => {
    const store = new ConversationStore();
    const { id } = store.getOrCreate();
    store.append(id, textMsg("user", "hi"), textMsg("assistant", "hello"));
    const reloaded = store.getOrCreate(id);
    expect(reloaded.id).toBe(id);
    expect(reloaded.messages).toHaveLength(2);
    expect((reloaded.messages[0].content as { text: string }[])[0].text).toBe("hi");
    store.destroy();
  });

  it("persists across store instances (the whole point of this PR)", () => {
    const a = new ConversationStore();
    const { id } = a.getOrCreate();
    a.append(id, textMsg("user", "one"));
    a.destroy();

    // Brand-new store, same DB — should see the conversation
    const b = new ConversationStore();
    const reloaded = b.getOrCreate(id);
    expect(reloaded.messages).toHaveLength(1);
    b.destroy();
  });

  it("size reports the row count", () => {
    const store = new ConversationStore();
    expect(store.size).toBe(0);
    store.getOrCreate("a");
    store.getOrCreate("b");
    expect(store.size).toBe(2);
    store.destroy();
  });
});

describe("ConversationStore isolation", () => {
  it("two users with different scoped ids never see each other's history", () => {
    const store = new ConversationStore();
    const alice = createUser({ email: "alice@x.com", password: "longenough" });
    const bob = createUser({ email: "bob@x.com", password: "longenough" });
    const aliceId = `user:${alice.id}|chat1`;
    const bobId = `user:${bob.id}|chat1`; // same client-side id, different scope

    store.getOrCreate(aliceId, alice.id);
    store.append(aliceId, textMsg("user", "alice secret"));

    store.getOrCreate(bobId, bob.id);
    store.append(bobId, textMsg("user", "bob secret"));

    const aliceReload = store.getOrCreate(aliceId);
    const bobReload = store.getOrCreate(bobId);
    expect(aliceReload.messages).toHaveLength(1);
    expect(bobReload.messages).toHaveLength(1);
    expect((aliceReload.messages[0].content as { text: string }[])[0].text).toBe("alice secret");
    expect((bobReload.messages[0].content as { text: string }[])[0].text).toBe("bob secret");
    store.destroy();
  });

  it("deleting a user cascades to delete their conversations", () => {
    const store = new ConversationStore();
    const alice = createUser({ email: "alice@x.com", password: "longenough" });
    const aliceConvId = `user:${alice.id}|c1`;
    store.getOrCreate(aliceConvId, alice.id);
    store.append(aliceConvId, textMsg("user", "ephemeral"));
    expect(store.size).toBe(1);

    getDb().prepare("DELETE FROM users WHERE id = ?").run(alice.id);
    expect(store.size).toBe(0);
    store.destroy();
  });
});

describe("pruneImageHistory", () => {
  it("keeps only the most recent N images and replaces older ones with placeholders", () => {
    const store = new ConversationStore();
    const { id } = store.getOrCreate();
    store.append(id, imageMsg("user", "img1-base64"));
    store.append(id, textMsg("assistant", "first"));
    store.append(id, imageMsg("user", "img2-base64"));
    store.append(id, textMsg("assistant", "second"));
    store.append(id, imageMsg("user", "img3-base64"));

    const pruned = store.pruneImageHistory(id, 1); // keep only the newest image
    // Most recent image block should still be an image
    const last = pruned[pruned.length - 1].content as Array<{ type: string }>;
    expect(last[0].type).toBe("image");
    // Older image blocks should be text placeholders
    const first = pruned[0].content as Array<{ type: string }>;
    expect(first[0].type).toBe("text");
  });

  it("returns the pruned array and persists the change", () => {
    const store = new ConversationStore();
    const { id } = store.getOrCreate();
    store.append(id, imageMsg("user", "img1"));
    store.append(id, imageMsg("user", "img2"));

    const pruned = store.pruneImageHistory(id, 0);
    const reloaded = store.getOrCreate(id);
    // Both stores see no image blocks anymore
    for (const arr of [pruned, reloaded.messages]) {
      for (const m of arr) {
        for (const block of m.content as Array<{ type: string }>) {
          expect(block.type).toBe("text");
        }
      }
    }
    store.destroy();
  });

  it("no-op on unknown id", () => {
    const store = new ConversationStore();
    expect(store.pruneImageHistory("does-not-exist", 0)).toEqual([]);
    store.destroy();
  });
});

describe("TTL cleanup", () => {
  it("deletes rows older than the cutoff", () => {
    const store = new ConversationStore();
    const { id } = store.getOrCreate();
    store.append(id, textMsg("user", "old"));
    // Backdate the row well past the 30-day TTL
    const ancient = Date.now() - 365 * 24 * 60 * 60 * 1000;
    getDb()
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(ancient, id);
    store.cleanup();
    expect(store.size).toBe(0);
    store.destroy();
  });

  it("leaves fresh rows alone", () => {
    const store = new ConversationStore();
    store.getOrCreate("fresh");
    store.cleanup();
    expect(store.size).toBe(1);
    store.destroy();
  });
});

describe("malformed-row resilience", () => {
  it("returns empty messages for a corrupt JSON blob without throwing", () => {
    const store = new ConversationStore();
    getDb()
      .prepare(
        "INSERT INTO conversations (id, user_id, messages, updated_at) VALUES (?, NULL, ?, ?)"
      )
      .run("corrupt-id", "{not json", Date.now());
    const { messages } = store.getOrCreate("corrupt-id");
    expect(messages).toEqual([]);
    store.destroy();
  });
});
