/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личный кабинет: вход по email и паролю, программа ДМС, избранные врачи.
 */
import { useEffect, useRef, useState } from 'react';
import { MotionConfig, motion as Motion } from 'motion/react';
import {
  CalendarClock,
  CircleCheck,
  Heart,
  Info,
  Loader2,
  LogOut,
  MapPin,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
  LayoutDashboard,
  UserRound,
} from 'lucide-react';

import AuthFlow from './auth/AuthFlow';
import { Avatar as PhotoAvatar } from './ui/kit';
import { Link } from './ui/router';

const INSURED_LABEL = { adult: 'для взрослых', child: 'детская', family: 'семейная' };

const formatDate = (iso) => {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
};

const initialsOf = (name) =>
  String(name || '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '·';

const Section = ({ icon, title, aside, children }) => {
  const Icon = icon;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Icon size={15} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
};

/* ---------- Гость ---------- */

const GuestView = ({ account, support, onBusy }) => {
  const { features } = account;

  if (!features.available) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[13px] leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
        <Info size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>Личный кабинет на этом сервере выключен. Избранное и программа ДМС по-прежнему сохраняются в этом браузере.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="mk-auth rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60" data-testid="login-form">
        <AuthFlow
          headingLevel={3}
          title="Вход по email"
          description="Введите email, на который создан ваш аккаунт."
          features={features}
          support={support}
          onLogin={async (credentials) => {
            onBusy?.(true);
            try {
              return await account.login(credentials);
            } finally {
              onBusy?.(false);
            }
          }}
          onVerified={account.acceptLogin}
        />
      </section>

    </div>
  );
};

/* ---------- Вошедший пользователь ---------- */

