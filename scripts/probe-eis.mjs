// Diagnostic: can THIS machine reach zakupki.gov.ru, directly and (if configured) via EIS_PROXY_URL?
//   node scripts/probe-eis.mjs [regNumber]
// Runs in GitHub Actions via .github/workflows/probe-eis.yml (manual). Prints no secrets.
import { fetchCard, describeNetworkError } from "../src/lib/eis-core.mjs";
import { createEisFetch } from "../src/lib/eis-fetch.mjs";

const regNumber = process.argv[2] || process.env.PROBE_REG_NUMBER || "";

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`✅ ${label}: ${out} (${Date.now() - t0} мс)`);
    return true;
  } catch (err) {
    console.log(`❌ ${label}: ${describeNetworkError(err).message} (${Date.now() - t0} мс)`);
    return false;
  }
}

async function main() {
  await timed("IP/страна этого узла (ipinfo.io)", async () => {
    const res = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
    const j = await res.json();
    return `${j.ip} · ${j.country} · ${j.org}`;
  });

  const variants = [["напрямую", fetch]];
  if (process.env.EIS_PROXY_URL) variants.push(["через EIS_PROXY_URL", createEisFetch()]);
  else console.log("ℹ️ EIS_PROXY_URL не задан — проверяем только прямое соединение");

  let anyOk = false;
  for (const [name, fetchImpl] of variants) {
    const ok = await timed(`zakupki.gov.ru главная, ${name}`, async () => {
      const res = await fetchImpl("https://zakupki.gov.ru/", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36" },
        signal: AbortSignal.timeout(20_000),
      });
      return `HTTP ${res.status}`;
    });
    anyOk ||= ok;

    if (ok && regNumber) {
      await timed(`карточка ${regNumber}, ${name}`, async () => {
        const { snapshot, noticeType } = await fetchCard(regNumber, { fetchImpl, retries: 0 });
        return `тип ${noticeType}, «${snapshot.title}», цена ${snapshot.price}`;
      });
    }
  }

  console.log(anyOk ? "\nИтог: ЕИС доступен хотя бы одним способом." : "\nИтог: ЕИС недоступен ни одним способом.");
  process.exit(anyOk ? 0 : 1);
}

main();
