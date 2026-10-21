import { vi } from "vitest";

export const REG = "0173200001424000001";

/** Minimal ЕИС card page that parseProcurementHtml accepts. */
export function cardHtml(
  opts: { title?: string; customer?: string; price?: string; status?: string; deadline?: string } = {}
): string {
  const { title = "Поставка бумаги", customer = "ГБУ Школа №1", price = "1 000,00 ₽", status = "Подача заявок", deadline } =
    opts;
  const section = (name: string, value: string) =>
    `<div class="cardMainInfo__section"><span class="cardMainInfo__title">${name}</span><span class="cardMainInfo__content">${value}</span></div>`;
  return `<html><body><span class="cardMainInfo__state">${status}</span>${section("Объект закупки", title)}${section(
    "Заказчик",
    customer
  )}${deadline ? section("Окончание подачи заявок", deadline) : ""}<div class="cardMainInfo__content cost">${price}</div></body></html>`;
}

export const CAPTCHA_HTML = "<html><body><h1>Проверка безопасности</h1><form>captcha</form></body></html>";

type Reply = { status?: number; body?: string } | Error;

/**
 * Fake fetch: `route(url)` decides the reply per request. Records every URL requested.
 * Returned mock is typed as typeof fetch for injection into fetchCard/fetchHtml.
 */
export function makeFetch(route: (url: string, callIndex: number) => Reply) {
  const urls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = route(url, urls.length);
    urls.push(url);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? "", { status: reply.status ?? 200 });
  });
  return { fetchImpl: mock as unknown as typeof fetch, mock, urls };
}

/** Extracts the notice type from a card URL: .../notice/<type>/view/... */
export function noticeTypeOf(url: string): string {
  return url.match(/\/notice\/([a-z0-9]+)\/view\//)?.[1] ?? "";
}
