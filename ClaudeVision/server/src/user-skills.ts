import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";

// Per-user skills — small markdown-ish blobs that get appended to the
// requesting user's system prompt at chat time. Mirrors the operator's
// SKILL.md filesystem layout in shape (name + description + trigger +
// body) but stored in SQLite so users can manage them from the web.
//
// Two pieces ride along with each chat:
//   1. A condensed "available skills" header (description + trigger only)
//      so Claude knows which skill to invoke when the user's request
//      matches a trigger.
//   2. The full body of any skill whose trigger keywords appear in the
//      user's most recent message (cheap substring match — we don't
//      embed the full body of every skill on every turn or the system
//      prompt explodes).
//
// User skills NEVER leak to other users — every query filters by user_id,
// and the chat path only reads skills for the session's userId.

export interface UserSkill {
  id: string;
  userId: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UserSkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  trigger: string;
  body: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToSkill(row: UserSkillRow): UserSkill {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    body: row.body,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Validation ──
// Bounds are tight on purpose. Long descriptions and triggers waste
// system-prompt tokens on every chat; long bodies amplify that whenever
// a trigger matches. 8KB body is the hard upper limit because past that
// the skill is doing the job of a tool or a full prompt — split it.
const MAX_NAME = 64;
const MAX_DESCRIPTION = 280;
const MAX_TRIGGER = 200;
const MAX_BODY = 8 * 1024;

export interface CreateUserSkillInput {
  userId: string;
  name: string;
  description: string;
  trigger?: string;
  body: string;
}

function normalize(s: unknown, max: number, label: string): string {
  if (typeof s !== "string") throw new Error(`${label} must be a string`);
  const trimmed = s.trim();
  if (!trimmed) throw new Error(`${label} can't be empty`);
  if (trimmed.length > max) throw new Error(`${label} must be ≤${max} characters`);
  return trimmed;
}

export function createUserSkill(input: CreateUserSkillInput): UserSkill {
  const name = normalize(input.name, MAX_NAME, "name");
  const description = normalize(input.description, MAX_DESCRIPTION, "description");
  const body = normalize(input.body, MAX_BODY, "body");
  // trigger is optional; default to empty string. If provided it must
  // still fit the bound.
  let trigger = "";
  if (input.trigger !== undefined && input.trigger !== null && input.trigger !== "") {
    if (typeof input.trigger !== "string") throw new Error("trigger must be a string");
    const t = input.trigger.trim();
    if (t.length > MAX_TRIGGER) throw new Error(`trigger must be ≤${MAX_TRIGGER} characters`);
    trigger = t;
  }

  const id = uuidv4();
  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO user_skills (id, user_id, name, description, trigger, body, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, input.userId, name, description, trigger, body, now, now);

  return {
    id,
    userId: input.userId,
    name,
    description,
    trigger,
    body,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function listUserSkills(userId: string): UserSkill[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM user_skills WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as UserSkillRow[];
  return rows.map(rowToSkill);
}

export function getUserSkill(userId: string, id: string): UserSkill | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM user_skills WHERE id = ? AND user_id = ?")
    .get(id, userId) as UserSkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

export interface UpdateUserSkillInput {
  name?: string;
  description?: string;
  trigger?: string;
  body?: string;
  enabled?: boolean;
}

export function updateUserSkill(
  userId: string,
  id: string,
  patch: UpdateUserSkillInput
): UserSkill | null {
  const existing = getUserSkill(userId, id);
  if (!existing) return null;

  const next = { ...existing };
  if (patch.name !== undefined) next.name = normalize(patch.name, MAX_NAME, "name");
  if (patch.description !== undefined)
    next.description = normalize(patch.description, MAX_DESCRIPTION, "description");
  if (patch.body !== undefined) next.body = normalize(patch.body, MAX_BODY, "body");
  if (patch.trigger !== undefined) {
    if (typeof patch.trigger !== "string") throw new Error("trigger must be a string");
    const t = patch.trigger.trim();
    if (t.length > MAX_TRIGGER) throw new Error(`trigger must be ≤${MAX_TRIGGER} characters`);
    next.trigger = t;
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled;

  const now = Date.now();
  const db = getDb();
  db.prepare(
    `UPDATE user_skills SET name = ?, description = ?, trigger = ?, body = ?, enabled = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    next.name,
    next.description,
    next.trigger,
    next.body,
    next.enabled ? 1 : 0,
    now,
    id,
    userId
  );
  next.updatedAt = now;
  return next;
}

export function deleteUserSkill(userId: string, id: string): boolean {
  const db = getDb();
  const r = db.prepare("DELETE FROM user_skills WHERE id = ? AND user_id = ?").run(id, userId);
  return r.changes > 0;
}

// ── Prompt assembly ──
//
// Called by ClaudeClient on every chat turn (only when there's a userId).
// Returns the text to APPEND to the base system prompt — empty string
// if the user has no enabled skills. We deliberately do NOT inject the
// body of EVERY skill — that would balloon the prompt linearly with the
// user's skill count. Instead we always include a short "available
// skills" line per skill, plus the full body of any skill whose trigger
// keywords match the user's latest message.

export function buildUserSkillsAppendix(userId: string, latestUserMessage: string): string {
  const skills = listUserSkills(userId).filter(s => s.enabled);
  if (skills.length === 0) return "";

  const haystack = latestUserMessage.toLowerCase();
  const triggered: UserSkill[] = [];
  for (const skill of skills) {
    if (!skill.trigger) continue;
    const keywords = skill.trigger
      .split(/[,\n]+/)
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.some(k => haystack.includes(k))) {
      triggered.push(skill);
    }
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("## Your account's skills");
  lines.push(
    "The user has these custom skills installed. When a request matches a skill's trigger, follow that skill's instructions:"
  );
  for (const s of skills) {
    const trig = s.trigger ? ` (triggers: ${s.trigger})` : "";
    lines.push(`- **${s.name}** — ${s.description}${trig}`);
  }

  if (triggered.length > 0) {
    lines.push("");
    lines.push("### Active skills for this turn");
    for (const s of triggered) {
      lines.push("");
      lines.push(`#### ${s.name}`);
      lines.push(s.body);
    }
  }

  return lines.join("\n");
}
