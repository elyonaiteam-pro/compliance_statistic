// The monitoring job: check tracked procurements on ЕИС, record changes, notify users.
// Plain .mjs so `node scripts/check-updates.mjs` runs it without a build; all I/O
// (db, ЕИС fetching, e-mail, sleeping) is injected so it is fully testable.
import { applySchema } from "./schema.mjs";
import { buildUrl, detectChanges, fetchCard as defaultFetchCard, EisHttpError, EisParseError } from "./eis-core.mjs";

const FIELD_LABELS = /** @type {Record<string, string>} */ ({
  title: "Название",
  customer: "Заказчик",
  price: "Цена",
  status: "Статус",
  deadline: "Срок подачи заявок",
});

/** Procurements unchanged for this long are checked once a day instead of every run. */
const QUIET_AFTER_DAYS = 30;
/** After this many consecutive parse failures the remembered card URL variant is forgotten. */
const REDISCOVER_AFTER_FAILURES = 3;
/** Stop the run after this many consecutive network failures: ЕИС is down/blocked, hammering it helps nobody. */
const ABORT_AFTER_NETWORK_FAILURES = 3;
/** Give up on a notification after this many failed deliveries... */
const MAX_DELIVERY_ATTEMPTS = 5;
/** ...or when it is this old (stale news is worse than no news). */
const NOTIFICATION_MAX_AGE_DAYS = 3;

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function formatValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "price") {
    const n = Number(value);
    if (Number.isFinite(n)) return `${n.toLocaleString("ru-RU")} ₽`;
  }
  return String(value);
}

/**
 * @typedef {Object} ChangePayload
 * @property {string} regNumber
 * @property {string | null} title
 * @property {string | null} [noticeType] card URL variant, used for the "open in ЕИС" link
 * @property {{ field: string, oldValue: unknown, newValue: unknown }[]} changes
 */

/**
 * @param {ChangePayload} payload
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderChangeEmail(payload) {
  const { regNumber, title, noticeType, changes } = payload;
  const items = changes.map((c) => ({
    label: FIELD_LABELS[c.field] || c.field,
    from: formatValue(c.field, c.oldValue),
    to: formatValue(c.field, c.newValue),
  }));
  const li = items
    .map((i) => `<li><b>${escapeHtml(i.label)}</b>: ${escapeHtml(i.from)} → ${escapeHtml(i.to)}</li>`)
    .join("");
  const link = noticeType ? buildUrl(noticeType, regNumber) : null;
  return {
    subject: `Изменение по закупке № ${regNumber}`,
    html: `<p>По закупке <b>${escapeHtml(regNumber)}</b> (${escapeHtml(title)}) зафиксированы изменения:</p><ul>${li}</ul>${
      link ? `<p><a href="${escapeHtml(link)}">Открыть в ЕИС</a></p>` : ""
    }`,
    text: `По закупке ${regNumber} (${title ?? ""}) зафиксированы изменения:\n\n${items
      .map((i) => `- ${i.label}: ${i.from} → ${i.to}`)
      .join("\n")}${link ? `\n\nОткрыть в ЕИС: ${link}` : ""}`,
  };
}

/** SQL fragment: user currently has trial or paid access. Bind one ISO timestamp param. */
const USER_HAS_ACCESS_SQL = `(
  u.trial_ends_at > ?
  OR (u.subscription_status = 'active' AND (u.subscription_ends_at IS NULL OR u.subscription_ends_at > ?))
)`;

/**
 * Procurements worth checking now:
 *  - at least one tracking user still has access (nobody to notify = no point scraping ЕИС),
 *  - recently active ones every run; quiet ones (no change for 30 days) once a day.
 * Never-checked / least-recently-checked first.
 * @param {import("@libsql/client").Client} db
 * @param {Date} [now]
 */
export async function selectDueProcurements(db, now = new Date()) {
  const iso = now.toISOString();
  const result = await db.execute({
    sql: `SELECT p.* FROM procurements p
          WHERE EXISTS (
            SELECT 1 FROM user_procurements up
            JOIN users u ON u.id = up.user_id
            WHERE up.procurement_id = p.id AND ${USER_HAS_ACCESS_SQL}
          )
          AND (
            p.last_checked_at IS NULL
            OR p.updated_at > datetime('now', '-${QUIET_AFTER_DAYS} days')
            OR p.last_checked_at < datetime('now', '-1 day')
          )
          ORDER BY (p.last_checked_at IS NOT NULL), p.last_checked_at ASC, p.id ASC`,
    args: [iso, iso],
  });
  return result.rows;
}

