import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { verifyLoginCode, getOrCreateUser, createSession, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  await ensureSchema();
  const { email, code } = await req.json();

  if (!email || !code) {
    return NextResponse.json({ error: "Введите email и код" }, { status: 400 });
  }

  const valid = await verifyLoginCode(email, code);
  if (!valid) {
    return NextResponse.json({ error: "Неверный или истёкший код" }, { status: 401 });
  }

  const user = await getOrCreateUser(email);
  const token = await createSession(user.id as number);
  await setSessionCookie(token);

  return NextResponse.json({
    email: user.email,
    trial_ends_at: user.trial_ends_at,
    subscription_status: user.subscription_status,
  });
}
