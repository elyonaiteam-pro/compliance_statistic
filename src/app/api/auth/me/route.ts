import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { getCurrentUser, getOrCreatePaymentCode, isAccessActive } from "@/lib/auth";

export async function GET() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null });

  const paymentCode = await getOrCreatePaymentCode(Number(user.id));
  const subscriptionEndsAt = (user.subscription_ends_at as string | null) ?? null;

  return NextResponse.json({
    user: {
      email: user.email,
      trial_ends_at: user.trial_ends_at,
      subscription_status: user.subscription_status,
      subscription_ends_at: subscriptionEndsAt,
      access_active: isAccessActive({
        subscription_status: String(user.subscription_status),
        trial_ends_at: String(user.trial_ends_at),
        subscription_ends_at: subscriptionEndsAt,
      }),
      payment_code: paymentCode,
      payment_url: process.env.DONATEPAY_PAGE_URL ?? null,
    },
  });
}
