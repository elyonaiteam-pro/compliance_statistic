// ЕИС (zakupki.gov.ru) card fetching + parsing + change detection.
// Plain .mjs (JSDoc-typed) so the Next.js app (src/lib/eis.ts) and the standalone
// cron script share ONE implementation instead of two hand-synced copies.
//
// NOTE: zakupki.gov.ru has no simple public JSON API for this (open services
// need a token / ЭЦП), so we read the public card page of each tracked
// procurement — low volume, only what users follow.
import * as cheerio from "cheerio";

/**
 * @typedef {Object} ProcurementSnapshot
 * @property {string} regNumber
 * @property {string | null} title
 * @property {string | null} customer
 * @property {number | null} price
 * @property {string | null} status
 * @property {string | null} deadline
 */

/** The page loaded but is not a procurement card (captcha, block page, layout change, unknown number). */
export class EisParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "EisParseError";
  }
}

/** ЕИС answered with an HTTP error status. */
export class EisHttpError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = "EisHttpError";
    this.status = status;
  }
}

/**
 * Card URL variants (44-ФЗ notice types). The card for a given number lives under
 * the path of its procurement method: zk20 = запрос котировок, ea20 = электронный
 * аукцион, ok20 = электронный конкурс, ep20 = у единственного поставщика,
 * za20 = запрос предложений. Only zk20 was verified against a live card;
 * the rest are probed at runtime and the one that parses is remembered per
 * procurement (procurements.notice_type), so a wrong guess costs nothing but one request.
 */
export const NOTICE_TYPES = ["zk20", "ea20", "ok20", "ep20", "za20", "ea44"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Registry numbers in ЕИС: 19 digits for 44-ФЗ notices, 11 digits for 223-ФЗ.
 * Both shapes are accepted; 223-ФЗ cards use different markup and fail to parse.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRegNumber(value) {
  return typeof value === "string" && /^(\d{11}|\d{19})$/.test(value);
}

/**
 * @param {string} noticeType
 * @param {string} regNumber
 */
export function buildUrl(noticeType, regNumber) {
  return `https://zakupki.gov.ru/epz/order/notice/${noticeType}/view/common-info.html?regNumber=${encodeURIComponent(
    regNumber
  )}`;
}

/**
 * @param {import("cheerio").CheerioAPI} $
 * @param {string} titleText
 * @returns {string | null}
 */
function sectionByTitle($, titleText) {
  /** @type {string | null} */
  let result = null;
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
 * @param {string} html
 * @param {string} regNumber
 * @returns {ProcurementSnapshot}
 */
export function parseProcurementHtml(html, regNumber) {
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

/**
 * @typedef {Object} FetchOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {number} [timeoutMs]
 * @property {number} [retries] extra attempts for network errors, 429 and 5xx
 */

const defaultSleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with timeout and bounded retries (network error, 429, 5xx) using backoff.
 * 404 and other 4xx are not retried. Returns the response body.
 * @param {string} url
 * @param {FetchOptions} [options]
 * @returns {Promise<string>}
 */
export async function fetchHtml(url, options = {}) {
  const { fetchImpl = fetch, sleep = defaultSleep, timeoutMs = 15_000, retries = 2 } = options;
  /** @type {unknown} */
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1)); // 1s, 3s, ...
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.text();
      const err = new EisHttpError(`ЕИС вернул ${res.status}`, res.status);
      if (res.status === 429 || res.status >= 500) {
        lastError = err;
        continue;
      }
      throw err;
    } catch (err) {
      if (err instanceof EisHttpError && err.status !== 429 && err.status < 500) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Не удалось загрузить страницу ЕИС");
}

/**
 * Loads and parses a procurement card.
 * - With `preferredType` (known from an earlier success) only that URL is requested:
 *   a captcha/block must not make us hammer the server with other variants. Only a 404
 *   (card moved to another type) falls back to probing the rest.
 * - Without it, the known variants are probed in order until one parses.
 * @param {string} regNumber
 * @param {FetchOptions & { preferredType?: string | null }} [options]
 * @returns {Promise<{ snapshot: ProcurementSnapshot, noticeType: string }>}
 */
export async function fetchCard(regNumber, options = {}) {
  if (!isValidRegNumber(regNumber)) {
    throw new EisParseError("Некорректный реестровый номер закупки");
  }
  const { preferredType, ...fetchOptions } = options;

  /** @type {Error | null} */
  let lastNotFound = null;
  const candidates = preferredType
    ? [preferredType, ...NOTICE_TYPES.filter((t) => t !== preferredType)]
    : NOTICE_TYPES;

  for (let i = 0; i < candidates.length; i++) {
    const noticeType = candidates[i];
    const isPreferred = Boolean(preferredType) && i === 0;
    try {
      const html = await fetchHtml(buildUrl(noticeType, regNumber), fetchOptions);
      return { snapshot: parseProcurementHtml(html, regNumber), noticeType };
    } catch (err) {
      if (isPreferred && !(err instanceof EisHttpError && err.status === 404)) throw err;
      if (err instanceof EisParseError || (err instanceof EisHttpError && err.status === 404)) {
        lastNotFound = err;
        continue;
      }
      throw err; // network trouble / 5xx after retries: don't spray other variants
    }
  }
  throw lastNotFound ?? new EisParseError(`Карточка закупки ${regNumber} не найдена`);
}

export const FIELDS = ["title", "customer", "price", "status", "deadline"];

/** Fields that never legitimately become empty once known; empty = partial/odd page. */
const NEVER_EMPTY = new Set(["title", "customer", "price"]);

/**
 * Compares the stored row with a fresh snapshot.
 * Returns the real changes plus `merged`: the values to store, where a suspicious
 * "became empty" core field keeps its old value instead of being reported as a change.
 * @param {Record<string, unknown>} row
 * @param {ProcurementSnapshot} fresh
 * @returns {{ changes: { field: string, oldValue: unknown, newValue: unknown }[], merged: ProcurementSnapshot, suspicious: string[] }}
 */
export function detectChanges(row, fresh) {
  /** @type {{ field: string, oldValue: unknown, newValue: unknown }[]} */
  const changes = [];
  /** @type {string[]} */
  const suspicious = [];
  const merged = { ...fresh };

  for (const field of FIELDS) {
    const oldValue = row[field];
    const newValue = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (fresh))[field];
    const becameEmpty = newValue === null || newValue === undefined || newValue === "";
    const hadValue = oldValue !== null && oldValue !== undefined && oldValue !== "";

    if (NEVER_EMPTY.has(field) && becameEmpty && hadValue) {
      suspicious.push(field);
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (merged))[field] = oldValue;
      continue;
    }
    if (String(oldValue ?? "") !== String(newValue ?? "")) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return { changes, merged, suspicious };
}
