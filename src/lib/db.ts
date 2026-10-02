import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

export function getDb(): Client {
  if (_client) return _client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Create a Turso DB and add TURSO_DATABASE_URL / TURSO_AUTH_TOKEN to .env.local"
    );
  }

  _client = createClient({ url, authToken });
  return _client;
}

/** Creates the schema if it doesn't exist yet. Safe to call on every boot. */
export async function ensureSchema() {
  const db = getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS procurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_number TEXT NOT NULL UNIQUE,
      title TEXT,
      customer TEXT,
      price REAL,
      status TEXT,
      deadline TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS procurement_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procurement_id INTEGER NOT NULL REFERENCES procurements(id),
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Kept for backward compatibility / optional future browser push;
  // email is now the primary notification channel (see users/user_procurements).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procurement_id INTEGER NOT NULL REFERENCES procurements(id),
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(procurement_id, endpoint)
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      trial_ends_at TEXT NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'trial',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_procurements (
      user_id INTEGER NOT NULL REFERENCES users(id),
      procurement_id INTEGER NOT NULL REFERENCES procurements(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, procurement_id)
    );
  `);

  // --- Payments (DonatePay) ---
  // users.payment_code: short code the user puts in the donation comment.
  // users.subscription_ends_at: NULL for legacy/manual 'active' users = no expiry.
  const cols = await db.execute("PRAGMA table_info(users)");
  const colNames = new Set(cols.rows.map((r) => String(r.name)));
  if (!colNames.has("payment_code")) {
    await db.execute("ALTER TABLE users ADD COLUMN payment_code TEXT");
  }
  if (!colNames.has("subscription_ends_at")) {
    await db.execute("ALTER TABLE users ADD COLUMN subscription_ends_at TEXT");
  }

  // One row per processed DonatePay transaction (idempotency via UNIQUE id).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donatepay_id TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id),
      amount REAL NOT NULL,
      comment TEXT,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

}
