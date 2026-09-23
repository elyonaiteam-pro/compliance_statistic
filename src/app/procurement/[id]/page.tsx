"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";

interface Procurement {
  id: number;
  reg_number: string;
  title: string | null;
  customer: string | null;
  price: number | null;
  status: string | null;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

interface Change {
  id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  detected_at: string;
}

const FIELD_LABELS: Record<string, string> = {
  title: "Название",
  customer: "Заказчик",
  price: "Цена",
  status: "Статус",
  deadline: "Срок подачи заявок",
};

function PriceChart({ points }: { points: { x: string; y: number }[] }) {
  if (points.length < 2) return null;

  const width = 640;
  const height = 200;
  const padding = 32;

  const values = points.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const coords = points.map((p, i) => {
    const svgX = padding + (i / (points.length - 1)) * (width - padding * 2);
    const svgY = height - padding - ((p.y - min) / range) * (height - padding * 2);
    const label = new Date(p.x).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    return { svgX, svgY, label, value: p.y };
  });

  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.svgX} ${c.svgY}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-blue-500" />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.svgX} cy={c.svgY} r={4} className="fill-blue-500" />
          <text x={c.svgX} y={height - 8} fontSize={10} textAnchor="middle" className="fill-neutral-500">
            {c.label}
          </text>
        </g>
      ))}
      <text x={padding} y={16} fontSize={11} className="fill-neutral-400">
        {max.toLocaleString("ru-RU")} ₽
      </text>
      <text x={padding} y={height - padding + 4} fontSize={11} className="fill-neutral-400">
        {min.toLocaleString("ru-RU")} ₽
      </text>
    </svg>
  );
}

export default function ProcurementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [procurement, setProcurement] = useState<Procurement | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/procurements/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Не удалось загрузить закупку");
        return res.json();
      })
      .then((data) => {
        setProcurement(data.procurement);
        setChanges(data.changes);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <main className="mx-auto max-w-3xl px-6 py-12 text-sm text-neutral-400">Загрузка...</main>;
  if (error || !procurement)
    return <main className="mx-auto max-w-3xl px-6 py-12 text-sm text-red-600">{error || "Не найдено"}</main>;

  const priceChanges = changes.filter((c) => c.field === "price");
  const pricePoints = [
    ...(priceChanges.length > 0 && priceChanges[0].old_value
      ? [{ x: procurement.created_at, y: parseFloat(priceChanges[0].old_value) }]
      : []),
    ...priceChanges.map((c) => ({ x: c.detected_at, y: parseFloat(c.new_value || "0") })),
  ].filter((p) => !Number.isNaN(p.y));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">
        ← Ко всем закупкам
      </Link>

      <h1 className="text-xl font-semibold mt-4">{procurement.title || procurement.reg_number}</h1>
      <p className="text-sm text-neutral-500 mt-1">{procurement.customer}</p>

      <div className="mt-4 flex gap-6 text-sm">
        <div>
          <div className="text-neutral-400">Статус</div>
          <div>{procurement.status || "—"}</div>
        </div>
        <div>
          <div className="text-neutral-400">Цена</div>
          <div>{procurement.price != null ? `${procurement.price.toLocaleString("ru-RU")} ₽` : "—"}</div>
        </div>
        <div>
          <div className="text-neutral-400">Срок подачи заявок</div>
          <div>{procurement.deadline || "—"}</div>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-medium mb-3">Динамика цены</h2>
        {pricePoints.length >= 2 ? (
          <PriceChart points={pricePoints} />
        ) : (
          <p className="text-sm text-neutral-400">
            Пока недостаточно данных для графика — цена ещё не менялась с момента добавления. График появится
            после первого зафиксированного изменения.
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium mb-3">История изменений</h2>
        {changes.length === 0 ? (
          <p className="text-sm text-neutral-400">Изменений пока не зафиксировано.</p>
        ) : (
          <ul className="space-y-2">
            {changes
              .slice()
              .reverse()
              .map((c) => (
                <li key={c.id} className="text-sm border-l-2 border-neutral-200 pl-3">
                  <span className="text-neutral-400">
                    {new Date(c.detected_at).toLocaleString("ru-RU")} —{" "}
                  </span>
                  <span className="font-medium">{FIELD_LABELS[c.field] || c.field}: </span>
                  <span className="text-neutral-500 line-through">{c.old_value}</span>{" "}
                  <span>→ {c.new_value}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </main>
  );
}
