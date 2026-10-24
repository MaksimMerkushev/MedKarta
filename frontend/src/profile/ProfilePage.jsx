/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Страница /profile: свой профиль, аватар, пароль, активные сессии и
 * последние входы. Только свои данные — сервер берёт пользователя из сессии.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Clock3, LayoutDashboard, LogOut, Monitor, ShieldCheck, Trash2 } from 'lucide-react';

import {
  fetchMe, fetchMyLogins, fetchMySessions, logoutAccount, removeAvatar, revokeMySession, revokeOtherSessions, updateMe, uploadAvatar,
} from '../services/account';
import { ForcedPasswordChange, PasswordChangeForm } from '../ui/auth';
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, RoleBadge, Skeleton, Spinner, StatusBadge, TextInput, ThemeToggle, ToastProvider,
} from '../ui/kit';
import { formatDateTime, formatRelative } from '../ui/format';
import { useLoaded, useTheme, useToast } from '../ui/hooks';
import { Link } from '../ui/router';
import { navigate } from '../ui/navigation';

const AVATAR_SIDE = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Картинка → квадрат 256×256 WebP (или PNG). Перерисовка на canvas сама
 * отбрасывает EXIF с координатами съёмки; сервер всё равно проверяет и чистит.
 */
const prepareAvatar = (file) => new Promise((resolve, reject) => {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    reject(new Error('Подходят только PNG, JPEG и WebP.'));
    return;
  }
  if (file.size > MAX_SOURCE_BYTES) {
    reject(new Error('Файл больше 8 МБ.'));
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (side < 16) {
      URL.revokeObjectURL(url);
      reject(new Error('Картинка слишком маленькая.'));
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    URL.revokeObjectURL(url);
    let dataUrl = canvas.toDataURL('image/webp', 0.88);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
    resolve(dataUrl);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('Не удалось прочитать картинку.'));
  };
  image.src = url;
});

function ProfileHeader({ user, theme, onLogout }) {
  const staff = user?.permissions?.includes('admin.access');
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
        <Link to="/" className="inline-flex items-center gap-2 rounded-xl px-2 py-1.5 text-[13.5px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="hidden sm:inline">К карте</span>
          <span className="text-[17px] font-extrabold tracking-tight text-blue-600 dark:text-blue-400 sm:ml-1">МедКарта</span>
        </Link>
        <div className="flex items-center gap-1.5">
          {staff && (
            <Link to="/admin" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40">
              <LayoutDashboard size={16} aria-hidden="true" />
              <span className="hidden sm:inline">Админ-панель</span>
            </Link>
          )}
          <ThemeToggle theme={theme} />
          {user && <Button size="sm" icon={LogOut} onClick={onLogout} data-testid="profile-logout">Выйти</Button>}
        </div>
      </div>
    </header>
  );
}

