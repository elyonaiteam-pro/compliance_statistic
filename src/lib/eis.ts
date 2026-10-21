import {
  fetchCard,
  isValidRegNumber,
  parseProcurementHtml,
  EisParseError,
  EisHttpError,
  type ProcurementSnapshot as CoreSnapshot,
} from "./eis-core.mjs";
import { createEisFetch } from "./eis-fetch.mjs";

// The implementation lives in eis-core.mjs so the cron script shares it verbatim.
export { isValidRegNumber, parseProcurementHtml, EisParseError, EisHttpError };

export type ProcurementSnapshot = CoreSnapshot;

/** Snapshot plus which card URL variant (zk20, ea20, ...) it was found under. */
export type FetchedProcurement = ProcurementSnapshot & { noticeType: string };

/**
 * Loads one procurement card from zakupki.gov.ru.
 * Throws EisParseError if the number isn't a (44-ФЗ) card, other errors if ЕИС is unreachable.
 */
export async function fetchProcurement(
  regNumber: string,
  preferredType?: string | null
): Promise<FetchedProcurement> {
  const { snapshot, noticeType } = await fetchCard(regNumber, {
    preferredType,
    // Goes through EIS_PROXY_URL (Russian exit IP) when configured; see eis-fetch.mjs.
    fetchImpl: createEisFetch(),
  });
  return { ...snapshot, noticeType };
}
