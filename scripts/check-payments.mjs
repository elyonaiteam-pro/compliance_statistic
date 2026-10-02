// Standalone script run by GitHub Actions on a schedule.
// Polls DonatePay for new successful donations, matches each one to a user via
// the payment code written in the donation comment, and extends the user's
// subscription (400 RUB = 30 days, multiples stack).
//
// Usage:
//   node scripts/check-payments.mjs          # process payments for real
//   node scripts/check-payments.mjs --dry    # only print what would happen
//
// Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, DONATEPAY_API_KEY,
//      (optional) GMAIL_USER, GMAIL_APP_PASSWORD, DONATEPAY_TRANSACTIONS_URL
import { createClient } from "@libsql/client";
import nodemailer from "nodemailer";

const DRY = process.argv.includes("--dry");

const PRICE_RUB = 400;
const DAYS_PER_PERIOD = 30;
const TRANSACTIONS_URL =
  process.env.DONATEPAY_TRANSACTIONS_URL || "https://donatepay.ru/api/v1/transactions";

const API_KEY = process.env.DONATEPAY_API_KEY;
if (!API_KEY) {
  console.error("DONATEPAY_API_KEY is not set");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const transporter =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      })
    : null;

async function sendEmail(to, subject, text) {
  if (!transporter) return;
  try {
    await transporter.sendMail({ from: GMAIL_USER, to, subject, text });
  } catch (err) {
    console.error(`Не удалось отправить письмо ${to}:`, err.message);
  }
}

async function ensureSchema() {
  const cols = await db.execute("PRAGMA table_info(users)");
  const names = new Set(cols.rows.map((r) => String(r.name)));
  if (!names.has("payment_code")) {
    await db.execute("ALTER TABLE users ADD COLUMN payment_code TEXT");
  }
  if (!names.has("subscription_ends_at")) {
    await db.execute("ALTER TABLE users ADD COLUMN subscription_ends_at TEXT");
  }
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

async function fetchTransactions() {
  const url = new URL(TRANSACTIONS_URL);
  url.searchParams.set("access_token", API_KEY);
  url.searchParams.set("limit", "100");
  url.searchParams.set("order", "DESC");
  url.searchParams.set("type", "donation");
  url.searchParams.set("status", "success");

  const res = await fetch(url);
  if (res.status === 429) {
    console.warn("DonatePay: 429 (слишком много запросов) — попробуем в следующий раз");
    return null;
  }
  if (!res.ok) {
    // Never print the URL: it contains the API key.
    throw new Error(`DonatePay вернул HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json && json.status && json.status !== "success") {
    throw new Error(`DonatePay API: ${json.status} ${json.message || ""}`.trim());
  }
  const list = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(list)) {
    throw new Error("Неожиданный формат ответа DonatePay (нет массива data)");
  }
  return list;
}

/** Uppercase and drop everything except letters/digits, so "7kq2 mx" still matches. */
function normalize(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function extendedEnd(user, days) {
  const now = new Date();
  let base = now;
  if (user.subscription_status === "active" && user.subscription_ends_at) {
    const current = new Date(user.subscription_ends_at);
    if (current > now) base = current;
  }
  const end = new Date(base);
  end.setDate(end.getDate() + days);
  return end.toISOString();
}

async function main() {
  await ensureSchema();

  const transactions = await fetchTransactions();
  if (transactions === null) return;
  console.log(`Получено транзакций: ${transactions.length}`);

  if (DRY && transactions[0]) {
    // Helps verify the field names against the real API response.
    console.log("Пример транзакции:", JSON.stringify(transactions[0]));
  }

  const usersRes = await db.execute(
    "SELECT id, email, subscription_status, subscription_ends_at, payment_code FROM users WHERE payment_code IS NOT NULL"
  );
  const users = usersRes.rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
    subscription_status: String(r.subscription_status),
    subscription_ends_at: r.subscription_ends_at ? String(r.subscription_ends_at) : null,
    payment_code: normalize(r.payment_code),
  }));

  // Process oldest first so stacked payments extend in order.
  const ordered = [...transactions].reverse();

  for (const tx of ordered) {
    const txId = String(tx.id);
    const amount = Number(tx.sum);
    const comment = tx.comment ?? "";

    const seen = await db.execute({
      sql: "SELECT 1 FROM payments WHERE donatepay_id = ?",
      args: [txId],
    });
    if (seen.rows.length > 0) continue;

    const normalizedComment = normalize(comment);
    const user = users.find((u) => u.payment_code && normalizedComment.includes(u.payment_code));

    if (!user) {
      console.log(`[нет кода] #${txId} ${amount} ₽ — комментарий не содержит код`);
      if (!DRY) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO payments (donatepay_id, user_id, amount, comment, outcome)
                VALUES (?, NULL, ?, ?, 'no_match')`,
          args: [txId, amount, String(comment)],
        });
      }
      continue;
    }

    const periods = Math.floor(amount / PRICE_RUB);
    if (periods < 1) {
      console.log(`[мало] #${txId} ${amount} ₽ от ${user.email} — меньше ${PRICE_RUB} ₽`);
      if (!DRY) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO payments (donatepay_id, user_id, amount, comment, outcome)
                VALUES (?, ?, ?, ?, 'underpaid')`,
          args: [txId, user.id, amount, String(comment)],
        });
      }
      continue;
    }

    const newEnd = extendedEnd(user, periods * DAYS_PER_PERIOD);
    console.log(
      `[ОПЛАТА] #${txId} ${amount} ₽ от ${user.email} → подписка до ${newEnd.slice(0, 10)}`
    );
    if (DRY) continue;

    // Atomic: record the payment and extend the subscription together.
    try {
      await db.batch(
        [
          {
            sql: `INSERT INTO payments (donatepay_id, user_id, amount, comment, outcome)
                  VALUES (?, ?, ?, ?, 'activated')`,
            args: [txId, user.id, amount, String(comment)],
          },
          {
            sql: `UPDATE users SET subscription_status = 'active', subscription_ends_at = ? WHERE id = ?`,
            args: [newEnd, user.id],
          },
        ],
        "write"
      );
    } catch (err) {
      // UNIQUE violation = the web app's "Я оплатил" check already processed it.
      console.log(`[пропуск] #${txId} уже обработан (${err.message})`);
      continue;
    }

    // Keep in-memory state current in case the same user has several payments in this batch.
    user.subscription_status = "active";
    user.subscription_ends_at = newEnd;

    await sendEmail(
      user.email,
      "Подписка продлена",
      `Спасибо за оплату! Подписка активна до ${newEnd.slice(0, 10)}.`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
