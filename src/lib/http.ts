import type { NextRequest } from "next/server";

/** Parses a JSON object body; returns null for invalid JSON or non-object bodies instead of throwing. */
export async function readJsonObject(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort client IP. Behind Vercel the first x-forwarded-for entry is set by the platform.
 * Returns null when it can't be determined (rate limiting then falls back to per-email only).
 */
export function getClientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : null;
}
