// Standalone script run by GitHub Actions on a schedule.
// Duplicates the fetch/parse logic from src/lib/eis.ts and src/lib/db.ts
// in plain JS so it runs with `node` alone, no Next.js build needed.
import { createClient } from "@libsql/client";
import * as cheerio from "cheerio";
import webpush from "web-push";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
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

async function checkOne(row) {
  const fresh = await fetchProcurement(row.reg_number);
  const changes = [];

  for (const field of FIELDS) {
    const oldValue = row[field];
    const newValue = fresh[field];
    // Loose comparison: null/undefined and stringified numbers treated as equal when both empty.
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

  // Notify subscribers for this procurement.
  const subs = await db.execute({
    sql: "SELECT * FROM push_subscriptions WHERE procurement_id = ?",
    args: [row.id],
  });

  const payload = JSON.stringify({
    title: `Изменение по закупке № ${row.reg_number}`,
    body: changes.map((c) => `${c.field}: ${c.oldValue} → ${c.newValue}`).join("; "),
  });

  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      );
    } catch (err) {
      console.error(`push failed for subscription ${sub.id}:`, err.message);
    }
  }
}

async function main() {
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
