import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { applySchema } from "@/lib/schema.mjs";

function tempDb() {
  const file = path.join(tmpdir(), `compliance-schema-${randomUUID()}.db`).replace(/\\/g, "/");
  return createClient({ url: `file:${file}` });
}

async function columns(db: ReturnType<typeof tempDb>, table: string) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => String(row.name));
}

describe("applySchema", () => {
  it("creates everything on an empty database and is idempotent", async () => {
    const db = tempDb();
    await applySchema(db);
    await applySchema(db);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = tables.rows.map((r) => String(r.name));
    for (const t of ["procurements", "procurement_changes", "users", "login_codes", "sessions", "user_procurements", "payments", "notifications"]) {
      expect(names).toContain(t);
    }
  });

  it("migrates a database from before the audit without losing data", async () => {
    const db = tempDb();
    // Schema exactly as it was in production before this work.
    await db.execute(`CREATE TABLE procurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reg_number TEXT NOT NULL UNIQUE, title TEXT, customer TEXT,
      price REAL, status TEXT, deadline TEXT, raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, trial_ends_at TEXT NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'trial', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    await db.execute("INSERT INTO procurements (reg_number, title, price) VALUES ('0173200001424000001', 'Старая', 5)");
    await db.execute("INSERT INTO users (email, trial_ends_at) VALUES ('old@example.com', '2030-01-01T00:00:00.000Z')");

    await applySchema(db);

    expect(await columns(db, "procurements")).toEqual(
      expect.arrayContaining(["notice_type", "last_checked_at", "last_error", "failure_count"])
    );
    expect(await columns(db, "users")).toEqual(expect.arrayContaining(["payment_code", "subscription_ends_at"]));
    expect(await columns(db, "login_codes")).toEqual(expect.arrayContaining(["attempts", "ip"]));

    const p = await db.execute("SELECT title, price, failure_count, last_checked_at FROM procurements");
    expect({ ...p.rows[0] }).toEqual({ title: "Старая", price: 5, failure_count: 0, last_checked_at: null });
    const u = await db.execute("SELECT email FROM users");
    expect(u.rows[0].email).toBe("old@example.com");
  });
});