const PlanCard = ({ plan, provider, today }) => {
  const expired = plan.validTo && today && plan.validTo < today;
  return (
    <div className={`rounded-xl border p-3 ${expired ? 'border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-900/20' : 'border-teal-200 bg-gradient-to-br from-teal-50 to-white dark:border-teal-800 dark:from-teal-900/30 dark:to-slate-800'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">{provider?.name || 'Страховая'}</div>
          <div className="text-[16px] font-bold text-slate-800 dark:text-white">«{plan.name}»</div>
          <div className="text-[12px] text-slate-500 dark:text-slate-400">Программа {INSURED_LABEL[plan.insured] || ''}</div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${expired ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200' : 'bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200'}`}>
          {expired ? <CalendarClock size={12} aria-hidden="true" /> : <CircleCheck size={12} aria-hidden="true" />}
          {expired ? 'Истекла' : 'Действует'}
        </span>
      </div>
      {plan.validTo && <div className="mt-2 text-[12px] text-slate-500 dark:text-slate-400">до {formatDate(plan.validTo)}</div>}
      {provider?.pultPhone && <div className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">Телефон: {provider.pultPhone}</div>}
    </div>
  );
};

const UserView = ({ account, insurance, today, planId, onSelectPlan, favorites, onFocusFavorite, onRemoveFavorite, onBusy }) => {
  const [choosing, setChoosing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const { user } = account;

  const plans = insurance?.plans || [];
  const providers = new Map((insurance?.providers || []).map((provider) => [provider.id, provider]));
  const plan = plans.find((item) => item.id === planId) || null;

  const run = async (key, action) => {
    setError('');
    setPending(key);
    onBusy?.(true);
    try {
      await action();
    } catch (failure) {
      setError(failure?.message || 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setPending(null);
      onBusy?.(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        icon={ShieldCheck}
        title="Мой ДМС"
        aside={plans.length > 0 && (
          <button type="button" onClick={() => setChoosing((current) => !current)} className="text-[12.5px] font-semibold text-blue-600 hover:underline dark:text-blue-400">
            {choosing ? 'Готово' : plan ? 'Сменить' : 'Выбрать'}
          </button>
        )}
      >
        {plans.length === 0 ? (
          <p className="text-[13px] leading-5 text-slate-500 dark:text-slate-400">Справочник программ ДМС появится, когда подключим страховые компании.</p>
        ) : choosing ? (
          <ul className="space-y-1.5" role="radiogroup" aria-label="Программа ДМС">
            {plans.map((item) => {
              const selected = item.id === planId;
              const expired = item.validTo && today && item.validTo < today;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={Boolean(pending)}
                    onClick={() => run(item.id, async () => {
                      await onSelectPlan(item.id);
                      setChoosing(false);
                    })}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[13px] transition ${selected ? 'border-teal-400 bg-teal-50 dark:border-teal-600 dark:bg-teal-900/30' : 'border-slate-200 hover:border-teal-300 dark:border-slate-700'}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-800 dark:text-white">«{item.name}»</span>
                      <span className="block text-[11.5px] text-slate-500 dark:text-slate-400">
                        {providers.get(item.providerId)?.name} · {INSURED_LABEL[item.insured] || ''}{expired ? ' · истекла' : ''}
                      </span>
                    </span>
                    {pending === item.id ? <Loader2 size={15} className="animate-spin text-teal-600" aria-hidden="true" /> : selected && <CircleCheck size={16} className="text-teal-600" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
            {planId && (
              <li>
                <button
                  type="button"
                  disabled={Boolean(pending)}
                  onClick={() => run('none', async () => {
                    await onSelectPlan(null);
                    setChoosing(false);
                  })}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-[12.5px] font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                >
                  <ShieldOff size={15} aria-hidden="true" />
                  У меня нет ДМС
                </button>
              </li>
            )}
          </ul>
        ) : plan ? (
          <PlanCard plan={plan} provider={providers.get(plan.providerId)} today={today} />
        ) : (
          <p className="text-[13px] leading-5 text-slate-500 dark:text-slate-400">Программа не выбрана. Выберите её — и карта отметит врачей, к которым можно по полису.</p>
        )}
      </Section>

      <Section
        icon={Heart}
        title="Избранные врачи"
        aside={<span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{favorites.length}</span>}
      >
        {favorites.length === 0 ? (
          <p className="text-[13px] leading-5 text-slate-500 dark:text-slate-400">Отмечайте врачей сердечком на карточке — они сохранятся здесь и будут видны на любом устройстве.</p>
        ) : (
          <ul className="-mx-1 max-h-72 space-y-1 overflow-y-auto pr-1">
            {favorites.map((item) => (
              <li key={String(item.id)} className="flex items-center gap-2 rounded-xl px-1 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/40">
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13.5px] font-semibold ${item.found ? 'text-slate-800 dark:text-white' : 'text-slate-400'}`}>{item.name}</div>
                  <div className="truncate text-[11.5px] text-slate-500 dark:text-slate-400">{item.subtitle}</div>
                </div>
                {item.found && (
                  <button type="button" onClick={() => onFocusFavorite(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-slate-700" aria-label={`Показать на карте: ${item.name}`}>
                    <MapPin size={16} aria-hidden="true" />
                  </button>
                )}
                <button type="button" onClick={() => onRemoveFavorite(item.id)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-slate-700" aria-label={`Убрать из избранного: ${item.name}`}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:bg-red-900/30 dark:text-red-200" role="alert">{error}</p>}

      <div className="rounded-2xl bg-slate-50 p-4 text-[12px] leading-5 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        <p className={`flex gap-2 ${user.role === 'user' ? 'mb-3' : ''}`}>
          <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>В аккаунте хранятся email, имя, роль, программа ДМС, избранное и история входов. Запросы к ассистенту и ваше местоположение не сохраняются.</span>
        </p>
        {user.role === 'user' && (
          <div className="flex flex-wrap gap-2">
            {confirmDelete ? (
              <button
                type="button"
                onClick={() => run('delete', () => account.removeAccount())}
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-red-700"
              >
                <Trash2 size={15} aria-hidden="true" />
                Точно удалить навсегда
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-xl px-3 py-2 text-[13px] font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">
                Удалить аккаунт
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default function AccountPanel({ account, insurance, today, planId, onSelectPlan, favorites, onFocusFavorite, onRemoveFavorite, onClose, isMobile, intro = null, support = null }) {
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const { user, status } = account;

  // Кабинет открывается из кнопки в левой панели: фон проявляется, окно поднимается (на телефоне — выезжает снизу).
  return (
    <MotionConfig reducedMotion="user">
    <Motion.div
      className={`fixed inset-0 z-[1200] flex bg-slate-900/40 backdrop-blur-[2px] ${isMobile ? 'items-end' : 'items-center justify-center p-4'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.2 }}
    >
      <Motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Личный кабинет"
        className={`flex w-full flex-col overflow-hidden bg-slate-50 shadow-2xl dark:bg-slate-900 ${isMobile ? 'max-h-[92vh] rounded-t-3xl' : 'max-h-[88vh] max-w-[440px] rounded-3xl'}`}
        initial={isMobile ? { y: '100%' } : { opacity: 0, y: 16, scale: 0.96 }}
        animate={isMobile ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
        exit={isMobile ? { y: '100%', transition: { duration: 0.22, ease: 'easeIn' } } : { opacity: 0, y: 10, scale: 0.97, transition: { duration: 0.15, ease: 'easeIn' } }}
        transition={isMobile ? { duration: 0.34, ease: [0.32, 0.72, 0, 1] } : { type: 'spring', stiffness: 420, damping: 34 }}
      >
        <header className="relative shrink-0 bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 px-5 pb-5 pt-4 text-white">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white"
            aria-label="Закрыть кабинет"
          >
            <X size={20} aria-hidden="true" />
          </button>
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">МедКарта</div>
          {user ? (
            <div className="mt-3 flex items-center gap-3">
              {user.avatarUrl ? (
                <PhotoAvatar name={user.displayName} src={user.avatarUrl} seed={user.id} size={48} className="ring-2 ring-white/30" />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20 text-[17px] font-bold ring-2 ring-white/30">{initialsOf(user.displayName)}</span>
              )}
              <div className="min-w-0">
                <h2 className="truncate text-[19px] font-extrabold leading-tight">{user.displayName}</h2>
                <div className="truncate text-[12.5px] text-white/75">{user.email}</div>
                <span className="mt-1 inline-block rounded-full bg-white/20 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide">{user.roleLabel}</span>
              </div>
            </div>
          ) : (
            <div className="mt-2 pr-8">
              <h2 className="text-[21px] font-extrabold leading-tight">Личный кабинет</h2>
              <p className="mt-1 text-[13px] leading-5 text-white/80">{intro || 'Программа ДМС и избранные врачи — с вами на любом устройстве.'}</p>
            </div>
          )}
          {user && (
            /* Всё, что раньше было в правом верхнем углу карты: профиль, админ-панель, выход. */
            <nav className="mt-4 flex flex-wrap gap-2" aria-label="Аккаунт">
              <Link to="/profile" className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white/15 px-3 text-[13px] font-semibold text-white ring-1 ring-inset ring-white/25 transition hover:bg-white/25" data-testid="account-profile-link">
                <UserRound size={15} aria-hidden="true" />
                Профиль
              </Link>
              {user.permissions?.includes('admin.access') && (
                <Link to="/admin" className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white px-3 text-[13px] font-semibold text-violet-700 shadow-sm transition hover:bg-violet-50" data-testid="account-admin-link">
                  <LayoutDashboard size={15} aria-hidden="true" />
                  Админ-панель
                </Link>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await account.logout();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-white/90 transition hover:bg-white/15 hover:text-white disabled:opacity-60"
                data-testid="account-logout"
              >
                {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}
                Выйти
              </button>
            </nav>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4" style={isMobile ? { paddingBottom: 'max(16px, env(safe-area-inset-bottom))' } : undefined}>
          {status === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-slate-500"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Загружаю…</div>
          ) : user ? (
            <UserView
              account={account}
              insurance={insurance}
              today={today}
              planId={planId}
              onSelectPlan={onSelectPlan}
              favorites={favorites}
              onFocusFavorite={onFocusFavorite}
              onRemoveFavorite={onRemoveFavorite}
              onBusy={setBusy}
            />
          ) : (
            <GuestView account={account} support={support} onBusy={setBusy} />
          )}
        </div>
      </Motion.div>
    </Motion.div>
    </MotionConfig>
  );
}
