// Single source of truth for the database schema.
// Plain .mjs (JSDoc-typed) so BOTH the Next.js app (src/lib/db.ts) and the
// standalone cron script (scripts/check-updates.mjs) apply exactly the same
// migrations — no more hand-copied ALTER TABLE hacks in the script.

/**
 * @param {import("@libsql/client").Client} db
 * @param {string} table
 * @param {string} column
 * @param {string} ddl column definition, e.g. "TEXT" or "INTEGER NOT NULL DEFAULT 0"
 */
async function addColumnIfMissing(db, table, column, ddl) {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  if (!cols.rows.some((r) => String(r.name) === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Creates / migrates every table. Idempotent: safe to run on every boot.
 * @param {import("@libsql/client").Client} db
 */
export async function applySchema(db) {
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
  await addColumnIfMissing(db, "users", "payment_code", "TEXT");
  await addColumnIfMissing(db, "users", "subscription_ends_at", "TEXT");

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

  // --- Login-code hardening ---
  // attempts: wrong guesses against a code (brute-force protection).
  // ip: requester address, used to rate-limit code requests per IP.
  await addColumnIfMissing(db, "login_codes", "attempts", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "login_codes", "ip", "TEXT");
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_login_codes_email_created ON login_codes(email, created_at)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_login_codes_ip_created ON login_codes(ip, created_at)"
  );

  // --- Monitoring reliability ---
  // notice_type:     which ЕИС card URL variant (zk20, ea20, ...) works for this procurement.
  // last_checked_at: last time the monitor looked at it (datetime('now') format, UTC).
  // last_error / failure_count: why/how many times in a row the last checks failed.
  await addColumnIfMissing(db, "procurements", "notice_type", "TEXT");
  await addColumnIfMissing(db, "procurements", "last_checked_at", "TEXT");
  await addColumnIfMissing(db, "procurements", "last_error", "TEXT");
  await addColumnIfMissing(db, "procurements", "failure_count", "INTEGER NOT NULL DEFAULT 0");

  // Outbox: a detected change is recorded together with the notifications it must
  // produce (one transaction), and delivery is retried on later runs if SMTP fails.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      procurement_id INTEGER NOT NULL REFERENCES procurements(id),
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );
  `);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, id)"
  );
}
