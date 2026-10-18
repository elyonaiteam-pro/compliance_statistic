import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { getDb, ensureSchema, resetDbForTests } from "@/lib/db";

/** Fresh, isolated SQLite file DB with the real schema applied. */
export async function freshDb(): Promise<Client> {
  const file = path.join(tmpdir(), `compliance-test-${randomUUID()}.db`).replace(/\\/g, "/");
  process.env.TURSO_DATABASE_URL = `file:${file}`;
  delete process.env.TURSO_AUTH_TOKEN;
  resetDbForTests();
  await ensureSchema();
  return getDb();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoInDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export async function makeUser(
  db: Client,
  email: string,
  opts: { trialDays?: number; status?: string; subscriptionEndsAt?: string | null } = {}
): Promise<number> {
  const res = await db.execute({
    sql: `INSERT INTO users (email, trial_ends_at, subscription_status, subscription_ends_at)
          VALUES (?, ?, ?, ?)`,
    args: [email, isoInDays(opts.trialDays ?? 14), opts.status ?? "trial", opts.subscriptionEndsAt ?? null],
  });
  return Number(res.lastInsertRowid);
}

export async function makeSession(db: Client, userId: number, expiresAt = isoInDays(30)): Promise<string> {
  const token = randomUUID().replace(/-/g, "");
  await db.execute({
    sql: `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    args: [token, userId, expiresAt],
  });
  return token;
}

export async function makeProcurement(db: Client, regNumber: string, userId?: number): Promise<number> {
  const res = await db.execute({
    sql: `INSERT INTO procurements (reg_number, title, customer, price, status, deadline, raw_json)
          VALUES (?, 'Тест', 'Заказчик', 1000, 'Подача заявок', '01.01.2030', '{"secret":true}')`,
    args: [regNumber],
  });
  const id = Number(res.lastInsertRowid);
  if (userId !== undefined) {
    await db.execute({
      sql: `INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)`,
      args: [userId, id],
    });
  }
  return id;
}
