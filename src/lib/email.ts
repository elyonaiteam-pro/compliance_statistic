import nodemailer from "nodemailer";

let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER / GMAIL_APP_PASSWORD не настроены в .env.local — см. .env.local.example"
    );
  }

  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  return _transporter;
}

/**
 * Sends transactional email via Gmail SMTP (no custom domain required).
 * `text` is a plain-text alternative — including one (not just HTML) is one
 * of the simplest ways to reduce the odds of landing in spam.
 */
export async function sendEmail(to: string, subject: string, html: string, text: string) {
  const transporter = getTransporter();
  const from = process.env.GMAIL_USER;

  const info = await transporter.sendMail({ from, to, subject, html, text });
  console.log("[email] sent", {
    to,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  });
}
