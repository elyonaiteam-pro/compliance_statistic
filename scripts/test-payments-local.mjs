// Local end-to-end test of the DonatePay payment flow WITHOUT real money.
//
// It starts a tiny fake DonatePay API (same JSON shape as the real one) and points
// the real code at it via DONATEPAY_TRANSACTIONS_URL, using a throwaway local
// SQLite file instead of your Turso database. Nothing touches production data.
//
//   node scripts/test-payments-local.mjs          # automated test of scripts/check-payments.mjs
//   node scripts/test-payments-local.mjs --serve  # fake DonatePay for manual testing of the web UI
//                                                 #   (optional: --sum=800 to change the fake amount)
import { createClient } from "@libsql/client";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const DB_FILE = ".test-payments.db";
const DB_URL = `file:${DB_FILE}`;
const PORT = Number(process.env.MOCK_PORT || 4010);
const MOCK_URL = `http://127.0.0.1:${PORT}/api/v1/transactions`;
const SERVE = process.argv.includes("--serve");
const SERVE_SUM = Number((process.argv.find((a) => a.startsWith("--sum=")) || "--sum=400").split("=")[1]);

// Automated mode always starts from a clean DB (must happen before the client opens the file).
if (!SERVE) {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) rmSync(f, { force: true });
}

const db = createClient({ url: DB_URL });

function tx(id, sum, comment) {
  return {
    id,
    what: "Anon",
    sum: Number(sum).toFixed(2),
    currency: "RUB",
    to_cash: (sum * 0.91).toFixed(2),
    to_pay: Number(sum).toFixed(2),
    commission: (sum * 0.09).toFixed(2),
    status: "success",
    type: "donation",
    comment,
    created_at: new Date().toISOString(),
    vars: { name: "Anon", comment },
  };
}

// ---------- fake DonatePay API ----------
let fakeTransactions = []; // used in automated mode

async function transactionsForServeMode() {
  // One fake donation per user that has a payment code, with the code in the comment.
  try {
    const r = await db.execute("SELECT id, payment_code FROM users WHERE payment_code IS NOT NULL");
    return r.rows.map((u) => tx(99000000 + Number(u.id), SERVE_SUM, `Подписка ${u.payment_code}`));
  } catch {
    return []; // tables not created yet (dev server hasn't been opened)
  }
}

const server = createServer(async (_req, res) => {
  const list = SERVE ? await transactionsForServeMode() : fakeTransactions;
  const sorted = [...list].sort((a, b) => b.id - a.id); // newest first, like order=DESC
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "success", data: sorted }));
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

if (SERVE) {
  console.log(`Fake DonatePay запущен: ${MOCK_URL}`);
  console.log(`Для каждого пользователя с кодом оплаты отдаёт донат ${SERVE_SUM} ₽ с этим кодом в комментарии.`);
  console.log(`\nВ ДРУГОМ терминале запустите сайт против локальной БД и fake-API:\n`);
  console.log(`  $env:TURSO_DATABASE_URL="${DB_URL}"; $env:TURSO_AUTH_TOKEN=""`);
  console.log(`  $env:DONATEPAY_API_KEY="test"; $env:DONATEPAY_TRANSACTIONS_URL="${MOCK_URL}"`);
  console.log(`  npm run dev\n`);
  console.log(`Затем: войдите по email → откройте «Оплата подписки» → «Я оплатил(а)».`);
  console.log(`Сбросить тест: остановите оба процесса и удалите ${DB_FILE}*. Остановка: Ctrl+C.`);
} else {
  await runAutomatedTest();
}

