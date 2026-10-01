/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * «Мой ДМС»: выбор страховой и программы.
 *
 * В браузере сохраняется ТОЛЬКО идентификатор программы. Ни ФИО, ни номера
 * полиса, ни работодателя здесь не спрашивают: чтобы отметить, какие врачи
 * входят в программу, этого не нужно. На сервер выбор не уходит —
 * покрытие считается прямо в браузере.
 */
import { useState } from 'react';
import { Phone, ShieldCheck, X } from 'lucide-react';

const INSURED_LABEL = { adult: 'взрослая', child: 'детская', family: 'семейная' };

const formatDay = (value) => (typeof value === 'string' ? value.split('-').reverse().join('.') : '');

const telHref = (phone) => {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : null;
};

export default function DmsPanel({ insurance, planId, today, onSave, onClose, onCallPult, isDemo }) {
  const currentPlan = insurance.plans.find((plan) => plan.id === planId) || null;
  const [providerId, setProviderId] = useState(currentPlan?.providerId || insurance.providers[0]?.id || '');
  const [draftPlanId, setDraftPlanId] = useState(currentPlan?.id || '');

  const plans = insurance.plans.filter((plan) => plan.providerId === providerId);
  const draftPlan = plans.find((plan) => plan.id === draftPlanId) || null;
  const provider = insurance.providers.find((item) => item.id === providerId) || null;
  const expired = draftPlan && (today < draftPlan.validFrom || today > draftPlan.validTo);
  const pultHref = telHref(provider?.pultPhone);

  return (
    <section
      className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900 dark:bg-emerald-950/30"
      aria-label="Мой ДМС"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-bold text-emerald-800 dark:text-emerald-200">
          <ShieldCheck size={16} aria-hidden="true" /> Мой ДМС
        </h2>
        <button type="button" onClick={onClose} aria-label="Закрыть «Мой ДМС»" className="-mr-1 -mt-1 rounded-lg p-1 text-slate-400 hover:bg-white/70 dark:hover:bg-slate-700">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
          Страховая
          <select
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setDraftPlanId('');
            }}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {insurance.providers.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
          Программа
          <select
            value={draftPlanId}
            onChange={(event) => setDraftPlanId(event.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">Выберите программу</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} · {INSURED_LABEL[plan.insured] || plan.insured}
              </option>
            ))}
          </select>
        </label>
      </div>

      {draftPlan && (
        <div className="mt-3 space-y-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
          <p>
            Действует с {formatDay(draftPlan.validFrom)} по {formatDay(draftPlan.validTo)}
            {expired && <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300">— срок истёк</span>}
          </p>
          {draftPlan.insured === 'child' && (
            <p>Детская программа: отмечаются только детские врачи. Для себя выберите свою программу отдельно.</p>
          )}
          {provider?.bookingNote && <p>{provider.bookingNote}</p>}
          {pultHref && (
            <a
              href={pultHref}
              onClick={() => onCallPult?.()}
              className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
            >
              <Phone size={13} aria-hidden="true" /> Пульт {provider.name}: {provider.pultPhone}
            </a>
          )}
          {draftPlan.sourceDoc && <p className="text-slate-400 dark:text-slate-500">Источник: {draftPlan.sourceDoc}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!draftPlan}
          onClick={() => onSave(draftPlan.id)}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Отмечать мою программу
        </button>
        {planId && (
          <button
            type="button"
            onClick={() => onSave(null)}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200"
          >
            Убрать ДМС
          </button>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
        Сохраняется только выбранная программа и только в этом браузере. Номер полиса, ФИО и место работы не нужны и никуда не отправляются.
        {isDemo && ' Страховые и программы в демо-режиме вымышлены.'}
      </p>
    </section>
  );
}
