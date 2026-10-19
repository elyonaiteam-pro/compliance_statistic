import * as cheerio from "cheerio";

export interface ProcurementSnapshot {
  regNumber: string;
  title: string | null;
  customer: string | null;
  price: number | null;
  status: string | null;
  deadline: string | null;
}

/** The page loaded but is not a procurement card (captcha, block page, layout change, unknown number). */
export class EisParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EisParseError";
  }
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Registry numbers in ЕИС: 19 digits for 44-ФЗ notices, 11 digits for 223-ФЗ.
 * Both shapes are accepted here; 223-ФЗ cards use different markup and are rejected by the parser.
 */
export function isValidRegNumber(value: string): boolean {
  return /^(\d{11}|\d{19})$/.test(value);
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
      result = $(el).find(".cardMainInfo__content").first().text().trim() || null;
    }
  });
  return result;
}

/**
 * Parses a card page. Throws EisParseError when the HTML doesn't look like a card,
 * so a captcha/blocked/changed page is never mistaken for "everything became empty".
 */
export function parseProcurementHtml(html: string, regNumber: string): ProcurementSnapshot {
  const $ = cheerio.load(html);

  if ($(".cardMainInfo__section").length === 0) {
    throw new EisParseError(`Страница ЕИС для ${regNumber} не похожа на карточку закупки`);
  }

  const title = sectionByTitle($, "Объект закупки");
  const customer = sectionByTitle($, "Заказчик");
  if (title === null && customer === null) {
    throw new EisParseError(`Не удалось распознать карточку закупки ${regNumber}`);
  }

  const status = $(".cardMainInfo__state").first().text().trim() || null;

  const priceText = $(".cardMainInfo__content.cost")
    .first()
    .text()
    .replace(/[^\d,.]/g, "")
    .replace(",", ".");
  const parsedPrice = priceText ? parseFloat(priceText) : NaN;
  const price = Number.isFinite(parsedPrice) ? parsedPrice : null;

  const deadline = sectionByTitle($, "Окончание подачи заявок");

  return { regNumber, title, customer, price, status, deadline };
}

export async function fetchProcurement(
  regNumber: string
): Promise<ProcurementSnapshot> {
  if (!isValidRegNumber(regNumber)) {
    throw new EisParseError("Некорректный реестровый номер закупки");
  }

  const res = await fetch(buildUrl(regNumber), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`ЕИС вернул ${res.status} для ${regNumber}`);
  }

  return parseProcurementHtml(await res.text(), regNumber);
}
