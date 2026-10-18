// Standalone script run by GitHub Actions on a schedule.
// Duplicates the fetch/parse logic from src/lib/eis.ts in plain JS so it
// runs with `node` alone, no Next.js build needed. Notifies users by email
// (Gmail SMTP) instead of browser push — see src/lib/auth.ts / users table.
// KEEP THE PARSER IN SYNC with src/lib/eis.ts (parseProcurementHtml).
import { createClient } from "@libsql/client";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

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

async function sendEmail(to, subject, html, text) {
  if (!transporter) {
    console.warn("GMAIL_USER/GMAIL_APP_PASSWORD не заданы — письмо не отправлено:", to, subject);
    return;
  }
  try {
    await transporter.sendMail({ from: GMAIL_USER, to, subject, html, text });
  } catch (err) {
    console.error(`Не удалось отправить письмо ${to}:`, err.message);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sectionByTitle($, titleText) {
  let result = null;
  $(".cardMainInfo__section").each((_, el) => {
    const title = $(el).find(".cardMainInfo__title").first().text().trim();
    if (title === titleText) {
      result = $(el).find(".cardMainInfo__content").first().text().trim() || null;
    }
  });
  return result;
}

async function fetchProcurement(regNumber) {
  const url = `https://zakupki.gov.ru/epz/order/notice/zk20/view/common-info.html?regNumber=${encodeURIComponent(
    regNumber
  )}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ЕИС вернул ${res.status} для ${regNumber}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  // Guard: a captcha / block / changed-layout page must NOT be treated as "all fields became empty".
  if ($(".cardMainInfo__section").length === 0) {
    throw new Error(`Страница ЕИС для ${regNumber} не похожа на карточку закупки (блок/капча/смена вёрстки?)`);
  }

  const title = sectionByTitle($, "Объект закупки");
  const customer = sectionByTitle($, "Заказчик");
  if (title === null && customer === null) {
    throw new Error(`Не удалось распознать карточку закупки ${regNumber}`);
  }
  const status = $(".cardMainInfo__state").first().text().trim() || null;
  const priceText = $(".cardMainInfo__content.cost")
    .first()
    .text()
    .replace(/[^\d,.]/g, "")
    .replace(",", ".");
  const parsedPrice = priceText ? parseFloat(priceText) : NaN;
  const price = Number.isFinite(parsedPrice) ? parsedPrice : null;
  const deadline = sectionByTitle($, "Окончание подачи заявок");

  return { regNumber, title, customer, price, status, deadline };
}

const FIELDS = ["title", "customer", "price", "status", "deadline"];
const FIELD_LABELS = {
  title: "Название",
  customer: "Заказчик",
  price: "Цена",
  status: "Статус",
  deadline: "Срок подачи заявок",
};

async function checkOne(row) {
  const fresh = await fetchProcurement(row.reg_number);
  const changes = [];

  // Core fields that never legitimately become empty once known; an empty value
  // here means a partial/odd page, so we keep the old value instead of reporting a change.
  const NEVER_EMPTY = new Set(["title", "customer", "price"]);

  for (const field of FIELDS) {
    const oldValue = row[field];
    const newValue = fresh[field];
    if (NEVER_EMPTY.has(field) && (newValue === null || newValue === "") && oldValue != null && oldValue !== "") {
      console.warn(`[skip] ${row.reg_number}: поле ${field} пришло пустым — считаем сбоем парсинга`);
      fresh[field] = oldValue;
      continue;
    }
    if (String(oldValue ?? "") !== String(newValue ?? "")) {
      changes.push({ field, oldValue, newValue });
    }
  }

  if (changes.length === 0) {
    console.log(`[no change] ${row.reg_number}`);
    return;
  }

  console.log(`[CHANGED] ${row.reg_number}:`, changes);

  for (const c of changes) {
    await db.execute({
      sql: `INSERT INTO procurement_changes (procurement_id, field, old_value, new_value)
            VALUES (?, ?, ?, ?)`,
      args: [row.id, c.field, String(c.oldValue ?? ""), String(c.newValue ?? "")],
    });
  }

  await db.execute({
    sql: `UPDATE procurements
          SET title = ?, customer = ?, price = ?, status = ?, deadline = ?,
              raw_json = ?, updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      fresh.title,
      fresh.customer,
      fresh.price,
      fresh.status,
      fresh.deadline,
      JSON.stringify(fresh),
      row.id,
    ],
  });

  // Notify users tracking this procurement, if their trial/subscription is active.
  const subscribers = await db.execute({
    sql: `SELECT users.email, users.trial_ends_at, users.subscription_status, users.subscription_ends_at
          FROM user_procurements
          JOIN users ON users.id = user_procurements.user_id
          WHERE user_procurements.procurement_id = ?`,
    args: [row.id],
  });

  const changesHtml = changes
    .map(
      (c) =>
        `<li><b>${escapeHtml(FIELD_LABELS[c.field] || c.field)}</b>: ${escapeHtml(c.oldValue)} → ${escapeHtml(c.newValue)}</li>`
    )
    .join("");

  for (const sub of subscribers.rows) {
    const subscriptionActive =
      sub.subscription_status === "active" &&
      (!sub.subscription_ends_at || new Date(sub.subscription_ends_at) > new Date());
    const accessActive = subscriptionActive || new Date(sub.trial_ends_at) > new Date();
    if (!accessActive) continue;

    const changesText = changes
      .map((c) => `- ${FIELD_LABELS[c.field] || c.field}: ${c.oldValue} → ${c.newValue}`)
      .join("\n");

    await sendEmail(
      sub.email,
      `Изменение по закупке № ${row.reg_number}`,
      `<p>По закупке <b>${escapeHtml(row.reg_number)}</b> (${escapeHtml(fresh.title)}) зафиксированы изменения:</p>
       <ul>${changesHtml}</ul>`,
      `По закупке ${row.reg_number} (${fresh.title || ""}) зафиксированы изменения:\n\n${changesText}`
    );
  }
}

async function ensureSubscriptionColumn() {
  // The web app adds this column on first request after deploy; make sure the
  // cron job doesn't fail if it happens to run before that.
  const cols = await db.execute("PRAGMA table_info(users)");
  if (!cols.rows.some((r) => String(r.name) === "subscription_ends_at")) {
    await db.execute("ALTER TABLE users ADD COLUMN subscription_ends_at TEXT");
  }
}

async function main() {
  await ensureSubscriptionColumn();
  const result = await db.execute("SELECT * FROM procurements");
  let failed = 0;
  for (const row of result.rows) {
    try {
      await checkOne(row);
    } catch (err) {
      failed++;
      console.error(`failed checking ${row.reg_number}:`, err.message);
    }
  }
  console.log(`checked ${result.rows.length}, failed ${failed}`);
  // If EVERY check failed (e.g. ЕИС blocks GitHub's IPs), make the Actions run red so it's noticed.
  if (result.rows.length > 0 && failed === result.rows.length) {
    throw new Error("Все проверки закупок завершились ошибкой — мониторинг не работает");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
