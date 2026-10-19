import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import {
  verifyLoginCode,
  getOrCreateUser,
  createSession,
  setSessionCookie,
  isValidEmail,
  normalizeEmail,
} from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await readJsonObject(req);

  if (!body || !isValidEmail(body.email) || typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "Введите email и код" }, { status: 400 });
  }
  const email = normalizeEmail(body.email);

  const valid = await verifyLoginCode(email, body.code);
  if (!valid) {
    return NextResponse.json({ error: "Неверный или истёкший код" }, { status: 401 });
  }

  const user = await getOrCreateUser(email);
  const token = await createSession(Number(user.id));
  await setSessionCookie(token);

  return NextResponse.json({
    email: user.email,
    trial_ends_at: user.trial_ends_at,
    subscription_status: user.subscription_status,
  });
}