function AvatarCard({ user, onChange }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await prepareAvatar(file);
      const result = await uploadAvatar(dataUrl);
      onChange(result.user);
      toast('Аватар обновлён.');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      onChange((await removeAvatar()).user);
      toast('Аватар удалён.');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card bodyClassName="p-5">
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <Avatar name={user.displayName} src={user.avatarUrl} seed={user.id} size={96} />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="absolute -bottom-1 -right-1 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-blue-600 text-white shadow hover:bg-blue-700 disabled:opacity-60 dark:border-slate-900"
            aria-label="Загрузить аватар"
            title="Загрузить аватар"
          >
            <Camera size={16} aria-hidden="true" />
          </button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick} data-testid="avatar-input" />
        </div>
        <h1 className="mt-3 text-[19px] font-extrabold text-slate-800 dark:text-white" data-testid="profile-name">{user.displayName}</h1>
        <p className="text-[13px] text-slate-500 dark:text-slate-400">{user.email}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          <RoleBadge role={user.role} />
          <StatusBadge status={user.status} />
          {user.isDemo && <Badge tone="amber">Демо</Badge>}
        </div>
        {user.avatarUrl && (
          <Button size="sm" variant="ghost" icon={Trash2} className="mt-3" onClick={remove} disabled={busy}>Убрать аватар</Button>
        )}
        <p className="mt-3 text-[11.5px] leading-4 text-slate-400">PNG, JPEG или WebP. Картинка обрезается до квадрата, метаданные (в том числе место съёмки) удаляются.</p>
      </div>
      <dl className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-[13px] dark:border-slate-800">
        {[
          ['Аккаунт создан', formatDateTime(user.createdAt)],
          ['Последний вход', formatDateTime(user.lastLoginAt)],
          ['Пароль изменён', formatDateTime(user.passwordChangedAt)],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="text-right font-medium text-slate-700 dark:text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function NameCard({ user, onChange }) {
  const toast = useToast();
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = firstName.trim() !== user.firstName || lastName.trim() !== user.lastName;
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await updateMe({ firstName: firstName.trim(), lastName: lastName.trim() });
      onChange(result.user);
      toast('Имя сохранено.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Личные данные" description={user.isDemo ? 'Имя демо-аккаунта не меняется.' : 'Видны только вам и администраторам МедКарты.'}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
        <TextInput label="Имя" value={firstName} maxLength={60} disabled={user.isDemo} autoComplete="given-name" onChange={(event) => setFirstName(event.target.value)} data-testid="profile-first-name" />
        <TextInput label="Фамилия" value={lastName} maxLength={60} disabled={user.isDemo} autoComplete="family-name" onChange={(event) => setLastName(event.target.value)} data-testid="profile-last-name" />
        <div className="sm:col-span-2">
          <TextInput label="Email" value={user.email} disabled hint="Email меняет администратор." />
        </div>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700 sm:col-span-2 dark:bg-red-950/50 dark:text-red-300" role="alert">{error}</p>}
        {!user.isDemo && (
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty || !firstName.trim()} data-testid="profile-save">Сохранить</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

const LIST_LOADING = { status: 'loading', items: [], error: null };
const listResolver = (fetcher) => async () => {
  try {
    return { status: 'ready', items: (await fetcher()).items, error: null };
  } catch (error) {
    return { status: 'error', items: [], error };
  }
};
const resolveSessions = listResolver(fetchMySessions);
const resolveLogins = listResolver(fetchMyLogins);

const resolveProfile = async () => {
  try {
    return { status: 'ready', user: (await fetchMe()).user, error: null };
  } catch (error) {
    if (error.status === 401) return { status: 'guest', user: null, error: null };
    return { status: 'error', user: null, error };
  }
};

function SessionsCard({ onSignedOut }) {
  const toast = useToast();
  const [state, , load] = useLoaded(resolveSessions, LIST_LOADING);
  const [confirm, setConfirm] = useState(false);
  const revoke = async (session) => {
    try {
      const result = await revokeMySession(session.id);
      if (result.current) {
        onSignedOut();
        return;
      }
      toast('Сессия завершена.');
      load();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  const others = state.items.filter((item) => !item.current).length;
  return (
    <Card
      title="Активные сессии"
      description="Где выполнен вход. Время — последней активности, а не «онлайн»."
      actions={others > 0 && <Button size="sm" variant="dangerGhost" icon={LogOut} onClick={() => setConfirm(true)} data-testid="revoke-others">Завершить другие ({others})</Button>}
      bodyClassName="p-0"
    >
      {state.status === 'loading' && <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={load} />}
      {state.status === 'ready' && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="my-sessions">
          {state.items.map((session) => (
            <li key={session.id} className="flex items-center gap-3 px-5 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"><Monitor size={17} aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">
                  {session.client}
                  {session.current && <Badge tone="green">Это устройство</Badge>}
                </p>
                <p className="text-[12px] text-slate-500 dark:text-slate-400">
                  Активность {formatRelative(session.lastSeenAt)} · вход {formatDateTime(session.createdAt)}{session.network ? ` · сеть ${session.network}` : ''}
                </p>
              </div>
              <Button size="sm" variant={session.current ? 'secondary' : 'dangerGhost'} onClick={() => revoke(session)}>{session.current ? 'Выйти' : 'Завершить'}</Button>
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title="Завершить другие сессии?"
          message={`На других устройствах (${others}) придётся войти заново. Эта сессия останется.`}
          confirmLabel="Завершить"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const result = await revokeOtherSessions();
            toast(`Завершено сессий: ${result.revoked}.`);
            load();
          }}
        />
      )}
    </Card>
  );
}

const EVENT_TONES = { login_ok: 'green', login_failed: 'red', login_denied: 'amber', password_changed: 'blue' };

function LoginsCard() {
  const [state, , load] = useLoaded(resolveLogins, LIST_LOADING);
  return (
    <Card title="Последние входы" description="Успешные и неудачные попытки, смены пароля. Хранятся ограниченное время." bodyClassName="p-0">
      {state.status === 'loading' && <Spinner />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={load} />}
      {state.status === 'ready' && state.items.length === 0 && <EmptyState icon={Clock3} title="Записей пока нет" />}
      {state.status === 'ready' && state.items.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {state.items.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
              <span className="flex items-center gap-2">
                <Badge tone={EVENT_TONES[event.type] || 'slate'}>{event.label}</Badge>
                <span className="text-slate-500 dark:text-slate-400">{event.client || ''}</span>
              </span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProfileContent() {
  const theme = useTheme();
  const toast = useToast();
  const [state, setState, load] = useLoaded(resolveProfile, { status: 'loading', user: null, error: null });

  useEffect(() => {
    document.title = 'Профиль — МедКарта';
  }, []);

  // Без сессии — на общую страницу входа; после входа она вернёт в профиль.
  useEffect(() => {
    if (state.status === 'guest') navigate('/login?next=%2Fprofile', { replace: true });
  }, [state.status]);

  const setUser = useCallback((user) => setState((current) => ({ ...current, user })), [setState]);
  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } catch {
      // Сессия истечёт сама; здесь выходим в любом случае.
    }
    setState({ status: 'guest', user: null, error: null });
  }, [setState]);

  const { status, user } = state;
  return (
    <div className="h-full overflow-y-auto bg-slate-50 dark:bg-slate-950" data-testid="profile-page">
      <ProfileHeader user={user} theme={theme} onLogout={logout} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {status === 'loading' && <Spinner label="Загружаю профиль…" />}
        {status === 'error' && <ErrorState error={state.error} onRetry={load} />}
        {status === 'guest' && <Spinner label="Открываю вход…" />}
        {status === 'ready' && user && (
          <>
            {user.mustChangePassword && <ForcedPasswordChange user={user} onDone={(fresh) => setUser(fresh)} onLogout={logout} />}
            <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="space-y-5">
                <AvatarCard user={user} onChange={setUser} />
              </div>
              <div className="space-y-5">
                <NameCard key={`${user.firstName}|${user.lastName}`} user={user} onChange={setUser} />
                {!user.isDemo && (
                  <Card title="Пароль" description="Смена пароля завершит все остальные сессии.">
                    <PasswordChangeForm email={user.email} onDone={(fresh) => {
                      setUser(fresh);
                      toast('Пароль изменён. Другие сессии завершены.');
                    }} />
                  </Card>
                )}
                <SessionsCard onSignedOut={() => {
                  setState({ status: 'guest', user: null, error: null });
                  navigate('/profile', { replace: true });
                }} />
                {!user.isDemo && <LoginsCard />}
                <p className="flex items-start gap-2 px-1 text-[12px] leading-5 text-slate-500 dark:text-slate-400">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  В аккаунте хранятся имя, email, роль, программа ДМС, избранное и история входов. Запросы к ассистенту и ваше местоположение не сохраняются.
                </p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <ToastProvider>
      <ProfileContent />
    </ToastProvider>
  );
}