// ---------- automated test ----------
function runCheck() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/check-payments.mjs"], {
      env: {
        ...process.env,
        TURSO_DATABASE_URL: DB_URL,
        TURSO_AUTH_TOKEN: "",
        DONATEPAY_API_KEY: "test",
        DONATEPAY_TRANSACTIONS_URL: MOCK_URL,
        GMAIL_USER: "", // never send real emails from the test
        GMAIL_APP_PASSWORD: "",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function runAutomatedTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, ok, extra = "") => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
    ok ? passed++ : failed++;
  };
  const daysFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 86_400_000;
  const near = (v, target) => Math.abs(v - target) < 0.1;

  // Base schema as it was BEFORE payments existed — also exercises the migration path.
  await db.execute(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    trial_ends_at TEXT NOT NULL,
    subscription_status TEXT NOT NULL DEFAULT 'trial',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  console.log("1. Миграция (пустой список транзакций)");
  let r = await runCheck();
  check("скрипт завершился без ошибок", r.code === 0, r.out);
  const cols = (await db.execute("PRAGMA table_info(users)")).rows.map((x) => String(x.name));
  check("добавлены колонки payment_code и subscription_ends_at", cols.includes("payment_code") && cols.includes("subscription_ends_at"));

  const trialEnd = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const users = [
    ["alice@test.local", "ABC234"],
    ["bob@test.local", "XYZ789"],
    ["carol@test.local", "KMN456"],
  ];
  for (const [email, code] of users) {
    await db.execute({
      sql: "INSERT INTO users (email, trial_ends_at, subscription_status, payment_code) VALUES (?, ?, 'trial', ?)",
      args: [email, trialEnd, code],
    });
  }
  const getUser = async (email) =>
    (await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] })).rows[0];
  const paymentRows = async () => (await db.execute("SELECT * FROM payments ORDER BY id")).rows;

  console.log("2. Оплата 400 ₽ с кодом Alice");
  fakeTransactions.push(tx(1001, 400, "Подписка ABC234"));
  r = await runCheck();
  let alice = await getUser("alice@test.local");
  check("подписка Alice стала active", alice.subscription_status === "active", r.out);
  check("срок ≈ +30 дней", alice.subscription_ends_at && near(daysFromNow(String(alice.subscription_ends_at)), 30));
  check("платёж записан как activated", (await paymentRows()).some((p) => p.donatepay_id === "1001" && p.outcome === "activated"));

  console.log("3. Повторный запуск (идемпотентность)");
  const endsBefore = String(alice.subscription_ends_at);
  r = await runCheck();
  alice = await getUser("alice@test.local");
  check("срок не изменился", String(alice.subscription_ends_at) === endsBefore);
  check("в payments всё ещё одна запись", (await paymentRows()).length === 1);

  console.log("4. Недоплата 250 ₽ (Bob)");
  fakeTransactions.push(tx(1002, 250, "Подписка XYZ789"));
  await runCheck();
  let bob = await getUser("bob@test.local");
  check("Bob остался на trial", bob.subscription_status === "trial");
  check("платёж записан как underpaid", (await paymentRows()).some((p) => p.donatepay_id === "1002" && p.outcome === "underpaid"));

  console.log("5. Оплата 800 ₽ (Carol), код строчными буквами с пробелом");
  fakeTransactions.push(tx(1003, 800, "оплата kmn 456 спасибо"));
  await runCheck();
  const carol = await getUser("carol@test.local");
  check("подписка Carol active", carol.subscription_status === "active");
  check("срок ≈ +60 дней", carol.subscription_ends_at && near(daysFromNow(String(carol.subscription_ends_at)), 60));

  console.log("6. Вторая оплата Alice 400 ₽ (продление поверх текущей)");
  fakeTransactions.push(tx(1004, 400, "ABC234"));
  await runCheck();
  alice = await getUser("alice@test.local");
  check("срок ≈ +60 дней (30 + 30)", alice.subscription_ends_at && near(daysFromNow(String(alice.subscription_ends_at)), 60));

  console.log("7. Платёж без кода");
  fakeTransactions.push(tx(1005, 400, "просто донат"));
  const before = (await db.execute("SELECT subscription_ends_at FROM users ORDER BY id")).rows.map((x) => String(x.subscription_ends_at));
  await runCheck();
  const after = (await db.execute("SELECT subscription_ends_at FROM users ORDER BY id")).rows.map((x) => String(x.subscription_ends_at));
  check("ничья подписка не изменилась", JSON.stringify(before) === JSON.stringify(after));
  check("платёж записан как no_match", (await paymentRows()).some((p) => p.donatepay_id === "1005" && p.outcome === "no_match"));

  console.log("8. Истёкшая подписка продлевается от «сейчас», а не от прошлой даты");
  await db.execute({
    sql: "UPDATE users SET subscription_status = 'active', subscription_ends_at = ? WHERE email = 'bob@test.local'",
    args: [new Date(Date.now() - 10 * 86_400_000).toISOString()],
  });
  fakeTransactions.push(tx(1006, 400, "XYZ789"));
  await runCheck();
  bob = await getUser("bob@test.local");
  check("срок ≈ +30 дней от сегодня", bob.subscription_ends_at && near(daysFromNow(String(bob.subscription_ends_at)), 30));

  console.log(`\nИтого: ${passed} прошло, ${failed} не прошло`);
  server.close();
  db.close();
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* leftover test file is harmless; it is recreated on the next run */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
