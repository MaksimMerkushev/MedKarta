/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Оболочка админ-панели (/admin): проверка прав (без сессии — на /login),
 * обязательная двухфакторная защита сотрудников (нет способа — настройка,
 * сессия без второго фактора — подтверждение), боковое меню, маршруты разделов. Что показывать, решает ответ /api/admin/me; доступ к
 * данным всё равно проверяет сервер на каждом запросе.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, FileClock, Gauge, Inbox, KeyRound, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Settings, ShieldCheck, UserRound, Users, X,
} from 'lucide-react';

import { logoutAccount } from '../services/account';
import { MfaSetupPanel } from '../profile/SecuritySection';
import { ForcedPasswordChange } from '../ui/auth';
import { Avatar, Button, EmptyState, ErrorState, IconButton, RoleBadge, Spinner, ThemeToggle, ToastProvider } from '../ui/kit';
import { useLoaded, useReauth, useTheme, useToast } from '../ui/hooks';
import { ReauthProvider } from '../ui/reauth';
import { Link } from '../ui/router';
import { navigate, useLocation } from '../ui/navigation';
import { api, AUTH_EVENT, setReauthHandler } from './api';
import { AdminContext } from './model';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const UsersPage = lazy(() => import('./pages/Users'));
const UserDetail = lazy(() => import('./pages/UserDetail'));
const RolesPage = lazy(() => import('./pages/Roles'));
const SessionsPage = lazy(() => import('./pages/Sessions'));
const AuditPage = lazy(() => import('./pages/Audit'));
const SystemPage = lazy(() => import('./pages/System'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const PrivacyRequestsPage = lazy(() => import('./pages/PrivacyRequests'));

const NAV = [
  { path: '/admin', label: 'Дашборд', icon: Gauge, permission: 'dashboard.view', page: Dashboard },
  { path: '/admin/users', label: 'Пользователи', icon: Users, permission: 'users.view', page: UsersPage },
  { path: '/admin/roles', label: 'Роли и права', icon: ShieldCheck, permission: ['roles.manage', 'roles.assign'], page: RolesPage },
  { path: '/admin/sessions', label: 'Сессии', icon: MonitorSmartphone, permission: 'users.sessions', page: SessionsPage },
  { path: '/admin/audit', label: 'Журнал действий', icon: FileClock, permission: 'audit.view', page: AuditPage },
  { path: '/admin/privacy', label: 'Обращения по ПДн', icon: Inbox, permission: 'privacy.requests', page: PrivacyRequestsPage },
  { path: '/admin/system', label: 'Система', icon: Activity, permission: 'system.view', page: SystemPage },
  { path: '/admin/settings', label: 'Настройки', icon: Settings, permission: 'settings.view', page: SettingsPage },
];

const allowed = (me, permission) => {
  const list = Array.isArray(permission) ? permission : [permission];
  return list.some((item) => me?.permissions?.includes(item));
};

function Shell({ me, onLogout, children, title }) {
  const theme = useTheme();
  const { path } = useLocation();
  // Меню на телефоне открыто для конкретной страницы: переход закрывает его сам.
  const [openOn, setOpenOn] = useState(null);
  const open = openOn === path;
  const setOpen = (value) => setOpenOn(value ? path : null);
  const items = NAV.filter((item) => allowed(me, item.permission));

  const isActive = (item) => (item.path === '/admin' ? path === '/admin' : path === item.path || path.startsWith(`${item.path}/`));

  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Разделы админ-панели">
      <div className="flex items-center gap-2 px-5 pb-4 pt-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm" aria-hidden="true">
          <LayoutDashboard size={18} />
        </span>
        <span>
          <span className="block text-[16px] font-extrabold leading-none tracking-tight text-blue-600 dark:text-blue-400">МедКарта</span>
          <span className="mt-1 block text-[11.5px] font-semibold uppercase tracking-wider text-slate-400">Админ-панель</span>
        </span>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item);
          return (
            <li key={item.path}>
              <Link
                to={item.path}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue-300 ${active ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              >
                <Icon size={18} aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
          <Avatar name={me.user.displayName} src={me.user.avatarUrl} seed={me.user.id} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-bold text-slate-800 dark:text-white" data-testid="admin-user-name">{me.user.displayName}</p>
            <RoleBadge role={me.user.role} short />
          </div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-1">
          <Link to="/profile" className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"><UserRound size={16} aria-hidden="true" />Профиль</Link>
          <a href="/" className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"><ArrowLeft size={16} aria-hidden="true" />Карта</a>
          <button type="button" onClick={onLogout} className="flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:text-slate-400 dark:hover:bg-slate-800" data-testid="admin-logout"><LogOut size={16} aria-hidden="true" />Выйти</button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 dark:bg-slate-950" data-testid="admin-app">
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-[1250] lg:hidden">
          <button type="button" className="absolute inset-0 bg-slate-950/50" aria-label="Закрыть меню" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-2xl dark:bg-slate-900">
            <IconButton icon={X} label="Закрыть меню" className="absolute right-2 top-3" onClick={() => setOpen(false)} />
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:px-5 dark:border-slate-800 dark:bg-slate-900/90">
          <IconButton icon={Menu} label="Меню" className="lg:hidden" onClick={() => setOpen(true)} />
          <h1 className="min-w-0 flex-1 truncate text-[16px] font-bold text-slate-800 dark:text-white" data-testid="admin-title">{title}</h1>
          <ThemeToggle theme={theme} />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-3 py-5 sm:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function CenteredCard({ children, wide = false }) {
  const theme = useTheme();
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950">
      <div className="absolute right-4 top-4"><ThemeToggle theme={theme} /></div>
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-sm'} rounded-3xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900`}>{children}</div>
    </div>
  );
}

/** Кто открыл панель: сотрудник, гость, пользователь без прав или нужна смена пароля. */
const resolveAccess = async () => {
  try {
    return { status: 'ready', me: await api.get('/api/admin/me'), error: null };
  } catch (error) {
    if (error.status === 401) return { status: 'login', me: null, error: null };
    if (error.code === 'password_change_required') return { status: 'password', me: null, error: null };
    if (error.code === 'mfa_setup_required') return { status: 'mfa_setup', me: null, error: null };
    if (error.code === 'mfa_required') return { status: 'mfa_verify', me: null, error: null };
    if (error.status === 403) return { status: 'forbidden', me: null, error: null };
    return { status: 'error', me: null, error };
  }
};

const NOTICE_POLL_MS = 30_000;

/**
 * Уведомления об активации: раз в 30 секунд (пока вкладка видна) — кто
 * задал пароль по приглашению. Первый запрос только запоминает время:
 * о том, что было до открытия панели, не сообщаем.
 */
function useActivationNotices(enabled) {
  const toast = useToast();
  const since = useRef(null);
  const seen = useRef(new Set());
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const result = await api.get('/api/admin/notifications', since.current ? { since: since.current } : undefined);
          if (since.current) {
            for (const item of [...result.items].reverse()) {
              if (seen.current.has(item.id)) continue;
              seen.current.add(item.id);
              toast(`Аккаунт активирован: ${item.user || 'пользователь'} задал(а) пароль.`, 'success');
            }
          } else {
            result.items.forEach((item) => seen.current.add(item.id));
          }
          since.current = result.now;
        } catch {
          // Нет связи или сессия кончилась (об этом сообщит оболочка) — попробуем позже.
        }
      }
      if (!stopped) timer = setTimeout(poll, NOTICE_POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, toast]);
}

