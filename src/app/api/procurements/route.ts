import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";
import { fetchProcurement } from "@/lib/eis";

export async function GET() {
  await ensureSchema();
  const db = getDb();
  const result = await db.execute("SELECT * FROM procurements ORDER BY updated_at DESC");
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const { regNumber } = await req.json();

  if (!regNumber || typeof regNumber !== "string") {
    return NextResponse.json({ error: "regNumber обязателен" }, { status: 400 });
  }

  const db = getDb();

  // Already tracked by someone else — just return it so this visitor
  // can add it to their own local list too, instead of erroring out.
  const existing = await db.execute({
    sql: "SELECT * FROM procurements WHERE reg_number = ?",
    args: [regNumber],
  });
  if (existing.rows.length > 0) {
    return NextResponse.json(existing.rows[0], { status: 200 });
  }

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

  return NextResponse.json(
    { id: Number(inserted.lastInsertRowid), reg_number: regNumber, ...snapshot },
    { status: 201 }
  );
}
