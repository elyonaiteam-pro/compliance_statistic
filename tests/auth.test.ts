import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { freshDb, isoInDays, makeSession, makeUser } from "./helpers";

// next/headers needs a request scope; replace it with an in-memory cookie jar.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session_token" && jar.token ? { value: jar.token } : undefined),
    set: (_name: string, value: string) => {
      jar.token = value;
    },
    delete: () => {
      jar.token = undefined;
    },
  }),
}));

import {
  RateLimitError,
  createLoginCode,
  generateCode,
  getCurrentUser,
  getOrCreateUser,
  isAccessActive,
  isValidEmail,
  verifyLoginCode,
} from "@/lib/auth";

let db: Client;

beforeEach(async () => {
  db = await freshDb();
  jar.token = undefined;
});

/** Skip the 60s resend cooldown without waiting. */
async function skipCooldown() {
  await db.execute("UPDATE login_codes SET created_at = datetime('now', '-5 minutes')");
}

describe("generateCode", () => {
  it("always returns 6 digits", () => {
    for (let i = 0; i < 500; i++) expect(generateCode()).toMatch(/^[1-9]\d{5}$/);
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.example.ru")).toBe(true);
  });

  it("rejects multi-recipient / malformed values (recipient-injection regression)", () => {
    expect(isValidEmail("a@b.com,victim@x.com")).toBe(false);
    expect(isValidEmail("a@b.com victim@x.com")).toBe(false);
    expect(isValidEmail("a@b.com;victim@x.com")).toBe(false);
    expect(isValidEmail("Name <a@b.com>")).toBe(false);
    expect(isValidEmail("a@b.com\r\nBcc: victim@x.com")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("@")).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@b.com`)).toBe(false);
    expect(isValidEmail(123)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe("login codes", () => {
  it("accepts a correct code exactly once", async () => {
    const code = await createLoginCode("user@example.com");
    expect(await verifyLoginCode("user@example.com", code)).toBe(true);
    expect(await verifyLoginCode("user@example.com", code)).toBe(false);
  });

  it("is case/whitespace tolerant on email", async () => {
    const code = await createLoginCode("User@Example.com");
    expect(await verifyLoginCode("  user@example.COM ", code)).toBe(true);
  });

  it("rejects a code that expired a minute ago, even on the same UTC day (expiry regression)", async () => {
    const code = await createLoginCode("user@example.com");
    await db.execute({
      sql: "UPDATE login_codes SET expires_at = ? WHERE email = ?",
      args: [new Date(Date.now() - 60_000).toISOString(), "user@example.com"],
    });
    expect(await verifyLoginCode("user@example.com", code)).toBe(false);
  });

  it("burns the code after 5 wrong guesses, so even the right code stops working (brute-force regression)", async () => {
    const code = await createLoginCode("user@example.com");
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) {
      expect(await verifyLoginCode("user@example.com", wrong)).toBe(false);
    }
    expect(await verifyLoginCode("user@example.com", code)).toBe(false);
  });

  it("still accepts the right code after a few (<5) wrong guesses", async () => {
    const code = await createLoginCode("user@example.com");
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 4; i++) await verifyLoginCode("user@example.com", wrong);
    expect(await verifyLoginCode("user@example.com", code)).toBe(true);
  });

  it("rejects non-6-digit input without touching the DB result", async () => {
    const code = await createLoginCode("user@example.com");
    expect(await verifyLoginCode("user@example.com", "12345")).toBe(false);
    expect(await verifyLoginCode("user@example.com", "abcdef")).toBe(false);
    expect(await verifyLoginCode("user@example.com", code)).toBe(true);
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const first = await createLoginCode("user@example.com");
    await skipCooldown();
    const second = await createLoginCode("user@example.com");
    if (first !== second) expect(await verifyLoginCode("user@example.com", first)).toBe(false);
    expect(await verifyLoginCode("user@example.com", second)).toBe(true);
  });
});

describe("login code rate limits", () => {
  it("enforces a resend cooldown per email", async () => {
    await createLoginCode("user@example.com");
    await expect(createLoginCode("user@example.com")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("caps codes per email per hour", async () => {
    for (let i = 0; i < 5; i++) {
      await createLoginCode("user@example.com");
      await skipCooldown();
    }
    await expect(createLoginCode("user@example.com")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("caps codes per IP per hour across different emails", async () => {
    for (let i = 0; i < 10; i++) await createLoginCode(`user${i}@example.com`, "203.0.113.7");
    await expect(createLoginCode("another@example.com", "203.0.113.7")).rejects.toBeInstanceOf(RateLimitError);
    // a different IP is unaffected
    await expect(createLoginCode("another@example.com", "198.51.100.1")).resolves.toMatch(/^\d{6}$/);
  });
});

describe("sessions", () => {
  it("returns the user for a live session", async () => {
    const userId = await makeUser(db, "user@example.com");
    jar.token = await makeSession(db, userId);
    const user = await getCurrentUser();
    expect(user?.email).toBe("user@example.com");
  });

  it("returns null for a session that expired a minute ago, same day (expiry regression)", async () => {
    const userId = await makeUser(db, "user@example.com");
    jar.token = await makeSession(db, userId, new Date(Date.now() - 60_000).toISOString());
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns null without a cookie", async () => {
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("getOrCreateUser", () => {
  it("creates one user with a ~14 day trial and is race-safe", async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => getOrCreateUser("New@Example.com")));
    const ids = new Set(users.map((u) => Number(u.id)));
    expect(ids.size).toBe(1);

    const rows = await db.execute("SELECT * FROM users WHERE email = 'new@example.com'");
    expect(rows.rows).toHaveLength(1);
    const trialEnd = new Date(String(rows.rows[0].trial_ends_at)).getTime();
    const days = (trialEnd - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });
});

describe("isAccessActive", () => {
  it("trial in the future = active, in the past = not", () => {
    expect(isAccessActive({ subscription_status: "trial", trial_ends_at: isoInDays(3) })).toBe(true);
    expect(isAccessActive({ subscription_status: "trial", trial_ends_at: isoInDays(-1) })).toBe(false);
  });

  it("active subscription: future end = active, past end = not, NULL end = legacy unlimited", () => {
    const expiredTrial = isoInDays(-30);
    expect(
      isAccessActive({ subscription_status: "active", trial_ends_at: expiredTrial, subscription_ends_at: isoInDays(5) })
    ).toBe(true);
    expect(
      isAccessActive({ subscription_status: "active", trial_ends_at: expiredTrial, subscription_ends_at: isoInDays(-1) })
    ).toBe(false);
    expect(
      isAccessActive({ subscription_status: "active", trial_ends_at: expiredTrial, subscription_ends_at: null })
    ).toBe(true);
  });
});