/** Обязательная защита: нет второго фактора — настройка прямо здесь. */
function MfaSetupScreen({ onDone, onLogout }) {
  return (
    <CenteredCard wide>
      <div data-testid="admin-mfa-setup">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" aria-hidden="true"><ShieldCheck size={22} /></span>
        <h1 className="mt-3 text-[19px] font-extrabold text-slate-800 dark:text-white">Включите двухфакторную защиту</h1>
        <p className="mb-4 mt-1 text-[13.5px] leading-5 text-slate-600 dark:text-slate-300">
          Для сотрудников она обязательна: в админ-панели — данные пользователей. Добавьте ключ доступа (отпечаток, лицо, PIN устройства) или приложение-аутентификатор и сохраните резервные коды.
        </p>
        <MfaSetupPanel onEnabled={onDone} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={onDone} data-testid="admin-mfa-check">Я настроил — продолжить</Button>
          <Button variant="ghost" icon={LogOut} onClick={onLogout}>Выйти</Button>
        </div>
      </div>
    </CenteredCard>
  );
}

/** Сессия без второго фактора (вход по ссылке или фактор добавлен на другом устройстве): подтвердить. */
function MfaVerifyScreen({ onDone, onLogout }) {
  const { confirm } = useReauth();
  const [error, setError] = useState('');
  const verify = async () => {
    setError('');
    if (await confirm()) onDone();
    else setError('Без подтверждения вторым фактором админ-панель не откроется.');
  };
  return (
    <CenteredCard>
      <div data-testid="admin-mfa-verify">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300" aria-hidden="true"><ShieldCheck size={22} /></span>
        <h1 className="mt-3 text-[19px] font-extrabold text-slate-800 dark:text-white">Подтвердите вход</h1>
        <p className="mt-1 text-[13.5px] leading-5 text-slate-600 dark:text-slate-300">Для админ-панели нужна сессия, подтверждённая вторым фактором: пароль и ключ доступа или код из приложения.</p>
        {error && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" icon={ShieldCheck} onClick={verify} data-testid="admin-mfa-verify-start">Подтвердить</Button>
          <Button variant="ghost" icon={LogOut} onClick={onLogout}>Выйти</Button>
        </div>
      </div>
    </CenteredCard>
  );
}

function AdminRoot() {
  const { path, search } = useLocation();
  const [state, setState, load] = useLoaded(resolveAccess, { status: 'loading', me: null, error: null });
  const { confirm } = useReauth();

  // Критичные действия без свежего подтверждения личности: окно подтверждения — и повтор запроса.
  useEffect(() => {
    setReauthHandler(confirm);
    return () => setReauthHandler(null);
  }, [confirm]);

  // Сессия кончилась или отозвана посреди работы — сразу на экран входа.
  useEffect(() => {
    const onAuth = (event) => {
      const status = { password_change_required: 'password', mfa_setup_required: 'mfa_setup', mfa_required: 'mfa_verify' }[event.detail?.code] || 'login';
      setState((current) => ({ ...current, status }));
    };
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, [setState]);

  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } catch {
      // Сессия истечёт сама.
    }
    setState({ status: 'login', me: null, error: null });
  }, [setState]);

  const route = useMemo(() => {
    const userMatch = path.match(/^\/admin\/users\/([a-f0-9]{32})$/);
    if (userMatch) return { item: NAV[1], page: UserDetail, params: { id: userMatch[1] }, title: 'Карточка пользователя' };
    const item = NAV.find((entry) => entry.path === path);
    return item ? { item, page: item.page, params: {}, title: item.label } : null;
  }, [path]);

  const me = state.me;
  const can = useCallback((permission) => allowed(me, permission), [me]);
  useActivationNotices(state.status === 'ready' && can('users.view'));

  useEffect(() => {
    document.title = `${route?.title || 'Админ-панель'} — МедКарта`;
  }, [route]);

  // Нет сессии — на общую страницу входа; после входа она вернёт сюда же.
  useEffect(() => {
    if (state.status === 'login') navigate(`/login?next=${encodeURIComponent(`${path}${search}`)}`, { replace: true });
  }, [state.status, path, search]);

  // Модератору без дашборда — сразу список пользователей.
  useEffect(() => {
    if (state.status === 'ready' && path === '/admin' && !can('dashboard.view')) {
      const first = NAV.find((item) => allowed(me, item.permission));
      if (first) navigate(first.path, { replace: true });
    }
  }, [state.status, path, can, me]);

  if (state.status === 'loading') return <div className="h-full bg-slate-50 dark:bg-slate-950"><Spinner label="Проверяю доступ…" /></div>;
  if (state.status === 'error') return <CenteredCard><ErrorState error={state.error} onRetry={load} /></CenteredCard>;
  if (state.status === 'login') return <div className="h-full bg-white dark:bg-slate-950" data-testid="admin-login-redirect" />;
  if (state.status === 'password') {
    return <div className="h-full bg-slate-50 dark:bg-slate-950"><ForcedPasswordChange onDone={load} onLogout={logout} /></div>;
  }
  if (state.status === 'mfa_setup') return <MfaSetupScreen onDone={load} onLogout={logout} />;
  if (state.status === 'mfa_verify') return <MfaVerifyScreen onDone={load} onLogout={logout} />;
  if (state.status === 'forbidden') {
    return (
      <CenteredCard>
        <EmptyState
          icon={KeyRound}
          title="Нет доступа к админ-панели"
          description="Ваш аккаунт не входит в число сотрудников. Если это ошибка — обратитесь к администратору."
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              <a href="/" className="inline-flex h-10 items-center rounded-xl border border-slate-200 px-3.5 text-[13.5px] font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">На карту</a>
              <Button onClick={logout} icon={LogOut}>Выйти</Button>
            </div>
          )}
        />
      </CenteredCard>
    );
  }

  const Page = route?.page;
  const permitted = route && allowed(me, route.item.permission);
  return (
    <AdminContext.Provider value={{ me, can, reloadMe: load }}>
      <Shell me={me} onLogout={logout} title={route?.title || 'Страница не найдена'}>
        <Suspense fallback={<Spinner />}>
          {!route && <EmptyState title="Страница не найдена" description="Проверьте адрес или выберите раздел в меню." action={<Link to="/admin" className="font-semibold text-blue-600 hover:underline">К началу</Link>} />}
          {route && !permitted && <EmptyState icon={KeyRound} title="Недостаточно прав" description="Для этого раздела у вашей роли нет разрешения. Его выдаёт суперадминистратор." />}
          {route && permitted && <Page params={route.params} />}
        </Suspense>
      </Shell>
    </AdminContext.Provider>
  );
}

export default function AdminApp() {
  return (
    <ToastProvider>
      <ReauthProvider>
        <AdminRoot />
      </ReauthProvider>
    </ToastProvider>
  );
}
