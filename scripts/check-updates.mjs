// Entry point for the scheduled job (GitHub Actions, see .github/workflows/check-updates.yml).
// All logic lives in src/lib/monitor.mjs (shared, tested); this file only wires up
// the database, SMTP and process exit code.
import { appendFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import nodemailer from "nodemailer";
import { runMonitor } from "../src/lib/monitor.mjs";
import { fetchCard } from "../src/lib/eis-core.mjs";
import { createEisFetch } from "../src/lib/eis-fetch.mjs";

const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;

if (!TURSO_DATABASE_URL) {
  console.error("TURSO_DATABASE_URL не задан");
  process.exit(1);
}

const db = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

const transporter =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
    : null;

// Must THROW on failure: the notification then stays queued and is retried on the next run.
const sendEmail = transporter
  ? (to, subject, html, text) => transporter.sendMail({ from: GMAIL_USER, to, subject, html, text })
  : null;

// ЕИС is unreliable for non-Russian IPs (GitHub runners are abroad): route through a Russian proxy if configured.
const eisFetch = createEisFetch();
console.log(process.env.EIS_PROXY_URL ? "ЕИС: запросы идут через EIS_PROXY_URL" : "ЕИС: прямые запросы (EIS_PROXY_URL не задан)");

try {
  const summary = await runMonitor({
    db,
    sendEmail,
    fetchCard: (regNumber, options) => fetchCard(regNumber, { ...options, fetchImpl: eisFetch }),
  });
  console.log("summary:", JSON.stringify(summary));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const n = summary.notifications;
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "### Мониторинг закупок",
        `- К проверке: **${summary.due}**, проверено: **${summary.checked}**, с изменениями: **${summary.changed}**, ошибок: **${summary.failed}**`,
        summary.skippedByBudget ? `- Не успели проверить (лимит времени): **${summary.skippedByBudget}**` : null,
        summary.skippedByOutage ? `- Пропущено, так как ЕИС недоступен: **${summary.skippedByOutage}**` : null,
        n ? `- Письма: отправлено **${n.sent}**, не удалось **${n.failed}**, устарело **${n.expired}**` : "- SMTP не настроен: письма в очереди",
        "",
      ]
        .filter((line) => line !== null)
        .join("\n")
    );
  }

  // Make the Actions run red when ЕИС is unreachable/blocked so it is noticed.
  if (summary.allFailed) {
    console.error("Все проверки закупок завершились ошибкой — мониторинг не работает");
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
