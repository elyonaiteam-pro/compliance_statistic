import { getDb } from "@/lib/db";

// Mirrors scripts/check-payments.mjs so users can trigger a check on demand
// ("Я оплатил") instead of waiting for the scheduled run. Keep both in sync.

const PRICE_RUB = 400;
const DAYS_PER_PERIOD = 30;
const TRANSACTIONS_URL =
  process.env.DONATEPAY_TRANSACTIONS_URL || "https://donatepay.ru/api/v1/transactions";

// DonatePay allows one call per ~20s per operation; also keeps users from spamming the button.
const MIN_INTERVAL_MS = 20_000;
let lastRun = 0;

export type PaymentCheckResult =
  | { ok: true; activatedUserIds: number[] }
  | { ok: false; reason: "throttled" | "rate_limited" | "not_configured" | "error" };

interface DonatePayTransaction {
  id: number | string;
  sum: number | string;
  comment?: string | null;
}

/** Uppercase and drop everything except letters/digits, so "7kq2 mx" still matches. */
function normalize(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export async function processDonatePayTransactions(): Promise<PaymentCheckResult> {
  const apiKey = process.env.DONATEPAY_API_KEY;
  if (!apiKey) return { ok: false, reason: "not_configured" };

  if (Date.now() - lastRun < MIN_INTERVAL_MS) return { ok: false, reason: "throttled" };
  lastRun = Date.now();

  const url = new URL(TRANSACTIONS_URL);
  url.searchParams.set("access_token", apiKey);
  url.searchParams.set("limit", "100");
  url.searchParams.set("order", "DESC");
  url.searchParams.set("type", "donation");
  url.searchParams.set("status", "success");

  let list: DonatePayTransaction[];
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 429) return { ok: false, reason: "rate_limited" };
    if (!res.ok) return { ok: false, reason: "error" };
    const json = await res.json();
    if (json?.status && json.status !== "success") return { ok: false, reason: "error" };
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) return { ok: false, reason: "error" };
    list = data;
  } catch {
    return { ok: false, reason: "error" };
  }

  const db = getDb();
  const usersRes = await db.execute(
    "SELECT id, subscription_status, subscription_ends_at, payment_code FROM users WHERE payment_code IS NOT NULL"
  );
  const users = usersRes.rows.map((r) => ({
    id: Number(r.id),
    subscription_status: String(r.subscription_status),
    subscription_ends_at: r.subscription_ends_at ? String(r.subscription_ends_at) : null,
    payment_code: normalize(r.payment_code),
  }));

  const activated: number[] = [];

  // Oldest first so stacked payments extend in order.
  for (const tx of [...list].reverse()) {
    const txId = String(tx.id);
    const amount = Number(tx.sum);
    const comment = String(tx.comment ?? "");

    const seen = await db.execute({
      sql: "SELECT 1 FROM payments WHERE donatepay_id = ?",
      args: [txId],
    });
    if (seen.rows.length > 0) continue;

    const normalizedComment = normalize(comment);
    const user = users.find((u) => u.payment_code && normalizedComment.includes(u.payment_code));

    if (!user) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO payments (donatepay_id, user_id, amount, comment, outcome)
              VALUES (?, NULL, ?, ?, 'no_match')`,
        args: [txId, amount, comment],
      });
      continue;
    }

    const periods = Math.floor(amount / PRICE_RUB);
    if (periods < 1) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO payments (donatepay_id, user_id, amount, comment, outcome)
              VALUES (?, ?, ?, ?, 'underpaid')`,
        args: [txId, user.id, amount, comment],
      });
      continue;
    }

    const now = new Date();
    let base = now;
    if (user.subscription_status === "active" && user.subscription_ends_at) {
      const current = new Date(user.subscription_ends_at);
      if (current > now) base = current;
    }
    const end = new Date(base);
    end.setDate(end.getDate() + periods * DAYS_PER_PERIOD);
    const newEnd = end.toISOString();

    try {
      // Atomic: record the payment and extend the subscription together.
      await db.batch(
        [
          {
            sql: `INSERT INTO payments (donatepay_id, user_id, amount, comment, outcome)
                  VALUES (?, ?, ?, ?, 'activated')`,
            args: [txId, user.id, amount, comment],
          },
          {
            sql: `UPDATE users SET subscription_status = 'active', subscription_ends_at = ? WHERE id = ?`,
            args: [newEnd, user.id],
          },
        ],
        "write"
      );
    } catch {
      // UNIQUE violation = the scheduled script processed it concurrently; nothing to do.
      continue;
    }

    user.subscription_status = "active";
    user.subscription_ends_at = newEnd;
    activated.push(user.id);
  }

  return { ok: true, activatedUserIds: activated };
}
