import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { freshDb, isoInDays, makeProcurement, makeUser } from "./helpers";
import { REG } from "./eis-helpers";
import { EisParseError } from "@/lib/eis-core.mjs";
import { deliverPendingNotifications, renderChangeEmail, runMonitor, selectDueProcurements } from "@/lib/monitor.mjs";

let db: Client;
const noSleep = async () => {};

beforeEach(async () => {
  db = await freshDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

type Snap = { regNumber: string; title: string | null; customer: string | null; price: number | null; status: string | null; deadline: string | null };

/** Snapshot equal to what makeProcurement stores, with overrides. */
function snap(over: Partial<Snap> = {}): Snap {
  return { regNumber: REG, title: "Тест", customer: "Заказчик", price: 1000, status: "Подача заявок", deadline: "01.01.2030", ...over };
}

function fetchReturning(s: Snap, noticeType = "zk20") {
  return vi.fn(async () => ({ snapshot: s, noticeType }));
}

function run(opts: Partial<Parameters<typeof runMonitor>[0]> = {}) {
  return runMonitor({ db, sendEmail: vi.fn(async () => {}), fetchCard: fetchReturning(snap()), sleep: noSleep, delayMs: 0, ...opts });
}

async function one(sql: string, args: (string | number)[] = []) {
  const r = await db.execute({ sql, args });
  return r.rows[0] as Record<string, unknown>;
}

async function seed() {
  const userId = await makeUser(db, "user@example.com");
  const procId = await makeProcurement(db, REG, userId);
  return { userId, procId };
}

describe("detecting and recording changes", () => {
  it("records the change, updates the row, queues and delivers one email", async () => {
    await seed();
    const sendEmail = vi.fn(async () => {});
    const summary = await run({ sendEmail, fetchCard: fetchReturning(snap({ price: 900, status: "Работа комиссии" })) });

    expect(summary).toMatchObject({ due: 1, checked: 1, changed: 1, failed: 0, allFailed: false });
    expect(summary.notifications).toEqual({ sent: 1, failed: 0, expired: 0 });

    const p = await one("SELECT * FROM procurements");
    expect(p.price).toBe(900);
    expect(p.status).toBe("Работа комиссии");
    expect(p.notice_type).toBe("zk20");
    expect(p.last_error).toBeNull();

    const changes = await db.execute("SELECT field, old_value, new_value FROM procurement_changes ORDER BY id");
    expect(changes.rows.map((r) => ({ ...r }))).toEqual([
      { field: "price", old_value: "1000", new_value: "900" },
      { field: "status", old_value: "Подача заявок", new_value: "Работа комиссии" },
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendEmail.mock.calls[0] as unknown as string[];
    expect(to).toBe("user@example.com");
    expect(subject).toContain(REG);
    expect(html).toContain("Работа комиссии");
    expect((await one("SELECT status FROM notifications")).status).toBe("sent");
  });

  it("does nothing (no change rows, no emails) when the card is unchanged, even on repeated runs", async () => {
    await seed();
    const sendEmail = vi.fn(async () => {});
    await run({ sendEmail });
    await run({ sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(Number((await one("SELECT COUNT(*) AS c FROM procurement_changes")).c)).toBe(0);
    expect(Number((await one("SELECT COUNT(*) AS c FROM notifications")).c)).toBe(0);
    expect((await one("SELECT last_checked_at FROM procurements")).last_checked_at).not.toBeNull();
  });

  it("does not report the same change twice", async () => {
    await seed();
    const sendEmail = vi.fn(async () => {});
    const fetchCard = fetchReturning(snap({ price: 900 }));
    await run({ sendEmail, fetchCard });
    await run({ sendEmail, fetchCard });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("treats a suspiciously empty core field as a glitch: no change, no email, old value kept", async () => {
    await seed();
    const sendEmail = vi.fn(async () => {});
    await run({ sendEmail, fetchCard: fetchReturning(snap({ title: null, customer: null, price: null })) });
    expect(sendEmail).not.toHaveBeenCalled();
    const p = await one("SELECT title, customer, price FROM procurements");
    expect(p).toMatchObject({ title: "Тест", customer: "Заказчик", price: 1000 });
  });

  it("queues notifications only for users who currently have access", async () => {
    const { procId } = await seed();
    const lapsed = await makeUser(db, "lapsed@example.com", { trialDays: -3 });
    await db.execute({ sql: "INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)", args: [lapsed, procId] });
    const paid = await makeUser(db, "paid@example.com", { trialDays: -30, status: "active", subscriptionEndsAt: isoInDays(5) });
    await db.execute({ sql: "INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)", args: [paid, procId] });

    const sendEmail = vi.fn(async () => {});
    await run({ sendEmail, fetchCard: fetchReturning(snap({ price: 1 })) });
    const recipients = sendEmail.mock.calls.map((c) => (c as unknown as string[])[0]).sort();
    expect(recipients).toEqual(["paid@example.com", "user@example.com"]);
  });
});

describe("notification delivery (lost-alert regression)", () => {
  it("keeps a notification queued when SMTP fails and delivers it on the next run", async () => {
    await seed();
    const failing = vi.fn(async () => {
      throw new Error("SMTP down");
    });
    const first = await run({ sendEmail: failing, fetchCard: fetchReturning(snap({ price: 900 })) });
    expect(first.notifications).toEqual({ sent: 0, failed: 1, expired: 0 });
    let n = await one("SELECT status, attempts, last_error FROM notifications");
    expect(n).toMatchObject({ status: "pending", attempts: 1, last_error: "SMTP down" });

    // The card itself is already up to date, so the second run finds no new change —
    // the alert must still go out from the queue.
    const ok = vi.fn(async () => {});
    const second = await run({ sendEmail: ok, fetchCard: fetchReturning(snap({ price: 900 })) });
    expect(second.changed).toBe(0);
    expect(ok).toHaveBeenCalledTimes(1);
    n = await one("SELECT status, attempts FROM notifications");
    expect(n).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("gives up after 5 failed deliveries", async () => {
    await seed();
    const failing = vi.fn(async () => {
      throw new Error("nope");
    });
    const fetchCard = fetchReturning(snap({ price: 900 }));
    for (let i = 0; i < 5; i++) await run({ sendEmail: failing, fetchCard });
    expect(await one("SELECT status, attempts FROM notifications")).toMatchObject({ status: "failed", attempts: 5 });
    await run({ sendEmail: failing, fetchCard });
    expect(failing).toHaveBeenCalledTimes(5);
  });

  it("does not send stale notifications (older than 3 days)", async () => {
    const { userId, procId } = await seed();
    await db.execute({
      sql: `INSERT INTO notifications (user_id, procurement_id, payload, created_at)
            VALUES (?, ?, ?, datetime('now', '-4 days'))`,
      args: [userId, procId, JSON.stringify({ regNumber: REG, title: "Тест", changes: [{ field: "price", oldValue: 1, newValue: 2 }] })],
    });
    const sendEmail = vi.fn(async () => {});
    const res = await deliverPendingNotifications(db, sendEmail);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.expired).toBe(1);
    expect((await one("SELECT status FROM notifications")).status).toBe("failed");
  });

  it("without SMTP configured, notifications wait in the queue", async () => {
    await seed();
    const summary = await run({ sendEmail: null, fetchCard: fetchReturning(snap({ price: 900 })) });
    expect(summary.notifications).toBeNull();
    expect((await one("SELECT status FROM notifications")).status).toBe("pending");
  });
});

describe("renderChangeEmail", () => {
  it("escapes HTML coming from ЕИС", () => {
    const mail = renderChangeEmail({
      regNumber: REG,
      title: "<img src=x onerror=alert(1)>",
      noticeType: "zk20",
      changes: [{ field: "customer", oldValue: "A & B", newValue: "<b>evil</b>" }],
    });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain("<b>evil</b>");
    expect(mail.html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(mail.html).toContain("A &amp; B");
    expect(mail.html).toContain(`regNumber=${REG}`);
  });

  it("formats price changes in rubles", () => {
    const mail = renderChangeEmail({
      regNumber: REG,
      title: "x",
      changes: [{ field: "price", oldValue: 1000, newValue: 1234567.5 }],
    });
    expect(mail.text).toContain("₽");
    expect(mail.text).toMatch(/Цена: 1.000 ₽ → 1.234.567,5 ₽/);
  });
});

describe("which procurements get checked", () => {
  it("skips procurements nobody with access follows (orphans, lapsed users)", async () => {
    await makeProcurement(db, "0173200001424000009"); // nobody tracks it
    const lapsed = await makeUser(db, "lapsed@example.com", { trialDays: -1 });
    await makeProcurement(db, "0173200001424000008", lapsed);

    const fetchCard = fetchReturning(snap());
    const summary = await run({ fetchCard });
    expect(summary.due).toBe(0);
    expect(fetchCard).not.toHaveBeenCalled();
  });

  it("checks quiet procurements (no change for 30+ days) only once a day", async () => {
    const { procId } = await seed();
    await db.execute({ sql: "UPDATE procurements SET updated_at = datetime('now', '-40 days'), last_checked_at = datetime('now', '-2 hours') WHERE id = ?", args: [procId] });
    expect(await selectDueProcurements(db)).toHaveLength(0);

    await db.execute({ sql: "UPDATE procurements SET last_checked_at = datetime('now', '-2 days') WHERE id = ?", args: [procId] });
    expect(await selectDueProcurements(db)).toHaveLength(1);
  });

  it("checks recently active procurements on every run", async () => {
    const { procId } = await seed();
    await db.execute({ sql: "UPDATE procurements SET last_checked_at = datetime('now', '-10 minutes') WHERE id = ?", args: [procId] });
    expect(await selectDueProcurements(db)).toHaveLength(1);
  });

  it("checks never-checked procurements first", async () => {
    const userId = await makeUser(db, "u@example.com");
    const a = await makeProcurement(db, "0173200001424000011", userId);
    const b = await makeProcurement(db, "0173200001424000012", userId);
    await db.execute({ sql: "UPDATE procurements SET last_checked_at = datetime('now', '-1 hour') WHERE id = ?", args: [a] });
    const due = await selectDueProcurements(db);
    expect(due.map((r) => Number(r.id))).toEqual([b, a]);
  });

  it("stops starting new checks when the time budget is spent", async () => {
    await seed();
    const fetchCard = fetchReturning(snap());
    const summary = await run({ fetchCard, maxRuntimeMs: -1 });
    expect(summary.skippedByBudget).toBe(1);
    expect(fetchCard).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("records a failed check without touching data or sending anything", async () => {
    await seed();
    const sendEmail = vi.fn(async () => {});
    const fetchCard = vi.fn(async () => {
      throw new EisParseError("captcha");
    });
    const summary = await run({ sendEmail, fetchCard });
    expect(summary).toMatchObject({ checked: 0, failed: 1, allFailed: true });
    expect(sendEmail).not.toHaveBeenCalled();
    const p = await one("SELECT title, price, last_error, failure_count FROM procurements");
    expect(p).toMatchObject({ title: "Тест", price: 1000, last_error: "captcha", failure_count: 1 });
    expect(Number((await one("SELECT COUNT(*) AS c FROM procurement_changes")).c)).toBe(0);
  });

  it("a later success clears the failure state", async () => {
    await seed();
    await run({ fetchCard: vi.fn(async () => { throw new Error("boom"); }) });
    await run({ fetchCard: fetchReturning(snap()) });
    expect(await one("SELECT last_error, failure_count FROM procurements")).toMatchObject({ last_error: null, failure_count: 0 });
  });

  it("after 3 parse failures in a row forgets the remembered card URL so it is re-probed", async () => {
    const { procId } = await seed();
    await db.execute({ sql: "UPDATE procurements SET notice_type = 'ea20' WHERE id = ?", args: [procId] });
    const failing = vi.fn(async () => {
      throw new EisParseError("layout changed");
    });
    await run({ fetchCard: failing });
    await run({ fetchCard: failing });
    expect((await one("SELECT notice_type FROM procurements")).notice_type).toBe("ea20");
    await run({ fetchCard: failing });
    expect((await one("SELECT notice_type FROM procurements")).notice_type).toBeNull();
  });

  it("network failures never make the remembered card URL be forgotten", async () => {
    const { procId } = await seed();
    await db.execute({ sql: "UPDATE procurements SET notice_type = 'ea20' WHERE id = ?", args: [procId] });
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    for (let i = 0; i < 4; i++) await run({ fetchCard: failing });
    expect((await one("SELECT notice_type FROM procurements")).notice_type).toBe("ea20");
  });

  it("one failing procurement does not stop the others, and allFailed stays false", async () => {
    const userId = await makeUser(db, "u@example.com");
    await makeProcurement(db, "0173200001424000021", userId);
    await makeProcurement(db, "0173200001424000022", userId);
    const fetchCard = vi.fn(async (reg: string) => {
      if (reg.endsWith("21")) throw new Error("boom");
      return { snapshot: snap({ regNumber: reg }), noticeType: "zk20" };
    });
    const summary = await run({ fetchCard });
    expect(summary).toMatchObject({ due: 2, checked: 1, failed: 1, allFailed: false });
  });

  it("passes the remembered notice_type to the fetcher", async () => {
    const { procId } = await seed();
    await db.execute({ sql: "UPDATE procurements SET notice_type = 'ok20' WHERE id = ?", args: [procId] });
    const fetchCard = fetchReturning(snap(), "ok20");
    await run({ fetchCard });
    expect(fetchCard.mock.calls[0]).toEqual([REG, expect.objectContaining({ preferredType: "ok20" })]);
  });
});

describe("ЕИС outage handling", () => {
  async function seedMany(n: number) {
    const userId = await makeUser(db, "u@example.com");
    for (let i = 0; i < n; i++) await makeProcurement(db, `01732000014240001${String(i).padStart(2, "0")}`, userId);
  }

  it("stops after 3 consecutive network failures instead of hammering an unreachable ЕИС", async () => {
    await seedMany(6);
    const fetchCard = vi.fn(async () => {
      throw new Error("fetch failed: UND_ERR_CONNECT_TIMEOUT");
    });
    const summary = await run({ fetchCard });
    expect(fetchCard).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ due: 6, failed: 3, skippedByOutage: 3, allFailed: true });
  });

  it("a success in between resets the streak", async () => {
    await seedMany(6);
    let call = 0;
    const fetchCard = vi.fn(async (reg: string) => {
      call++;
      if (call % 3 === 0) return { snapshot: snap({ regNumber: reg }), noticeType: "zk20" };
      throw new Error("fetch failed");
    });
    const summary = await run({ fetchCard });
    expect(fetchCard).toHaveBeenCalledTimes(6);
    expect(summary.skippedByOutage).toBe(0);
  });

  it("parse failures (bad/blocked page) never abort the run: each card is judged on its own", async () => {
    await seedMany(5);
    const fetchCard = vi.fn(async () => {
      throw new EisParseError("не карточка");
    });
    const summary = await run({ fetchCard });
    expect(fetchCard).toHaveBeenCalledTimes(5);
    expect(summary.skippedByOutage).toBe(0);
  });
});
