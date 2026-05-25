/**
 * CLI recovery: reset a user's password.
 *
 * Run on prod:
 *   docker exec -it <container> node dist/reset-password.js list
 *   docker exec -it <container> node dist/reset-password.js <email> <new-password>
 *
 * Run locally:
 *   npm run reset-password -- list
 *   npm run reset-password -- alice@example.com hunter2hunter2
 *
 * Connects to the same DB as the server (DATA_DIR/aside.db) and rewrites
 * password_hash. Does not require the server to be running, but be aware
 * that better-sqlite3 + WAL mode can briefly contend with a live writer.
 */
import { getDb, closeDb } from "./db.js";
import { hashPassword } from "./crypto.js";

interface UserListRow {
  id: string;
  email: string;
  is_admin: number;
  created_at: number;
}

function usage(): never {
  console.error("Usage:");
  console.error("  node dist/reset-password.js list");
  console.error("  node dist/reset-password.js <email> <new-password>");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const db = getDb();

if (args[0] === "list") {
  const rows = db
    .prepare(
      "SELECT id, email, is_admin, created_at FROM users ORDER BY created_at"
    )
    .all() as UserListRow[];
  if (rows.length === 0) {
    console.log("No users in DB.");
  } else {
    for (const r of rows) {
      const tag = r.is_admin === 1 ? "[admin]" : "[user] ";
      console.log(`${tag} ${r.email}`);
    }
  }
  closeDb();
  process.exit(0);
}

if (args.length !== 2) usage();
const [emailArg, newPassword] = args;
if (typeof newPassword !== "string" || newPassword.length < 8) {
  console.error("Password must be at least 8 characters.");
  closeDb();
  process.exit(1);
}

const normalized = emailArg.toLowerCase();
const hash = hashPassword(newPassword);
const result = db
  .prepare("UPDATE users SET password_hash = ? WHERE email = ?")
  .run(hash, normalized);

if (result.changes === 0) {
  console.error(
    `No user found with email "${emailArg}". Run "list" to see registered emails.`
  );
  closeDb();
  process.exit(1);
}

console.log(`Password reset for ${normalized}. Log in with the new password.`);
closeDb();
