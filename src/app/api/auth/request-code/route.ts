import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { createLoginCode, isValidEmail, normalizeEmail, RateLimitError } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { getClientIp, readJsonObject } from "@/lib/http";

export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await readJsonObject(req);

  if (!body || !isValidEmail(body.email)) {
    return NextResponse.json({ error: "Введите корректный email" }, { status: 400 });
  }
  const email = normalizeEmail(body.email);

  let code: string;
  try {
    code = await createLoginCode(email, getClientIp(req));
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  try {
    await sendEmail(
      email,
      `Ваш код для входа: ${code}`,
      `<p>Здравствуйте!</p>
       <p>Ваш код для входа в сервис мониторинга закупок: <strong style="font-size:20px">${code}</strong></p>
       <p>Код действует 10 минут. Если вы не запрашивали вход — просто проигнорируйте это письмо.</p>`,
      `Здравствуйте!\n\nВаш код для входа в сервис мониторинга закупок: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход — просто проигнорируйте это письмо.`
    );
  } catch {
    return NextResponse.json(
      { error: "Не удалось отправить письмо. Попробуйте позже." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
