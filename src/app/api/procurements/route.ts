import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";
import { fetchProcurement } from "@/lib/eis";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT procurements.* FROM procurements
          JOIN user_procurements ON user_procurements.procurement_id = procurements.id
          WHERE user_procurements.user_id = ?
          ORDER BY procurements.updated_at DESC`,
    args: [user.id as number],
  });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const { regNumber } = await req.json();
  if (!regNumber || typeof regNumber !== "string") {
    return NextResponse.json({ error: "regNumber обязателен" }, { status: 400 });
  }

  const db = getDb();

  let procurement;
  const existing = await db.execute({
    sql: "SELECT * FROM procurements WHERE reg_number = ?",
    args: [regNumber],
  });

  if (existing.rows.length > 0) {
    procurement = existing.rows[0];
  } else {
    const snapshot = await fetchProcurement(regNumber);
    const inserted = await db.execute({
      sql: `INSERT INTO procurements (reg_number, title, customer, price, status, deadline, raw_json)
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
    procurement = { id: Number(inserted.lastInsertRowid), reg_number: regNumber, ...snapshot };
  }

  await db.execute({
    sql: `INSERT INTO user_procurements (user_id, procurement_id) VALUES (?, ?)
          ON CONFLICT(user_id, procurement_id) DO NOTHING`,
    args: [user.id as number, procurement.id as number],
  });

  return NextResponse.json(procurement, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const { procurementId } = await req.json();
  if (!procurementId) {
    return NextResponse.json({ error: "procurementId обязателен" }, { status: 400 });
  }

  const db = getDb();
  await db.execute({
    sql: `DELETE FROM user_procurements WHERE user_id = ? AND procurement_id = ?`,
    args: [user.id as number, procurementId],
  });

  return NextResponse.json({ ok: true });
}
