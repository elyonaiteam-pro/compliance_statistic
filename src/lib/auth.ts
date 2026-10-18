import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";

const SESSION_COOKIE = "session_token";
const SESSION_DAYS = 30;
const TRIAL_DAYS = 14;
const CODE_TTL_MINUTES = 10;

// Login-code abuse limits.
const MAX_CODE_ATTEMPTS = 5; // wrong guesses before a code is burned
const RESEND_COOLDOWN_SECONDS = 60; // min gap between codes for one email
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
const MAX_CODES_PER_IP_PER_HOUR = 10;

/** Thrown when a login code is requested too often. `message` is user-facing (Russian). */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Cryptographically secure 6-digit code. */
export function generateCode(): string {
  return randomInt(100000, 1000000).toString();
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

/** Current time as ISO string — same format as every `expires_at` we store. */
function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Strict single-address check. Rejects commas/semicolons/whitespace/angle brackets
 * so a crafted value can't make nodemailer send to several recipients.
 */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const value = email.trim();
  if (value.length < 6 || value.length > 254) return false;
  return EMAIL_RE.test(value);
}

/**
 * Creates a login code for the given email and stores it. Returns the code to send.
 * Throws RateLimitError when the email or IP asked for codes too often.
 * Older unused codes for the same email are invalidated, so only the newest works.
 */
export async function createLoginCode(email: string, ip?: string | null): Promise<string> {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);

  // created_at uses SQLite's datetime('now') format, so compare with the same function.
  const recent = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM login_codes
          WHERE email = ? AND created_at > datetime('now', ?)`,
    args: [normalizedEmail, `-${RESEND_COOLDOWN_SECONDS} seconds`],
  });
  if (Number(recent.rows[0].c) > 0) {
    throw new RateLimitError("Код уже отправлен. Подождите минуту перед повторной отправкой.");
  }

  const hourEmail = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM login_codes
          WHERE email = ? AND created_at > datetime('now', '-1 hour')`,
    args: [normalizedEmail],
  });
  if (Number(hourEmail.rows[0].c) >= MAX_CODES_PER_EMAIL_PER_HOUR) {
    throw new RateLimitError("Слишком много запросов кода. Попробуйте через час.");
  }

  if (ip) {
    const hourIp = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM login_codes
            WHERE ip = ? AND created_at > datetime('now', '-1 hour')`,
      args: [ip],
    });
    if (Number(hourIp.rows[0].c) >= MAX_CODES_PER_IP_PER_HOUR) {
      throw new RateLimitError("Слишком много запросов с вашего адреса. Попробуйте позже.");
    }
  }

  const code = generateCode();
  await db.batch(
    [
      { sql: `UPDATE login_codes SET consumed = 1 WHERE email = ? AND consumed = 0`, args: [normalizedEmail] },
      {
        sql: `INSERT INTO login_codes (email, code, expires_at, ip) VALUES (?, ?, ?, ?)`,
        args: [normalizedEmail, code, addMinutes(CODE_TTL_MINUTES), ip ?? null],
      },
    ],
    "write"
  );
  return code;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Validates a code; if valid, consumes it and returns true.
 * Only the newest unused, unexpired code counts. Each wrong guess burns an attempt,
 * and after MAX_CODE_ATTEMPTS the code is dead.
 */
export async function verifyLoginCode(email: string, code: string): Promise<boolean> {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);
  const candidate = String(code ?? "").trim();
  if (!/^\d{6}$/.test(candidate)) return false;

  const result = await db.execute({
    sql: `SELECT id, code, attempts FROM login_codes
          WHERE email = ? AND consumed = 0 AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
    args: [normalizedEmail, nowIso()],
  });
  if (result.rows.length === 0) return false;

  const row = result.rows[0];
  const id = Number(row.id);
  const attempts = Number(row.attempts ?? 0);
  if (attempts >= MAX_CODE_ATTEMPTS) return false;

  if (!safeEqual(String(row.code), candidate)) {
    // Burn the code once the attempt budget is spent.
    await db.execute({
      sql: `UPDATE login_codes
            SET attempts = attempts + 1,
                consumed = CASE WHEN attempts + 1 >= ? THEN 1 ELSE consumed END
            WHERE id = ?`,
      args: [MAX_CODE_ATTEMPTS, id],
    });
    return false;
  }

  // Atomic single-use: if two requests race, only one flips consumed 0 -> 1.
  const consumed = await db.execute({
    sql: `UPDATE login_codes SET consumed = 1 WHERE id = ? AND consumed = 0`,
    args: [id],
  });
  return consumed.rowsAffected === 1;
}

/** Finds an existing user by email, or creates one with a fresh 14-day trial. */
export async function getOrCreateUser(email: string) {
  const db = getDb();
  const normalizedEmail = normalizeEmail(email);

  // INSERT OR IGNORE + re-select: safe if two logins for a new email race.
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (email, trial_ends_at, subscription_status)
          VALUES (?, ?, 'trial')`,
    args: [normalizedEmail, addDays(TRIAL_DAYS)],
  });

  const user = await db.execute({
    sql: `SELECT * FROM users WHERE email = ?`,
    args: [normalizedEmail],
  });
  return user.rows[0];
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
          WHERE sessions.token = ? AND sessions.expires_at > ?`,
    args: [token, nowIso()],
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

/** True if the user row returned by getCurrentUser() currently has paid/trial access. */
export function userHasAccess(user: Record<string, unknown>): boolean {
  return isAccessActive({
    subscription_status: String(user.subscription_status),
    trial_ends_at: String(user.trial_ends_at),
    subscription_ends_at: user.subscription_ends_at ? String(user.subscription_ends_at) : null,
  });
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
