import { describe, expect, it } from "vitest";
import { EisParseError, isValidRegNumber, parseProcurementHtml } from "@/lib/eis";

const REG = "0173200001424000001";

function card(opts: { title?: string; customer?: string; price?: string; status?: string; deadline?: string }) {
  const sections: string[] = [];
  if (opts.title !== undefined)
    sections.push(
      `<div class="cardMainInfo__section"><span class="cardMainInfo__title">Объект закупки</span><span class="cardMainInfo__content">${opts.title}</span></div>`
    );
  if (opts.customer !== undefined)
    sections.push(
      `<div class="cardMainInfo__section"><span class="cardMainInfo__title">Заказчик</span><span class="cardMainInfo__content">${opts.customer}</span></div>`
    );
  if (opts.deadline !== undefined)
    sections.push(
      `<div class="cardMainInfo__section"><span class="cardMainInfo__title">Окончание подачи заявок</span><span class="cardMainInfo__content">${opts.deadline}</span></div>`
    );
  const price =
    opts.price !== undefined ? `<div class="cardMainInfo__content cost">${opts.price}</div>` : "";
  const status = opts.status !== undefined ? `<span class="cardMainInfo__state">${opts.status}</span>` : "";
  return `<html><body>${status}${sections.join("")}${price}</body></html>`;
}

describe("isValidRegNumber", () => {
  it("accepts 11 and 19 digit numbers only", () => {
    expect(isValidRegNumber("12345678901")).toBe(true);
    expect(isValidRegNumber(REG)).toBe(true);
    expect(isValidRegNumber("1234567890")).toBe(false);
    expect(isValidRegNumber("123456789012")).toBe(false);
    expect(isValidRegNumber("0173200001424000001 ")).toBe(false);
    expect(isValidRegNumber("abc")).toBe(false);
    expect(isValidRegNumber("../../etc/passwd")).toBe(false);
  });
});

describe("parseProcurementHtml", () => {
  it("parses a normal card", () => {
    const snap = parseProcurementHtml(
      card({
        title: "Поставка бумаги",
        customer: "ГБУ Школа №1",
        price: "1 234 567,89 ₽",
        status: "Подача заявок",
        deadline: "01.12.2026",
      }),
      REG
    );
    expect(snap).toEqual({
      regNumber: REG,
      title: "Поставка бумаги",
      customer: "ГБУ Школа №1",
      price: 1234567.89,
      status: "Подача заявок",
      deadline: "01.12.2026",
    });
  });

  it("returns null for optional fields that are absent", () => {
    const snap = parseProcurementHtml(card({ title: "Поставка бумаги", customer: "ГБУ" }), REG);
    expect(snap.price).toBeNull();
    expect(snap.status).toBeNull();
    expect(snap.deadline).toBeNull();
  });

  it("treats a price with no digits as null, not NaN", () => {
    const snap = parseProcurementHtml(card({ title: "X", customer: "Y", price: "не указана" }), REG);
    expect(snap.price).toBeNull();
  });

  it("throws on a captcha/block page instead of returning an all-empty snapshot (false-alert regression)", () => {
    const captcha = "<html><body><h1>Проверка безопасности</h1><form>captcha</form></body></html>";
    expect(() => parseProcurementHtml(captcha, REG)).toThrow(EisParseError);
    expect(() => parseProcurementHtml("", REG)).toThrow(EisParseError);
  });

  it("throws when sections exist but neither title nor customer can be found (layout changed)", () => {
    const html = `<div class="cardMainInfo__section"><span class="cardMainInfo__title">Что-то другое</span><span class="cardMainInfo__content">x</span></div>`;
    expect(() => parseProcurementHtml(html, REG)).toThrow(EisParseError);
  });
});
