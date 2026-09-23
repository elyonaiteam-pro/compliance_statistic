import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";

export async function POST(req: NextRequest) {
  await ensureSchema();
  const { procurementId, subscription } = await req.json();

  if (!procurementId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return NextResponse.json({ error: "Некорректные данные подписки" }, { status: 400 });
  }

  const db = getDb();

  await db.execute({
    sql: `INSERT INTO push_subscriptions (procurement_id, endpoint, p256dh, auth)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(procurement_id, endpoint) DO NOTHING`,
    args: [procurementId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