/**
 * Checks one procurement. Detected changes, the row update and the notifications
 * they require are written in ONE transaction, so a crash can't lose an alert.
 * @param {import("@libsql/client").Client} db
 * @param {Record<string, unknown>} row
 * @param {typeof defaultFetchCard} fetchCard
 * @param {import("./eis-core.mjs").FetchOptions} fetchOptions
 * @returns {Promise<{ changed: boolean, queued: number }>}
 */
async function checkOne(db, row, fetchCard, fetchOptions) {
  const { snapshot, noticeType } = await fetchCard(String(row.reg_number), {
    ...fetchOptions,
    preferredType: /** @type {string | null} */ (row.notice_type ?? null),
  });
  const { changes, merged, suspicious } = detectChanges(row, snapshot);
  if (suspicious.length > 0) {
    console.warn(`[skip] ${row.reg_number}: пустые поля ${suspicious.join(", ")} — считаем сбоем парсинга, старые значения сохранены`);
  }

  if (changes.length === 0) {
    await db.execute({
      sql: `UPDATE procurements
            SET last_checked_at = datetime('now'), last_error = NULL, failure_count = 0, notice_type = ?
            WHERE id = ?`,
      args: [noticeType, Number(row.id)],
    });
    return { changed: false, queued: 0 };
  }

  const iso = new Date().toISOString();
  const subscribers = await db.execute({
    sql: `SELECT u.id FROM user_procurements up
          JOIN users u ON u.id = up.user_id
          WHERE up.procurement_id = ? AND ${USER_HAS_ACCESS_SQL}`,
    args: [Number(row.id), iso, iso],
  });

  /** @type {ChangePayload} */
  const payload = { regNumber: String(row.reg_number), title: merged.title, noticeType, changes };
  const payloadJson = JSON.stringify(payload);

  /** @type {import("@libsql/client").InStatement[]} */
  const statements = [];
  for (const c of changes) {
    statements.push({
      sql: `INSERT INTO procurement_changes (procurement_id, field, old_value, new_value) VALUES (?, ?, ?, ?)`,
      args: [Number(row.id), c.field, String(c.oldValue ?? ""), String(c.newValue ?? "")],
    });
  }
  statements.push({
    sql: `UPDATE procurements
          SET title = ?, customer = ?, price = ?, status = ?, deadline = ?, raw_json = ?,
              notice_type = ?, updated_at = datetime('now'), last_checked_at = datetime('now'),
              last_error = NULL, failure_count = 0
          WHERE id = ?`,
    args: [
      merged.title,
      merged.customer,
      merged.price,
      merged.status,
      merged.deadline,
      JSON.stringify(merged),
      noticeType,
      Number(row.id),
    ],
  });
  for (const sub of subscribers.rows) {
    statements.push({
      sql: `INSERT INTO notifications (user_id, procurement_id, payload) VALUES (?, ?, ?)`,
      args: [Number(sub.id), Number(row.id), payloadJson],
    });
  }
  await db.batch(statements, "write");

  console.log(`[CHANGED] ${row.reg_number}:`, changes.map((c) => c.field).join(", "));
  return { changed: true, queued: subscribers.rows.length };
}

/**
 * @param {import("@libsql/client").Client} db
 * @param {Record<string, unknown>} row
 * @param {unknown} err
 */
async function recordFailure(db, row, err) {
  const message = err instanceof Error ? err.message : String(err);
  const failures = Number(row.failure_count ?? 0) + 1;
  // A card that keeps failing to parse may have moved to another URL variant: forget it so it is re-probed.
  const forgetType = err instanceof EisParseError && failures >= REDISCOVER_AFTER_FAILURES;
  await db.execute({
    sql: `UPDATE procurements
          SET last_checked_at = datetime('now'), last_error = ?, failure_count = ?,
              notice_type = CASE WHEN ? THEN NULL ELSE notice_type END
          WHERE id = ?`,
    args: [message.slice(0, 500), failures, forgetType ? 1 : 0, Number(row.id)],
  });
}

/**
 * Sends queued notifications (including ones that failed in earlier runs).
 * @param {import("@libsql/client").Client} db
 * @param {(to: string, subject: string, html: string, text: string) => Promise<unknown>} sendEmail must throw on failure
 * @param {{ limit?: number, sleep?: (ms: number) => Promise<void>, pauseMs?: number }} [options]
 * @returns {Promise<{ sent: number, failed: number, expired: number }>}
 */
