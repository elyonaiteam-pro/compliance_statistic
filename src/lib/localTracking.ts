const TRACKED_KEY = "compliance-statistic:tracked-ids";
const SUBSCRIBED_KEY = "compliance-statistic:subscribed-ids";

function readIds(key: string): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: number[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(ids));
}

export function getTrackedIds(): number[] {
  return readIds(TRACKED_KEY);
}

export function addTrackedId(id: number) {
  const ids = readIds(TRACKED_KEY);
  if (!ids.includes(id)) writeIds(TRACKED_KEY, [...ids, id]);
}

export function removeTrackedId(id: number) {
  writeIds(TRACKED_KEY, readIds(TRACKED_KEY).filter((x) => x !== id));
}

export function getSubscribedIds(): number[] {
  return readIds(SUBSCRIBED_KEY);
}

export function addSubscribedId(id: number) {
  const ids = readIds(SUBSCRIBED_KEY);
  if (!ids.includes(id)) writeIds(SUBSCRIBED_KEY, [...ids, id]);
}
