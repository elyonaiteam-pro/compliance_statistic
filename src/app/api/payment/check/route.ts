import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { processDonatePayTransactions } from "@/lib/payments";

// Called by the "Я оплатил" button: checks DonatePay right now instead of waiting
// for the scheduled job. Idempotent — each transaction is only ever applied once.
export async function POST() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const result = await processDonatePayTransactions();

  if (!result.ok) {
    return NextResponse.json({ result: result.reason });
  }
  const activated = result.activatedUserIds.includes(Number(user.id));
  return NextResponse.json({ result: activated ? "activated" : "not_found" });
}
