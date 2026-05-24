import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

// ── Password hashing (scrypt) ──
// Format stored in users.password_hash: `scrypt$N$r$p$saltHex$keyHex`
// where N/r/p are the scrypt parameters; we use Node's defaults (N=16384).

const SCRYPT_KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return `scrypt$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ── Symmetric envelope encryption for API keys (AES-256-GCM) ──
// Format stored: `gcm$1$ivHex$ctHex$tagHex`. The master key comes from
// KEYS_ENCRYPTION_KEY in .env — 64 hex chars (32 bytes). If unset on
// first run we generate one and tell the operator to persist it.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

let cachedMasterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const hex = process.env.KEYS_ENCRYPTION_KEY?.trim();
  if (!hex) {
    throw new Error(
      "KEYS_ENCRYPTION_KEY is not set. Run `openssl rand -hex 32` and put the result in .env."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "KEYS_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Run `openssl rand -hex 32` to generate one."
    );
  }
  cachedMasterKey = Buffer.from(hex, "hex");
  return cachedMasterKey;
}

export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return "";
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm$1$${iv.toString("hex")}$${ct.toString("hex")}$${tag.toString("hex")}`;
}

export function decryptApiKey(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const parts = blob.split("$");
  if (parts.length !== 5 || parts[0] !== "gcm") return null;
  try {
    const key = getMasterKey();
    const iv = Buffer.from(parts[2], "hex");
    const ct = Buffer.from(parts[3], "hex");
    const tag = Buffer.from(parts[4], "hex");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

// Helper for client-safe display: returns "sk-…7f3a" style preview.
export function previewKey(plaintext: string | null): string | null {
  if (!plaintext) return null;
  if (plaintext.length <= 10) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

// ── Cryptographic random tokens (invite codes etc.) ──
export function generateToken(byteLen: number = 24): string {
  return randomBytes(byteLen).toString("hex");
}

// Convenience: derive a non-secret master-key suggestion at startup
// if the operator hasn't set one yet, printed once and only once.
export function suggestMasterKey(): string {
  return randomBytes(KEY_LEN).toString("hex");
}
