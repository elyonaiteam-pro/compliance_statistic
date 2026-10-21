import { describe, expect, it, vi } from "vitest";
import {
  EisHttpError,
  EisParseError,
  NOTICE_TYPES,
  buildUrl,
  detectChanges,
  fetchCard,
} from "@/lib/eis-core.mjs";
import { CAPTCHA_HTML, REG, cardHtml, makeFetch, noticeTypeOf } from "./eis-helpers";

const noSleep = async () => {};

describe("buildUrl", () => {
  it("builds the card URL for a notice type and encodes the number", () => {
    expect(buildUrl("ea20", REG)).toBe(
      `https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=${REG}`
    );
  });
});

describe("fetchCard: probing card URL variants", () => {
  it("falls through 404s to the variant that works and reports which one", async () => {
    const { fetchImpl, urls } = makeFetch((url) =>
      noticeTypeOf(url) === "ok20" ? { body: cardHtml() } : { status: 404 }
    );
    const { snapshot, noticeType } = await fetchCard(REG, { fetchImpl, sleep: noSleep });
    expect(noticeType).toBe("ok20");
    expect(snapshot.title).toBe("Поставка бумаги");
    expect(urls.map(noticeTypeOf)).toEqual(NOTICE_TYPES.slice(0, NOTICE_TYPES.indexOf("ok20") + 1));
  });

  it("also moves on when a variant answers 200 with a non-card page", async () => {
    const { fetchImpl, urls } = makeFetch((url) =>
      noticeTypeOf(url) === "zk20" ? { body: CAPTCHA_HTML } : { body: cardHtml() }
    );
    const { noticeType } = await fetchCard(REG, { fetchImpl, sleep: noSleep });
    expect(noticeType).toBe("ea20");
    expect(urls).toHaveLength(2);
  });

  it("throws EisParseError when no variant is a card", async () => {
    const { fetchImpl, urls } = makeFetch(() => ({ status: 404 }));
    await expect(fetchCard(REG, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(EisHttpError);
    expect(urls).toHaveLength(NOTICE_TYPES.length);
  });

  it("with a remembered type requests ONLY that URL; a captcha must not trigger probing of other variants", async () => {
    const { fetchImpl, urls } = makeFetch(() => ({ body: CAPTCHA_HTML }));
    await expect(
      fetchCard(REG, { fetchImpl, sleep: noSleep, preferredType: "ea20" })
    ).rejects.toBeInstanceOf(EisParseError);
    expect(urls).toHaveLength(1);
    expect(noticeTypeOf(urls[0])).toBe("ea20");
  });

  it("with a remembered type returns it after a single request when it still works", async () => {
    const { fetchImpl, urls } = makeFetch(() => ({ body: cardHtml() }));
    const res = await fetchCard(REG, { fetchImpl, sleep: noSleep, preferredType: "ok20" });
    expect(res.noticeType).toBe("ok20");
    expect(urls).toHaveLength(1);
  });

  it("with a remembered type that now 404s, re-probes the other variants", async () => {
    const { fetchImpl } = makeFetch((url) =>
      noticeTypeOf(url) === "ea20" ? { body: cardHtml() } : { status: 404 }
    );
    const res = await fetchCard(REG, { fetchImpl, sleep: noSleep, preferredType: "ok20" });
    expect(res.noticeType).toBe("ea20");
  });

  it("rejects an invalid number without any request", async () => {
    const { fetchImpl, mock } = makeFetch(() => ({ body: cardHtml() }));
    await expect(fetchCard("123", { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(EisParseError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("fetchCard: retries and backoff", () => {
  it("retries 503s with 1s then 3s backoff and succeeds", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const { fetchImpl, urls } = makeFetch((_url, i) => (i < 2 ? { status: 503 } : { body: cardHtml() }));
    const res = await fetchCard(REG, { fetchImpl, sleep, preferredType: "zk20" });
    expect(res.snapshot.title).toBe("Поставка бумаги");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000]);
    expect(urls).toHaveLength(3);
  });

  it("retries 429 too", async () => {
    const { fetchImpl, urls } = makeFetch((_url, i) => (i === 0 ? { status: 429 } : { body: cardHtml() }));
    await fetchCard(REG, { fetchImpl, sleep: noSleep, preferredType: "zk20" });
    expect(urls).toHaveLength(2);
  });

  it("a persistent 5xx gives up after 3 tries and does NOT probe other variants", async () => {
    const { fetchImpl, urls } = makeFetch(() => ({ status: 503 }));
    const err = await fetchCard(REG, { fetchImpl, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(EisHttpError);
    expect(err.status).toBe(503);
    expect(urls).toHaveLength(3);
    expect(new Set(urls.map(noticeTypeOf)).size).toBe(1);
  });

  it("network errors are retried, then surface as a non-parse error", async () => {
    const { fetchImpl, urls } = makeFetch(() => new Error("ECONNRESET"));
    const err = await fetchCard(REG, { fetchImpl, sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EisParseError);
    expect(err.message).toContain("ECONNRESET");
    expect(urls).toHaveLength(3);
  });

  it("surfaces the real network cause hidden behind Node's bare 'fetch failed'", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    const { fetchImpl } = makeFetch(() => err);
    const thrown = await fetchCard(REG, { fetchImpl, sleep: noSleep, preferredType: "zk20" }).catch((e) => e);
    expect(thrown.message).toContain("fetch failed");
    expect(thrown.message).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("does not retry a 404", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const { fetchImpl, urls } = makeFetch(() => ({ status: 404 }));
    await fetchCard(REG, { fetchImpl, sleep, preferredType: "zk20" }).catch(() => {});
    expect(sleep).not.toHaveBeenCalled();
    expect(urls).toHaveLength(NOTICE_TYPES.length); // one request per variant, none repeated
  });
});

describe("detectChanges", () => {
  const row = { title: "Бумага", customer: "Школа", price: 1000, status: "Подача заявок", deadline: "01.12.2026" };
  const fresh = { regNumber: REG, ...row };

  it("reports nothing when nothing changed (number vs string safe)", () => {
    const { changes, suspicious } = detectChanges(row, fresh);
    expect(changes).toEqual([]);
    expect(suspicious).toEqual([]);
  });

  it("reports real changes with old and new values", () => {
    const { changes } = detectChanges(row, { ...fresh, price: 900, status: "Работа комиссии" });
    expect(changes).toEqual([
      { field: "price", oldValue: 1000, newValue: 900 },
      { field: "status", oldValue: "Подача заявок", newValue: "Работа комиссии" },
    ]);
  });

  it("core fields that come back empty are a parse glitch: no change, old value kept", () => {
    const { changes, merged, suspicious } = detectChanges(row, {
      ...fresh,
      title: null,
      customer: "",
      price: null,
    } as never);
    expect(changes).toEqual([]);
    expect(suspicious.sort()).toEqual(["customer", "price", "title"]);
    expect(merged.title).toBe("Бумага");
    expect(merged.price).toBe(1000);
  });

  it("non-core fields may legitimately appear or disappear", () => {
    const a = detectChanges(row, { ...fresh, deadline: null });
    expect(a.changes).toEqual([{ field: "deadline", oldValue: "01.12.2026", newValue: null }]);
    const b = detectChanges({ ...row, deadline: null }, { ...fresh, deadline: "05.12.2026" });
    expect(b.changes).toEqual([{ field: "deadline", oldValue: null, newValue: "05.12.2026" }]);
  });

  it("a core field that was empty before and has a value now is a normal change", () => {
    const { changes } = detectChanges({ ...row, price: null }, fresh);
    expect(changes).toEqual([{ field: "price", oldValue: null, newValue: 1000 }]);
  });
});
