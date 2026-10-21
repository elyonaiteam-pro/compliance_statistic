// Network egress for ЕИС requests.
//
// zakupki.gov.ru is unreliable/blocked for non-Russian IP addresses, and both GitHub Actions
// runners and Vercel functions run abroad. When EIS_PROXY_URL is set (an HTTP(S) proxy with a
// Russian exit IP, e.g. http://user:pass@host:port), every ЕИС request goes through it.
// Without it requests are sent directly — fine when the code runs from a Russian IP.

/** @type {Map<string, typeof fetch>} one fetch (and proxy agent) per proxy URL, reused across calls */
const cache = new Map();

/**
 * @param {string | undefined} [proxyUrl] defaults to process.env.EIS_PROXY_URL
 * @returns {typeof fetch}
 */
export function createEisFetch(proxyUrl = process.env.EIS_PROXY_URL) {
  if (!proxyUrl || !proxyUrl.trim()) return fetch;
  const url = proxyUrl.trim();
  const cached = cache.get(url);
  if (cached) return cached;

  /** @type {Promise<import("undici").ProxyAgent> | null} */
  let agentPromise = null;
  const getAgent = () => {
    agentPromise ??= import("undici").then(({ ProxyAgent }) => new ProxyAgent(url));
    return agentPromise;
  };

  const proxied = /** @type {typeof fetch} */ (
    async (input, init) => {
      const [{ fetch: undiciFetch }, dispatcher] = await Promise.all([import("undici"), getAgent()]);
      return /** @type {any} */ (undiciFetch)(input, { ...init, dispatcher });
    }
  );
  cache.set(url, proxied);
  return proxied;
}
