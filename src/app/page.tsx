"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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

interface User {
  email: string;
  trial_ends_at: string;
  subscription_status: string;
  subscription_ends_at: string | null;
  access_active: boolean;
  payment_code: string;
  payment_url: string | null;
}

function daysLeft(dateStr: string): number {
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export default function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = loading
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [items, setItems] = useState<Procurement[]>([]);
  const [regNumber, setRegNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checkingPayment, setCheckingPayment] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);

  async function checkPayment() {
    setCheckingPayment(true);
    setPaymentMessage(null);
    try {
      const res = await fetch("/api/payment/check", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      await loadUser(); // pick up the new subscription state, whoever processed the payment
      switch (data.result) {
        case "activated":
          setPaymentMessage("Оплата найдена, подписка продлена. Спасибо!");
          break;
        case "not_found":
          setPaymentMessage(
            "Платёж с вашим кодом пока не найден. Проверьте, что код указан в комментарии и сумма не меньше 400 ₽, и попробуйте ещё раз через минуту."
          );
          break;
        case "throttled":
        case "rate_limited":
          setPaymentMessage("Проверка уже выполнялась только что — подождите около 20 секунд и нажмите снова.");
          break;
        default:
          setPaymentMessage(
            "Не удалось проверить оплату. Подписка продлится автоматически в ближайшее время."
          );
      }
    } catch {
      setPaymentMessage("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setCheckingPayment(false);
    }
  }

  async function loadUser() {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    setUser(data.user);
  }

  async function loadProcurements() {
    const res = await fetch("/api/procurements");
    if (res.ok) setItems(await res.json());
  }

  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (user) loadProcurements();
  }, [user]);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Не удалось отправить код");
      }
      setCodeSent(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setAuthLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Неверный код");
      }
      await loadUser();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setCodeSent(false);
    setEmail("");
    setCode("");
  }

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
      setRegNumber("");
      await loadProcurements();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function stopTracking(id: number) {
    await fetch("/api/procurements", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ procurementId: id }),
    });
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  if (user === undefined) {
    return <main className="mx-auto max-w-3xl px-6 py-12 text-sm text-neutral-400">Загрузка...</main>;
  }

  if (!user) {
    return (
      <main className="mx-auto max-w-sm px-6 py-24">
        <h1 className="text-xl font-semibold mb-2">Вход</h1>
        <p className="text-sm text-neutral-500 mb-6">
          Мониторинг закупок (44-ФЗ) — 14 дней бесплатно, затем 400 ₽/мес.
        </p>

        {!codeSent ? (
          <form onSubmit={requestCode} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              required
            />
            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-black text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
            >
              {authLoading ? "Отправляем..." : "Получить код"}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-3">
            <p className="text-sm text-neutral-500">Код отправлен на {email}</p>
            <p className="text-xs text-neutral-400">
              Не видите письмо? Проверьте папку «Спам» — первые письма от нового
              отправителя иногда попадают туда.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-значный код"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              required
            />
            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-black text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
            >
              {authLoading ? "Проверяем..." : "Войти"}
            </button>
          </form>
        )}

        {authError && <p className="text-sm text-red-600 mt-3">{authError}</p>}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex justify-between items-start mb-2">
        <h1 className="text-2xl font-semibold">Мониторинг закупок</h1>
        <button onClick={logout} className="text-xs text-neutral-400 hover:text-neutral-600">
          Выйти ({user.email})
        </button>
      </div>

      <p className="text-sm text-neutral-500 mb-2">
        Отслеживайте изменения по конкретным закупкам (44-ФЗ) — статус, цена, срок подачи заявок.
        Уведомления приходят на {user.email}.
      </p>

      {!user.access_active ? (
        <p className="text-sm text-red-600 mb-4">
          Доступ закончился. Оформите подписку (400 ₽/мес), чтобы продолжить пользоваться сервисом.
        </p>
      ) : user.subscription_status === "active" ? (
        <p className="text-sm text-green-600 mb-4">
          Подписка активна
          {user.subscription_ends_at &&
            ` до ${new Date(user.subscription_ends_at).toLocaleDateString("ru-RU")}`}
        </p>
      ) : (
        <p className="text-sm text-amber-600 mb-4">
          Пробный период: осталось {daysLeft(user.trial_ends_at)} дн.
        </p>
      )}

      <details className="mb-6 border rounded-lg p-4 text-sm" open={!user.access_active}>
        <summary className="cursor-pointer font-medium">Оплата подписки — 400 ₽ за 30 дней</summary>
        <ol className="mt-3 space-y-2 list-decimal list-inside text-neutral-600">
          <li>
            Откройте страницу оплаты{" "}
            {user.payment_url ? (
              <a href={user.payment_url} target="_blank" rel="noreferrer" className="underline">
                DonatePay
              </a>
            ) : (
              "DonatePay"
            )}
            .
          </li>
          <li>Укажите сумму 400 ₽ (или кратную: 800 ₽ = 60 дней и т. д.).</li>
          <li>
            В поле «Комментарий» впишите ваш код:{" "}
            <code className="px-2 py-0.5 rounded bg-neutral-100 font-mono font-semibold">
              {user.payment_code}
            </code>
          </li>
        </ol>
        <button
          onClick={checkPayment}
          disabled={checkingPayment}
          className="mt-4 bg-black text-white rounded-lg px-4 py-2 text-sm border border-neutral-700 disabled:opacity-50"
        >
          {checkingPayment ? "Проверяем..." : "Я оплатил(а)"}
        </button>
        {paymentMessage && <p className="mt-3 text-sm text-neutral-300">{paymentMessage}</p>}
        <p className="mt-3 text-xs text-neutral-400">
          Без кода платёж не удастся привязать к аккаунту. Если не нажать кнопку, подписка продлится
          автоматически в течение примерно 30 минут.
        </p>
      </details>

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
            <button
              onClick={() => stopTracking(p.id)}
              className="mt-3 text-xs px-3 py-1.5 rounded-lg border text-neutral-500 hover:text-red-600"
            >
              Убрать из списка
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <p className="text-sm text-neutral-400">Пока ничего не отслеживается.</p>
        )}
      </ul>
    </main>
  );
}
