import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  encryptApiKey,
  decryptApiKey,
  generateToken,
  previewKey,
} from "../src/crypto.js";

describe("password hashing", () => {
  it("verifies the same password it hashed", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("Correct Horse Battery Staple", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
  });

  it("uses a random salt — same password produces a different hash", () => {
    const a = hashPassword("hunter2");
    const b = hashPassword("hunter2");
    expect(a).not.toBe(b);
    expect(verifyPassword("hunter2", a)).toBe(true);
    expect(verifyPassword("hunter2", b)).toBe(true);
  });

  it("rejects malformed stored hashes safely", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(verifyPassword("anything", "scrypt$1$nope")).toBe(false);
  });
});

describe("API key envelope encryption", () => {
  it("round-trips a key", () => {
    const blob = encryptApiKey("sk-ant-test-key-1234567890");
    expect(blob).toMatch(/^gcm\$1\$[0-9a-f]+\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(decryptApiKey(blob)).toBe("sk-ant-test-key-1234567890");
  });

  it("returns null on null/empty input", () => {
    expect(decryptApiKey(null)).toBeNull();
    expect(decryptApiKey(undefined)).toBeNull();
    expect(decryptApiKey("")).toBeNull();
  });

  it("returns null on tampered ciphertext (auth tag check)", () => {
    const blob = encryptApiKey("sk-ant-original");
    const parts = blob.split("$");
    // Flip a byte in the ciphertext
    const ct = Buffer.from(parts[3], "hex");
    ct[0] ^= 0xff;
    const tampered = `${parts[0]}$${parts[1]}$${parts[2]}$${ct.toString("hex")}$${parts[4]}`;
    expect(decryptApiKey(tampered)).toBeNull();
  });

  it("returns null on malformed blobs (no leak)", () => {
    expect(decryptApiKey("nope")).toBeNull();
    expect(decryptApiKey("gcm$1$badhex$badhex$badhex")).toBeNull();
  });

  it("uses a fresh IV per encrypt — same plaintext yields different ciphertext", () => {
    const a = encryptApiKey("same-key");
    const b = encryptApiKey("same-key");
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe("same-key");
    expect(decryptApiKey(b)).toBe("same-key");
  });
});

describe("misc crypto helpers", () => {
  it("generateToken returns hex of the expected length", () => {
    const t = generateToken(16);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it("previewKey masks short keys and elides long ones", () => {
    expect(previewKey(null)).toBeNull();
    expect(previewKey("short")).toBe("•••••");
    expect(previewKey("sk-ant-abcdef-XYZ")).toBe("sk-a…-XYZ");
  });
});