export async function deliverPendingNotifications(db, sendEmail, options = {}) {
  const { limit = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 0 } = options;

  const expired = await db.execute({
    sql: `UPDATE notifications
          SET status = 'failed', last_error = 'устарело, не отправлено'
          WHERE status = 'pending' AND created_at < datetime('now', '-${NOTIFICATION_MAX_AGE_DAYS} days')`,
    args: [],
  });

  const pending = await db.execute({
    sql: `SELECT n.id, n.payload, n.attempts, u.email
          FROM notifications n JOIN users u ON u.id = n.user_id
          WHERE n.status = 'pending'
          ORDER BY n.id ASC LIMIT ?`,
    args: [limit],
  });

  let sent = 0;
  let failed = 0;
  for (const n of pending.rows) {
    try {
      const mail = renderChangeEmail(JSON.parse(String(n.payload)));
      await sendEmail(String(n.email), mail.subject, mail.html, mail.text);
      await db.execute({
        sql: `UPDATE notifications SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`,
        args: [Number(n.id)],
      });
      sent++;
    } catch (err) {
      failed++;
      const attempts = Number(n.attempts) + 1;
      await db.execute({
        sql: `UPDATE notifications SET attempts = ?, last_error = ?, status = ? WHERE id = ?`,
        args: [
          attempts,
          (err instanceof Error ? err.message : String(err)).slice(0, 500),
          attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending",
          Number(n.id),
        ],
      });
    }
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { sent, failed, expired: expired.rowsAffected };
}

/**
 * @typedef {Object} MonitorSummary
 * @property {number} due procurements selected for checking
 * @property {number} checked
 * @property {number} changed
 * @property {number} failed
 * @property {number} skippedByBudget left unchecked because the time budget ran out
 * @property {number} skippedByOutage left unchecked because ЕИС looked unreachable (consecutive network failures)
 * @property {boolean} allFailed every attempted check failed (ЕИС blocked / down)
 * @property {{ sent: number, failed: number, expired: number } | null} notifications null if e-mail is not configured
 */

/**
 * @param {Object} deps
 * @param {import("@libsql/client").Client} deps.db
 * @param {((to: string, subject: string, html: string, text: string) => Promise<unknown>) | null} deps.sendEmail null = e-mail not configured (notifications stay queued)
 * @param {typeof defaultFetchCard} [deps.fetchCard]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.delayMs] pause between ЕИС requests (be polite, avoid bans)
 * @param {number} [deps.maxRuntimeMs] stop starting new checks after this long
 * @returns {Promise<MonitorSummary>}
 */
export async function runMonitor({
  db,
  sendEmail,
  fetchCard = defaultFetchCard,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  delayMs = 1000,
  maxRuntimeMs = 8 * 60 * 1000,
}) {
  await applySchema(db);

  const due = await selectDueProcurements(db);
  const startedAt = Date.now();
  let checked = 0;
  let changed = 0;
  let failed = 0;
  let skippedByBudget = 0;
  let skippedByOutage = 0;
  let networkFailuresInARow = 0;

  for (let i = 0; i < due.length; i++) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      skippedByBudget = due.length - i;
      console.warn(`Лимит времени исчерпан, не проверено закупок: ${skippedByBudget}`);
      break;
    }
    const row = due[i];
    try {
      const res = await checkOne(db, row, fetchCard, { sleep });
      checked++;
      networkFailuresInARow = 0;
      if (res.changed) changed++;
    } catch (err) {
      failed++;
      console.error(`failed checking ${row.reg_number}:`, err instanceof Error ? err.message : err);
      await recordFailure(db, row, err);
      const isNetwork = !(err instanceof EisParseError) && !(err instanceof EisHttpError && err.status === 404);
      networkFailuresInARow = isNetwork ? networkFailuresInARow + 1 : 0;
      if (networkFailuresInARow >= ABORT_AFTER_NETWORK_FAILURES && i < due.length - 1) {
        skippedByOutage = due.length - i - 1;
        console.error(`ЕИС недоступен (${networkFailuresInARow} сбоя подряд) — прерываем проверку, пропущено: ${skippedByOutage}`);
        break;
      }
    }
    if (delayMs > 0 && i < due.length - 1) await sleep(delayMs);
  }

  const notifications = sendEmail
    ? await deliverPendingNotifications(db, sendEmail, { sleep, pauseMs: Math.min(delayMs, 300) })
    : null;
  if (!sendEmail) console.warn("SMTP не настроен — уведомления остаются в очереди");

  const attempted = checked + failed;
  return {
    due: due.length,
    checked,
    changed,
    failed,
    skippedByBudget,
    skippedByOutage,
    allFailed: attempted > 0 && failed === attempted,
    notifications,
  };
}
