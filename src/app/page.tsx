"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getTrackedIds,
  addTrackedId,
  removeTrackedId,
  getSubscribedIds,
  addSubscribedId,
} from "@/lib/localTracking";

interface Procurement {
  id: number;
  reg_number: string;
  title: string | null;
  customer: string | null;
  price: number | null;
  status: string | null;
  deadline: string | null;
  updated_at: string;
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export default function Home() {
  const [items, setItems] = useState<Procurement[]>([]);
  const [regNumber, setRegNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscribedIds, setSubscribedIds] = useState<Set<number>>(new Set());
  const [subscribing, setSubscribing] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  async function load() {
    const res = await fetch("/api/procurements");
    if (!res.ok) return;
    const all: Procurement[] = await res.json();
    const trackedIds = new Set(getTrackedIds());
    setItems(all.filter((p) => trackedIds.has(p.id)));
  }

  useEffect(() => {
    setSubscribedIds(new Set(getSubscribedIds()));
    load().finally(() => setReady(true));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // ignore — push just won't be available
      });
    }
  }, []);

  async function addProcurement(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/procurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regNumber }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Не удалось добавить закупку");
      }
      const procurement = await res.json();
      addTrackedId(procurement.id);
      setRegNumber("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  function stopTracking(id: number) {
    removeTrackedId(id);
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  async function subscribeToNotifications(procurementId: number) {
    setSubscribing(procurementId);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Браузер не поддерживает уведомления");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Уведомления не разрешены");
      }

      const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!publicKey) throw new Error("VAPID-ключ не настроен");

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ procurementId, subscription: subscription.toJSON() }),
      });
      if (!res.ok) throw new Error("Не удалось сохранить подписку");

      addSubscribedId(procurementId);
      setSubscribedIds((prev) => new Set(prev).add(procurementId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка подписки");
    } finally {
      setSubscribing(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold mb-2">Мониторинг закупок</h1>
      <p className="text-sm text-neutral-500 mb-8">
        Отслеживайте изменения по конкретным закупкам (44-ФЗ) — статус, цена, срок подачи заявок.
        Список закупок сохраняется только в этом браузере.
      </p>

      <form onSubmit={addProcurement} className="flex gap-2 mb-8">
        <input
          value={regNumber}
          onChange={(e) => setRegNumber(e.target.value)}
          placeholder="Реестровый номер закупки"
          className="flex-1 border rounded-lg px-3 py-2 text-sm"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-black text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
        >
          {loading ? "Добавляем..." : "Отслеживать"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      <ul className="space-y-3">
        {items.map((p) => (
          <li key={p.id} className="border rounded-lg p-4">
            <div className="flex justify-between items-start gap-3">
              <Link href={`/procurement/${p.id}`} className="flex-1 hover:opacity-80">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium">{p.title || p.reg_number}</p>
                    <p className="text-sm text-neutral-500">{p.customer}</p>
                  </div>
                  <span className="text-xs px-2 py-1 rounded-full bg-neutral-100 whitespace-nowrap">
                    {p.status || "статус неизвестен"}
                  </span>
                </div>
                <div className="mt-2 text-sm text-neutral-600 flex gap-4">
                  {p.price != null && <span>{p.price.toLocaleString("ru-RU")} ₽</span>}
                  {p.deadline && <span>Срок: {p.deadline}</span>}
                </div>
              </Link>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => subscribeToNotifications(p.id)}
                disabled={subscribing === p.id || subscribedIds.has(p.id)}
                className="text-xs px-3 py-1.5 rounded-lg border disabled:opacity-50"
              >
                {subscribedIds.has(p.id)
                  ? "Уведомления включены"
                  : subscribing === p.id
                  ? "Подключаем..."
                  : "Получать уведомления"}
              </button>
              <button
                onClick={() => stopTracking(p.id)}
                className="text-xs px-3 py-1.5 rounded-lg border text-neutral-500 hover:text-red-600"
              >
                Убрать из списка
              </button>
            </div>
          </li>
        ))}
        {ready && items.length === 0 && (
          <p className="text-sm text-neutral-400">Пока ничего не отслеживается.</p>
        )}
      </ul>
    </main>
  );
}
