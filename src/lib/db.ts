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
}
