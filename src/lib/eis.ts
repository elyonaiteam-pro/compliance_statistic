import * as cheerio from "cheerio";

export interface ProcurementSnapshot {
  regNumber: string;
  title: string | null;
  customer: string | null;
  price: number | null;
  status: string | null;
  deadline: string | null;
}

/**
 * NOTE: zakupki.gov.ru no longer offers a simple public REST/JSON API
 * (FTP + open services closed Jan 2025; official services now require
 * a token / ЭЦП). This fetches the public procurement *card page* for
 * one registry number instead — low volume since we only track
 * specific procurements the user follows, not the whole registry.
 *
 * Verified against a real 44-ФЗ card at
 * /epz/order/notice/zk20/view/common-info.html?regNumber=...
 * (223-ФЗ cards use different markup — /notice223/common-info.html
 * with `registry-entry__*` classes — and are not handled here.)
 */
function buildUrl(regNumber: string): string {
  return `https://zakupki.gov.ru/epz/order/notice/zk20/view/common-info.html?regNumber=${encodeURIComponent(
    regNumber
  )}`;
}

/** Finds a `.cardMainInfo__content` by the text of its sibling `.cardMainInfo__title`. */
function sectionByTitle($: cheerio.CheerioAPI, titleText: string): string | null {
  let result: string | null = null;
  $(".cardMainInfo__section").each((_, el) => {
    const title = $(el).find(".cardMainInfo__title").first().text().trim();
    if (title === titleText) {
      result = $(el).find(".cardMainInfo__content").first().text().trim();
    }
  });
  return result;
}

export async function fetchProcurement(
  regNumber: string
): Promise<ProcurementSnapshot> {
  const url = buildUrl(regNumber);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`ЕИС вернул ${res.status} для ${regNumber}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const title = sectionByTitle($, "Объект закупки");
  const customer = sectionByTitle($, "Заказчик");
  const status = $(".cardMainInfo__state").first().text().trim() || null;

  const priceText = $(".cardMainInfo__content.cost")
    .first()
    .text()
    .replace(/[^\d,.]/g, "")
    .replace(",", ".");
  const price = priceText ? parseFloat(priceText) : null;

  const deadline = sectionByTitle($, "Окончание подачи заявок");

  return { regNumber, title, customer, price, status, deadline };
}
