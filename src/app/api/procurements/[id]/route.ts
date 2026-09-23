import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();
  const { id } = await params;
  const db = getDb();

  const procurement = await db.execute({
    sql: "SELECT * FROM procurements WHERE id = ?",
    args: [id],
  });

  if (procurement.rows.length === 0) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }

  const changes = await db.execute({
    sql: `SELECT * FROM procurement_changes WHERE procurement_id = ? ORDER BY detected_at ASC`,
    args: [id],
  });

  return NextResponse.json({
    procurement: procurement.rows[0],
    changes: changes.rows,
  });
}
