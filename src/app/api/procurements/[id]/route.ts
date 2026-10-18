import { NextRequest, NextResponse } from "next/server";
import { getDb, ensureSchema } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }

  const db = getDb();

  // Only procurements the current user tracks; raw_json stays server-side.
  // Same 404 for "doesn't exist" and "not yours" so ids can't be probed.
  const procurement = await db.execute({
    sql: `SELECT procurements.id, procurements.reg_number, procurements.title,
                 procurements.customer, procurements.price, procurements.status,
                 procurements.deadline, procurements.created_at, procurements.updated_at
          FROM procurements
          JOIN user_procurements ON user_procurements.procurement_id = procurements.id
          WHERE procurements.id = ? AND user_procurements.user_id = ?`,
    args: [id, Number(user.id)],
  });

  if (procurement.rows.length === 0) {
    return NextResponse.json({ error: "Не найдено" }, { status: 404 });
  }

  const changes = await db.execute({
    sql: `SELECT id, field, old_value, new_value, detected_at
          FROM procurement_changes WHERE procurement_id = ? ORDER BY detected_at ASC`,
    args: [id],
  });

  return NextResponse.json({
    procurement: procurement.rows[0],
    changes: changes.rows,
  });
}
