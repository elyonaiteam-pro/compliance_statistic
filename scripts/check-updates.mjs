// Standalone script run by GitHub Actions on a schedule.
// Duplicates the fetch/parse logic from src/lib/eis.ts in plain JS so it
// runs with `node` alone, no Next.js build needed. Notifies users by email
// (via Resend) instead of browser push — see src/lib/auth.ts / users table.
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

function sectionByTitle($, titleText) {
  let result = null;
  $(".cardMainInfo__section").each((_, el) => {
    const title = $(el).find(".cardMainInfo__title").first().text().trim();
    if (title === titleText) {
      result = $(el).find(".cardMainInfo__content").first().text().trim();
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
  });
  if (!res.ok) throw new Error(`ЕИС вернул ${res.status} для ${regNumber}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const title = sectionByTitle($, "Объект закупки");
  const customer = sectionByTitle($, "Заказчик");
  const status = $(".cardMainInfo__state").first().text().trim() || null;
  const priceText = $(".cardMainInfo__content.cost")
    .first()
    .text()
    .replace(/[^\d,.]/g, "")
    .replace(",", ".");
  const price = priceText ? parseFloat(priceText) : null;
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

  for (const field of FIELDS) {
    const oldValue = row[field];
    const newValue = fresh[field];
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
    .map((c) => `<li><b>${FIELD_LABELS[c.field] || c.field}</b>: ${c.oldValue} → ${c.newValue}</li>`)
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
      `<p>По закупке <b>${row.reg_number}</b> (${fresh.title || ""}) зафиксированы изменения:</p>
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
  for (const row of result.rows) {
    try {
      await checkOne(row);
    } catch (err) {
      console.error(`failed checking ${row.reg_number}:`, err.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
