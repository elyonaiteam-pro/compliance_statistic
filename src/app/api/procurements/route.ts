import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";
import { fetchProcurement, isValidRegNumber, EisParseError } from "@/lib/eis";
import { getCurrentUser, userHasAccess } from "@/lib/auth";
import { readJsonObject } from "@/lib/http";

/** Safety cap so one account can't make us scrape ЕИС without bound. */
const MAX_TRACKED_PER_USER = 100;

// raw_json is internal (full scraped snapshot) and is never sent to clients.
const PUBLIC_COLUMNS = `procurements.id, procurements.reg_number, procurements.title,
  procurements.customer, procurements.price, procurements.status, procurements.deadline,
  procurements.created_at, procurements.updated_at`;

export async function GET() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ${PUBLIC_COLUMNS} FROM procurements
          JOIN user_procurements ON user_procurements.procurement_id = procurements.id
          WHERE user_procurements.user_id = ?
          ORDER BY procurements.updated_at DESC`,
    args: [Number(user.id)],
  });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  if (!userHasAccess(user)) {
    return NextResponse.json(
      { error: "Доступ закончился. Оформите подписку, чтобы добавлять закупки." },
      { status: 402 }
    );
  }

  const body = await readJsonObject(req);
  const regNumber = typeof body?.regNumber === "string" ? body.regNumber.trim() : "";
  if (!isValidRegNumber(regNumber)) {
    return NextResponse.json(
      { error: "Реестровый номер должен состоять из 11 или 19 цифр" },
      { status: 400 }
    );
  }

  const db = getDb();
  const userId = Number(user.id);

  const count = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM user_procurements WHERE user_id = ?",
    args: [userId],
  });
  if (Number(count.rows[0].c) >= MAX_TRACKED_PER_USER) {
    return NextResponse.json(
      { error: `Можно отслеживать не более ${MAX_TRACKED_PER_USER} закупок` },
      { status: 400 }
    );
  }

  let existing = await db.execute({
    sql: "SELECT id FROM procurements WHERE reg_number = ?",
    args: [regNumber],
  });

  if (existing.rows.length === 0) {
    let snapshot;
    try {
      snapshot = await fetchProcurement(regNumber);
    } catch (err) {
      if (err instanceof EisParseError) {
        return NextResponse.json(
          { error: "Закупка не найдена в ЕИС или это не карточка 44-ФЗ. Проверьте номер." },
          { status: 422 }
        );
      }
      return NextResponse.json(
        { error: "ЕИС сейчас недоступен. Попробуйте позже." },
        { status: 502 }
      );
    }

    // OR IGNORE: a concurrent request for the same number may have inserted it already.
    await db.execute({
      sql: `INSERT OR IGNORE INTO procurements (reg_number, title, customer, price, status, deadline, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        regNumber,
        snapshot.title,
        snapshot.customer,
        snapshot.price,
        snapshot.status,
        snapshot.deadline,
        JSON.stringify(snapshot),
      ],
    });
    existing = await db.execute({
      sql: "SELECT id FROM procurements WHERE reg_number = ?",
      args: [regNumber],
    });
  }

  const procurementId = Number(existing.rows[0].id);

  await db.execute({
    sql: `INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)
          ON CONFLICT(user_id, procurement_id) DO NOTHING`,
    args: [userId, procurementId],
  });

  const row = await db.execute({
    sql: `SELECT ${PUBLIC_COLUMNS} FROM procurements WHERE id = ?`,
    args: [procurementId],
  });

  return NextResponse.json(row.rows[0], { status: 201 });
}

export async function DELETE(req: NextRequest) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const body = await readJsonObject(req);
  const procurementId = Number(body?.procurementId);
  if (!Number.isInteger(procurementId) || procurementId <= 0) {
    return NextResponse.json({ error: "procurementId обязателен" }, { status: 400 });
  }

  const db = getDb();
  await db.execute({
    sql: `DELETE FROM user_procurements WHERE user_id = ? AND procurement_id = ?`,
    args: [Number(user.id), procurementId],
  });

  return NextResponse.json({ ok: true });
}
