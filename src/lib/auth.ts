import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";

const SESSION_COOKIE = "session_token";
const SESSION_DAYS = 30;
const TRIAL_DAYS = 14;
const CODE_TTL_MINUTES = 10;

export function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function addMinutes(minutes: number): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

/** Creates a login code for the given email and stores it. Returns the code to send. */
export async function createLoginCode(email: string): Promise<string> {
  const db = getDb();
  const code = generateCode();
  await db.execute({
    sql: `INSERT INTO login_codes (email, code, expires_at) VALUES (?, ?, ?)`,
    args: [email.toLowerCase().trim(), code, addMinutes(CODE_TTL_MINUTES)],
  });
  return code;
}

/** Validates a code; if valid, consumes it and returns true. */
export async function verifyLoginCode(email: string, code: string): Promise<boolean> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  const result = await db.execute({
    sql: `SELECT id FROM login_codes
          WHERE email = ? AND code = ? AND consumed = 0 AND expires_at > datetime('now')
          ORDER BY id DESC LIMIT 1`,
    args: [normalizedEmail, code],
  });

  if (result.rows.length === 0) return false;

  await db.execute({
    sql: `UPDATE login_codes SET consumed = 1 WHERE id = ?`,
    args: [result.rows[0].id as number],
  });

  return true;
}

/** Finds an existing user by email, or creates one with a fresh 14-day trial. */
export async function getOrCreateUser(email: string) {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.execute({
    sql: `SELECT * FROM users WHERE email = ?`,
    args: [normalizedEmail],
  });
  if (existing.rows.length > 0) return existing.rows[0];

  const inserted = await db.execute({
    sql: `INSERT INTO users (email, trial_ends_at, subscription_status) VALUES (?, ?, 'trial')`,
    args: [normalizedEmail, addDays(TRIAL_DAYS)],
  });

  const created = await db.execute({
    sql: `SELECT * FROM users WHERE id = ?`,
    args: [Number(inserted.lastInsertRowid)],
  });
  return created.rows[0];
}

export async function createSession(userId: number): Promise<string> {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  await db.execute({
    sql: `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    args: [token, userId, addDays(SESSION_DAYS)],
  });
  return token;
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Reads the current session cookie and returns the logged-in user row, or null. */
export async function getCurrentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT users.* FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE sessions.token = ? AND sessions.expires_at > datetime('now')`,
    args: [token],
  });

  return result.rows.length > 0 ? result.rows[0] : null;
}

export function isAccessActive(user: {
  subscription_status: string;
  trial_ends_at: string;
  subscription_ends_at?: string | null;
}): boolean {
  if (user.subscription_status === "active") {
    // NULL end date = legacy/manually activated subscription with no expiry.
    if (!user.subscription_ends_at) return true;
    if (new Date(user.subscription_ends_at) > new Date()) return true;
  }
  return new Date(user.trial_ends_at) > new Date();
}

// Unambiguous alphabet (no 0/O, 1/I/L) so users can type the code reliably.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generatePaymentCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Returns the user's payment code, generating and storing one on first use. */
export async function getOrCreatePaymentCode(userId: number): Promise<string> {
  const db = getDb();
  const row = await db.execute({
    sql: `SELECT payment_code FROM users WHERE id = ?`,
    args: [userId],
  });
  const existing = row.rows[0]?.payment_code;
  if (existing) return String(existing);

  const code = generatePaymentCode();
  await db.execute({
    sql: `UPDATE users SET payment_code = ? WHERE id = ? AND payment_code IS NULL`,
    args: [code, userId],
  });
  // Re-read in case a concurrent request won the race.
  const again = await db.execute({
    sql: `SELECT payment_code FROM users WHERE id = ?`,
    args: [userId],
  });
  return String(again.rows[0].payment_code);
}
