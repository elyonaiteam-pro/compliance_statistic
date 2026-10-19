import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Client } from "@libsql/client";
import { freshDb, isoInDays, makeProcurement, makeSession, makeUser } from "./helpers";

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session_token" && jar.token ? { value: jar.token } : undefined),
    set: (_n: string, value: string) => {
      jar.token = value;
    },
    delete: () => {
      jar.token = undefined;
    },
  }),
}));

const sendEmail = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/email", () => ({ sendEmail }));

const fetchProcurement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/eis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/eis")>();
  return { ...actual, fetchProcurement };
});

import { GET as listGet, POST as listPost, DELETE as listDelete } from "@/app/api/procurements/route";
import { GET as itemGet } from "@/app/api/procurements/[id]/route";
import { POST as requestCode } from "@/app/api/auth/request-code/route";
import { POST as verify } from "@/app/api/auth/verify/route";
import { EisParseError } from "@/lib/eis";

const REG = "0173200001424000001";
const REG2 = "0173200001424000002";

let db: Client;

beforeEach(async () => {
  db = await freshDb();
  jar.token = undefined;
  sendEmail.mockClear();
  fetchProcurement.mockReset();
});

function json(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function loginAs(email: string, opts?: Parameters<typeof makeUser>[2]) {
  const id = await makeUser(db, email, opts);
  jar.token = await makeSession(db, id);
  return id;
}

const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("POST /api/auth/request-code", () => {
  it("rejects multi-recipient emails and sends nothing (recipient-injection regression)", async () => {
    const res = await requestCode(json("/api/auth/request-code", "POST", { email: "a@b.com,victim@x.com" }));
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400, not 500", async () => {
    const res = await requestCode(json("/api/auth/request-code", "POST", "{not json"));
    expect(res.status).toBe(400);
  });

  it("sends one email with a 6-digit code, then rate-limits the immediate retry with 429", async () => {
    const ok = await requestCode(json("/api/auth/request-code", "POST", { email: "user@example.com" }));
    expect(ok.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(String((sendEmail.mock.calls[0] as unknown[])[1])).toMatch(/\d{6}/);

    const again = await requestCode(json("/api/auth/request-code", "POST", { email: "user@example.com" }));
    expect(again.status).toBe(429);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/auth/verify", () => {
  it("logs in with the emailed code and sets the session", async () => {
    await requestCode(json("/api/auth/request-code", "POST", { email: "user@example.com" }));
    const code = String((sendEmail.mock.calls[0] as unknown[])[1]).match(/\d{6}/)![0];

    const res = await verify(json("/api/auth/verify", "POST", { email: "user@example.com", code }));
    expect(res.status).toBe(200);
    expect(jar.token).toBeTruthy();
  });

  it("returns 401 for a wrong code and 400 for garbage input", async () => {
    await requestCode(json("/api/auth/request-code", "POST", { email: "user@example.com" }));
    const wrong = await verify(json("/api/auth/verify", "POST", { email: "user@example.com", code: "000000" }));
    expect(wrong.status).toBe(401);
    const bad = await verify(json("/api/auth/verify", "POST", { email: ["x"], code: 1 }));
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/procurements/[id] (access-control regression)", () => {
  it("401 when not logged in", async () => {
    const id = await makeProcurement(db, REG);
    const res = await itemGet(json(`/api/procurements/${id}`, "GET"), ctx(id));
    expect(res.status).toBe(401);
  });

  it("404 for a procurement tracked only by someone else", async () => {
    const owner = await makeUser(db, "owner@example.com");
    const id = await makeProcurement(db, REG, owner);
    await loginAs("intruder@example.com");
    const res = await itemGet(json(`/api/procurements/${id}`, "GET"), ctx(id));
    expect(res.status).toBe(404);
  });

  it("404 for a non-numeric id", async () => {
    await loginAs("user@example.com");
    const res = await itemGet(json("/api/procurements/abc", "GET"), ctx("abc"));
    expect(res.status).toBe(404);
  });

  it("returns own procurement without the internal raw_json", async () => {
    const userId = await loginAs("user@example.com");
    const id = await makeProcurement(db, REG, userId);
    const res = await itemGet(json(`/api/procurements/${id}`, "GET"), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.procurement.reg_number).toBe(REG);
    expect(body.procurement).not.toHaveProperty("raw_json");
    expect(body.changes).toEqual([]);
  });
});

describe("GET /api/procurements", () => {
  it("lists only the user's own procurements and hides raw_json", async () => {
    const me = await loginAs("me@example.com");
    const other = await makeUser(db, "other@example.com");
    await makeProcurement(db, REG, me);
    await makeProcurement(db, REG2, other);

    const res = await listGet();
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].reg_number).toBe(REG);
    expect(rows[0]).not.toHaveProperty("raw_json");
  });
});

describe("POST /api/procurements", () => {
  const snapshot = { regNumber: REG, title: "Бумага", customer: "Школа", price: 100, status: "Подача заявок", deadline: null };

  it("401 when not logged in", async () => {
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(401);
  });

  it("402 once the trial has ended and there is no subscription (paywall regression)", async () => {
    await loginAs("late@example.com", { trialDays: -1 });
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(402);
    expect(fetchProcurement).not.toHaveBeenCalled();
  });

  it("allows a user with an active paid subscription even though the trial is over", async () => {
    await loginAs("paid@example.com", { trialDays: -30, status: "active", subscriptionEndsAt: isoInDays(10) });
    fetchProcurement.mockResolvedValue(snapshot);
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(201);
  });

  it("400 for invalid registry numbers, without calling ЕИС", async () => {
    await loginAs("user@example.com");
    for (const regNumber of ["123", "abc", "0173200001424000001 x", 42, null]) {
      const res = await listPost(json("/api/procurements", "POST", { regNumber }));
      expect(res.status).toBe(400);
    }
    expect(fetchProcurement).not.toHaveBeenCalled();
  });

  it("422 when the number isn't a real card, and nothing is stored", async () => {
    await loginAs("user@example.com");
    fetchProcurement.mockRejectedValue(new EisParseError("нет такой"));
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(422);
    const count = await db.execute("SELECT COUNT(*) AS c FROM procurements");
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it("502 (not an unhandled 500) when ЕИС is down", async () => {
    await loginAs("user@example.com");
    fetchProcurement.mockRejectedValue(new Error("ЕИС вернул 503"));
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(502);
  });

  it("adds a procurement, hides raw_json, and is idempotent for the same user", async () => {
    await loginAs("user@example.com");
    fetchProcurement.mockResolvedValue(snapshot);

    const first = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.reg_number).toBe(REG);
    expect(body).not.toHaveProperty("raw_json");

    const second = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(second.status).toBe(201);
    expect(fetchProcurement).toHaveBeenCalledTimes(1); // second call reused the stored card

    const links = await db.execute("SELECT COUNT(*) AS c FROM user_procurements");
    expect(Number(links.rows[0].c)).toBe(1);
  });

  it("a second user tracking the same number reuses the stored card", async () => {
    fetchProcurement.mockResolvedValue(snapshot);
    await loginAs("a@example.com");
    await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    await loginAs("b@example.com");
    const res = await listPost(json("/api/procurements", "POST", { regNumber: REG }));
    expect(res.status).toBe(201);
    expect(fetchProcurement).toHaveBeenCalledTimes(1);
    const rows = await db.execute("SELECT COUNT(*) AS c FROM procurements");
    expect(Number(rows.rows[0].c)).toBe(1);
  });
});

describe("DELETE /api/procurements", () => {
  it("only unlinks the caller's own tracking", async () => {
    const me = await loginAs("me@example.com");
    const other = await makeUser(db, "other@example.com");
    const id = await makeProcurement(db, REG, me);
    await db.execute({ sql: "INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)", args: [other, id] });

    const res = await listDelete(json("/api/procurements", "DELETE", { procurementId: id }));
    expect(res.status).toBe(200);
    const left = await db.execute("SELECT user_id FROM user_procurements");
    expect(left.rows.map((r) => Number(r.user_id))).toEqual([other]);
  });

  it("400 for a bad id", async () => {
    await loginAs("me@example.com");
    const res = await listDelete(json("/api/procurements", "DELETE", { procurementId: "1; DROP TABLE users" }));
    expect(res.status).toBe(400);
  });
});
