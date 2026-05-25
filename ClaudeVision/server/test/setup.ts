import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Test-wide deterministic-but-fresh setup. Each test file process gets:
// - a master key fixed in env so crypto.ts can encrypt/decrypt
// - a brand-new data dir so db.ts opens a clean SQLite file with all
//   migrations applied from scratch
// - empty bootstrap-admin env so first-run logic doesn't interfere
process.env.KEYS_ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
process.env.DATA_DIR =
  process.env.DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "aside-test-"));
delete process.env.BOOTSTRAP_ADMIN_EMAIL;
delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
