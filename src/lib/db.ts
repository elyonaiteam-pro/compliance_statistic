import { createClient, type Client } from "@libsql/client";
import { applySchema } from "./schema.mjs";

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

let _schemaPromise: Promise<void> | null = null;

/**
 * Creates/migrates the schema (see schema.mjs — shared with the cron script).
 * Runs once per server instance (a failed attempt is retried on the next call),
 * so it is cheap to call from every route.
 */
export function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = applySchema(getDb()).catch((err) => {
      _schemaPromise = null;
      throw err;
    });
  }
  return _schemaPromise;
}

/** Test helper: forget the cached client/schema state. */
export function resetDbForTests() {
  _client = null;
  _schemaPromise = null;
}
