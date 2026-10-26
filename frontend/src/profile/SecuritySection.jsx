/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * «Безопасность аккаунта» в профиле (/profile#security): email и его
 * подтверждение, двухфакторная защита (ключи доступа, приложение-
 * аутентификатор, резервные коды), выход на всех устройствах.
 *
 * Важные действия сервер разрешает только после свежего подтверждения
 * личности (403 reauth_required) — окно подтверждения открывает
 * ReauthProvider, затем действие повторяется. Секрет приложения и резервные
 * коды показываются один раз и нигде в браузере не сохраняются.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, Download, Fingerprint, KeyRound, LifeBuoy, LogOut, Mail, Pencil, Plus, ShieldCheck, Smartphone, Trash2,
} from 'lucide-react';

import { encodeQr, qrSvgPath } from '@shared/qr.js';
import {
  confirmTotpSetup, fetchSecurity, finishPasskeySetup, regenerateRecoveryCodes, removeFactor, renameFactor, requestEmailChange,
  requestEmailVerification, revokeAllSessions, startPasskeySetup, startTotpSetup,
} from '../services/account';
import { createPasskey, passkeyErrorMessage, passkeysSupported } from '../auth/webauthn';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Modal, Skeleton, TextInput } from '../ui/kit';
import { formatDateTime } from '../ui/format';
import { useLoaded, useReauth, useToast } from '../ui/hooks';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@]+\.[^\s@]{2,}$/u;

const resolveSecurity = async () => {
  try {
    return { status: 'ready', data: await fetchSecurity(), error: null };
  } catch (error) {
    return { status: 'error', data: null, error };
  }
};

/** Ошибка, о которой не нужно сообщать: человек сам закрыл окно подтверждения. */
const cancelled = (error) => error?.code === 'reauth_cancelled';

/* -------------------------------- QR-код -------------------------------- */

function QrCode({ text, size = 184 }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  const view = qr.size + 8;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${view} ${view}`} role="img" aria-label="QR-код для приложения-аутентификатора" shapeRendering="crispEdges" className="rounded-xl border border-slate-200 bg-white dark:border-slate-700" data-testid="totp-qr">
      <rect width={view} height={view} fill="#fff" />
      <path d={qrSvgPath(qr)} fill="#0f172a" />
    </svg>
  );
}

/* --------------------------- резервные коды --------------------------- */

function RecoveryCodesModal({ codes, onClose }) {
  const toast = useToast();
  const text = `МедКарта — резервные коды входа\nКаждый код срабатывает один раз. Храните их в надёжном месте.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast('Коды скопированы.');
    } catch {
      toast('Не получилось скопировать — выделите коды вручную.', 'warning');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'medkarta-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Modal
      title="Резервные коды"
      description="Если телефон или ключ потеряется, войти можно будет одним из этих кодов. Сохраните их сейчас — больше они не покажутся."
      onClose={onClose}
      size="sm"
      footer={<Button variant="primary" onClick={onClose} data-testid="recovery-done">Я сохранил коды</Button>}
    >
      <ol className="grid grid-cols-2 gap-2 font-mono text-[14px] tabular-nums" data-testid="recovery-codes">
        {codes.map((code) => (
          <li key={code} className="rounded-lg bg-slate-100 px-3 py-2 text-center text-slate-800 dark:bg-slate-800 dark:text-slate-100">{code}</li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" icon={Copy} onClick={copy}>Скопировать</Button>
        <Button size="sm" icon={Download} onClick={download}>Скачать .txt</Button>
      </div>
      <p className="mt-3 text-[12.5px] leading-5 text-slate-500 dark:text-slate-400">Каждый код срабатывает один раз. Новые коды заменяют старые.</p>
    </Modal>
  );
}

/* ------------------------ приложение-аутентификатор ------------------------ */

function TotpSetupModal({ setup, onClose, onDone }) {
  const { withReauth } = useReauth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const grouped = setup.secret.replace(/(.{4})/gu, '$1 ').trim();
  const submit = async (event) => {
    event.preventDefault();
    const clean = code.replace(/\D/gu, '');
    if (clean.length !== 6) {
      setError('Введите 6 цифр из приложения.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      onDone(await withReauth(() => confirmTotpSetup({ factorId: setup.factorId, code: clean })));
    } catch (failure) {
      if (!cancelled(failure)) setError(failure.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Приложение-аутентификатор"
      description="Яндекс Ключ, Google Authenticator, 1Password, Bitwarden и другие приложения с одноразовыми кодами."
      onClose={onClose}
      busy={busy}
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4" data-testid="totp-setup">
        <ol className="space-y-1.5 text-[13.5px] leading-5 text-slate-600 dark:text-slate-300">
          <li>1. Откройте приложение и добавьте аккаунт по QR-коду.</li>
          <li>2. Введите 6 цифр, которые оно покажет.</li>
        </ol>
        <div className="flex justify-center"><QrCode text={setup.uri} /></div>
        <div className="text-center">
          {showSecret ? (
            <p className="select-all break-all font-mono text-[13px] tracking-wider text-slate-700 dark:text-slate-200" data-testid="totp-secret">{grouped}</p>
          ) : (
            <button type="button" className="text-[13px] font-semibold text-blue-700 hover:underline dark:text-blue-300" onClick={() => setShowSecret(true)}>Не получается отсканировать? Показать ключ</button>
          )}
        </div>
        <TextInput
          label="Код из приложения"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/[^\d ]/gu, ''));
            if (error) setError('');
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          error={error}
          data-testid="totp-confirm-code"
        />
        <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy} className="w-full" data-testid="totp-confirm">Включить</Button>
        <p className="text-[12px] leading-5 text-slate-500 dark:text-slate-400">Ключ действует 10 минут — потом настройку нужно начать заново. Никому его не показывайте.</p>
      </form>
    </Modal>
  );
}

/* ---------------------------------- факторы ---------------------------------- */

function FactorRow({ factor, canRemove, onRename, onRemove, staff = false }) {
  const Icon = factor.type === 'webauthn' ? Fingerprint : Smartphone;
  // Сотруднику ключ обязан проверять человека: ключ, добавленный до этого правила, — до первого входа с PIN или биометрией.
  const unverified = staff && factor.type === 'webauthn' && factor.userVerified !== true;
  return (
    <li className="flex items-center gap-3 px-5 py-3" data-testid="mfa-factor" data-type={factor.type}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"><Icon size={17} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{factor.label || factor.typeLabel}</p>
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          {factor.label && factor.label !== factor.typeLabel ? `${factor.typeLabel} · ` : ''}добавлен {formatDateTime(factor.createdAt)}{factor.lastUsedAt ? ` · использован ${formatDateTime(factor.lastUsedAt)}` : ''}
          {factor.synced ? ' · синхронизируется между устройствами' : ''}
        </p>
        {unverified && (
          <p className="mt-0.5 text-[12px] leading-[18px] text-amber-700 dark:text-amber-400" data-testid="mfa-factor-unverified">
            Ключ ещё не проверял вас PIN-кодом или биометрией. Войдите с ним, подтвердив отпечатком, лицом или PIN, — или замените на новый.
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" icon={Pencil} onClick={() => onRename(factor)} aria-label={`Переименовать «${factor.label || factor.typeLabel}»`}><span className="hidden sm:inline">Имя</span></Button>
      <Button size="sm" variant="dangerGhost" icon={Trash2} onClick={() => onRemove(factor)} disabled={!canRemove} title={canRemove ? undefined : 'Для сотрудника двухфакторная защита обязательна: сначала добавьте другой способ'} data-testid="mfa-factor-remove">
        <span className="hidden sm:inline">Удалить</span>
      </Button>
    </li>
  );
}

function RenameModal({ factor, onClose, onSaved }) {
  const [label, setLabel] = useState(factor.label || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await renameFactor(factor.id, label.trim());
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Название способа входа" onClose={onClose} busy={busy} size="sm" footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" loading={busy} onClick={save}>Сохранить</Button></>}>
      <form onSubmit={save}>
        <TextInput label="Название" hint="Например, «iPhone» или «Ключ на брелоке»." value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} error={error} />
      </form>
    </Modal>
  );
}

function TwoFactorCard({ data, reload, onFactorAdded = null }) {
  const toast = useToast();
  const { withReauth } = useReauth();
  const [totp, setTotp] = useState(null);
  const [codes, setCodes] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState('');
  const browserPasskeys = passkeysSupported();
  const staff = data.mfaRequired;
  const canRemoveAny = !staff || data.factors.length > 1;

  // Сначала человек сохраняет резервные коды (если их выдали), потом — onFactorAdded.
  const pendingAdded = useRef(false);
  const afterAdded = (result, message) => {
    // Если выданы резервные коды, окно с ними само сообщает об успехе — уведомление его не заслоняет.
    if (!result.recoveryCodes?.length) toast(message);
    if (result.recoveryCodes?.length) {
      pendingAdded.current = true;
      setCodes(result.recoveryCodes);
    } else {
      onFactorAdded?.();
    }
    reload();
  };
  const closeCodes = () => {
    setCodes(null);
    if (pendingAdded.current) {
      pendingAdded.current = false;
      onFactorAdded?.();
    }
  };

  const addPasskey = async () => {
    setBusy('passkey');
    try {
      const { publicKey } = await withReauth(() => startPasskeySetup());
      let credential;
      try {
        credential = await createPasskey(publicKey);
      } catch (failure) {
        toast(passkeyErrorMessage(failure), 'error');
        return;
      }
      const label = /iPhone|iPad|Mac/u.test(navigator.userAgent) ? 'Ключ Apple' : /Android/u.test(navigator.userAgent) ? 'Ключ Android' : /Windows/u.test(navigator.userAgent) ? 'Windows Hello' : 'Ключ доступа';
      afterAdded(await withReauth(() => finishPasskeySetup({ credential, label })), 'Ключ доступа добавлен.');
    } catch (failure) {
      if (!cancelled(failure)) toast(failure.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const addTotp = async () => {
    setBusy('totp');
    try {
      setTotp(await withReauth(() => startTotpSetup()));
    } catch (failure) {
      if (!cancelled(failure)) toast(failure.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const newCodes = async () => {
    setBusy('codes');
    try {
      const result = await withReauth(() => regenerateRecoveryCodes());
      setCodes(result.recoveryCodes);
      reload();
    } catch (failure) {
      if (!cancelled(failure)) toast(failure.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <Card
      title="Двухфакторная защита"
      description="Кроме пароля — ключ доступа или код из приложения. Украденного пароля станет недостаточно для входа."
      bodyClassName="p-0"
    >
      <div className="px-5 pb-1 pt-4">
        {data.enabled ? (
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-emerald-700 dark:text-emerald-400" data-testid="mfa-status" data-enabled="true">
            <CheckCircle2 size={17} aria-hidden="true" />Включена
          </p>
        ) : (
          <p className={`flex items-start gap-2 text-[13.5px] font-semibold ${staff ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`} data-testid="mfa-status" data-enabled="false">
            <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            {staff ? 'Не настроена. Для сотрудников она обязательна: без неё админ-панель не откроется.' : 'Не включена. Рекомендуем добавить ключ доступа — это самый надёжный способ.'}
          </p>
        )}
      </div>
      {data.factors.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 border-y border-slate-100 dark:divide-slate-800 dark:border-slate-800" data-testid="mfa-factors">
          {data.factors.map((factor) => (
            <FactorRow key={factor.id} factor={factor} staff={staff} canRemove={canRemoveAny} onRename={setRenaming} onRemove={setRemoving} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 px-5 py-4">
        {data.passkeysAvailable && browserPasskeys && (
          <Button variant={data.enabled ? 'secondary' : 'primary'} icon={Fingerprint} loading={busy === 'passkey'} disabled={Boolean(busy)} onClick={addPasskey} data-testid="mfa-add-passkey">Добавить ключ доступа</Button>
        )}
        <Button icon={Smartphone} loading={busy === 'totp'} disabled={Boolean(busy)} onClick={addTotp} data-testid="mfa-add-totp">{data.factors.some((factor) => factor.type === 'totp') ? 'Ещё одно приложение' : 'Приложение-аутентификатор'}</Button>
      </div>
      {data.passkeysAvailable && !browserPasskeys && (
        <p className="px-5 pb-3 text-[12.5px] text-slate-500 dark:text-slate-400">Этот браузер не поддерживает ключи доступа — используйте приложение-аутентификатор.</p>
      )}
      {data.enabled && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
          <p className="flex items-center gap-2 text-[13px] text-slate-600 dark:text-slate-300" data-testid="recovery-left">
            <LifeBuoy size={16} aria-hidden="true" />
            Резервных кодов осталось: <span className={`font-semibold ${data.recoveryCodes.unused <= 2 ? 'text-amber-700 dark:text-amber-400' : ''}`}>{data.recoveryCodes.unused}</span> из {data.recoveryCodes.total}
          </p>
          <Button size="sm" icon={KeyRound} loading={busy === 'codes'} disabled={Boolean(busy)} onClick={newCodes} data-testid="recovery-regenerate">Новые коды</Button>
        </div>
      )}

      {totp && (
        <TotpSetupModal
          setup={totp}
          onClose={() => setTotp(null)}
          onDone={(result) => {
            setTotp(null);
            afterAdded(result, 'Приложение-аутентификатор подключено.');
          }}
        />
      )}
      {codes && <RecoveryCodesModal codes={codes} onClose={closeCodes} />}
      {renaming && <RenameModal factor={renaming} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); reload(); }} />}
      {removing && (
        <ConfirmDialog
          title="Удалить способ входа?"
          message={`«${removing.label || removing.typeLabel}» больше нельзя будет использовать для входа.${data.factors.length === 1 ? ' Двухфакторная защита выключится, резервные коды перестанут действовать.' : ''}`}
          confirmLabel="Удалить"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await withReauth(() => removeFactor(removing.id));
              toast('Способ входа удалён.');
              reload();
            } catch (failure) {
              if (cancelled(failure)) return;
              throw failure;
            }
          }}
        />
      )}
    </Card>
  );
}

/* ---------------------------------- email ---------------------------------- */

function EmailCard({ data, reload }) {
  const toast = useToast();
  const { withReauth } = useReauth();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const address = value.trim();
    if (!EMAIL.test(address)) {
      setError('Проверьте email: нужен адрес вида name@example.ru.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await withReauth(() => requestEmailChange(address));
      setSent(result.message);
      setEditing(false);
      setValue('');
    } catch (failure) {
      if (!cancelled(failure)) setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const result = await requestEmailVerification();
      setSent(result.message);
      reload();
    } catch (failure) {
      toast(failure.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Email" description="На него приходят ссылки для восстановления доступа и уведомления о входе.">
      <div className="flex flex-wrap items-center gap-2">
        <Mail size={17} className="text-slate-400" aria-hidden="true" />
        <span className="text-[14px] font-semibold text-slate-800 dark:text-slate-100" data-testid="security-email">{data.email}</span>
        {data.emailVerified
          ? <Badge tone="green" icon={CheckCircle2}>Подтверждён</Badge>
          : <Badge tone="amber" icon={AlertTriangle}>Не подтверждён</Badge>}
      </div>
      {sent && <p className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-[13px] text-blue-800 dark:bg-blue-950/40 dark:text-blue-200" role="status" data-testid="email-sent">{sent}</p>}
      {data.emailChange ? (
        <>
          {!data.emailVerified && (
            <Button size="sm" className="mt-3" icon={Mail} loading={busy && !editing} onClick={verify} data-testid="email-verify">Прислать письмо для подтверждения</Button>
          )}
          {editing ? (
            <form onSubmit={submit} className="mt-4 space-y-3" data-testid="email-change-form">
              <TextInput label="Новый email" type="email" autoComplete="email" value={value} maxLength={254} onChange={(event) => { setValue(event.target.value); setError(''); }} error={error} data-testid="email-new" />
              <p className="text-[12.5px] leading-5 text-slate-500 dark:text-slate-400">Мы отправим ссылку на новый адрес. Email сменится, когда вы откроете её; на прежний адрес придёт уведомление.</p>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={busy} data-testid="email-change-submit">Отправить ссылку</Button>
                <Button onClick={() => { setEditing(false); setError(''); }} disabled={busy}>Отмена</Button>
              </div>
            </form>
          ) : (
            <Button size="sm" variant="ghost" className="mt-3" icon={Pencil} onClick={() => { setEditing(true); setSent(''); }} data-testid="email-change">Сменить email</Button>
          )}
        </>
      ) : (
        <p className="mt-3 text-[12.5px] text-slate-500 dark:text-slate-400">Почта на сервере не настроена — сменить email может администратор.</p>
      )}
    </Card>
  );
}

/* ------------------------------- все сессии ------------------------------- */

function SignOutEverywhere({ onSignedOut }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Card title="Выйти на всех устройствах" description="Если вы подозреваете, что кто-то знает пароль: завершатся все сессии, включая эту. Затем смените пароль.">
      <Button variant="dangerGhost" icon={LogOut} onClick={() => setConfirm(true)} data-testid="revoke-all">Выйти везде</Button>
      {confirm && (
        <ConfirmDialog
          title="Выйти на всех устройствах?"
          message="Все сессии, включая эту, завершатся. Войти можно будет снова по email и паролю."
          confirmLabel="Выйти везде"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await revokeAllSessions();
            onSignedOut();
          }}
        />
      )}
    </Card>
  );
}

export default function SecuritySection({ onSignedOut }) {
  const [state, , reload] = useLoaded(resolveSecurity, { status: 'loading', data: null, error: null });
  const ref = useRef(null);

  // /profile#security — прокрутить к разделу (из письма о входе, из админ-панели).
  useEffect(() => {
    if (state.status === 'ready' && window.location.hash === '#security') ref.current?.scrollIntoView({ block: 'start' });
  }, [state.status]);

  return (
    <section ref={ref} id="security" aria-labelledby="security-title" className="scroll-mt-20 space-y-5" data-testid="security-section">
      <h2 id="security-title" className="flex items-center gap-2 px-1 text-[17px] font-extrabold text-slate-800 dark:text-white">
        <ShieldCheck size={19} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />Безопасность аккаунта
      </h2>
      {state.status === 'loading' && <Card><div className="space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-10" /></div></Card>}
      {state.status === 'error' && <Card><ErrorState error={state.error} onRetry={reload} /></Card>}
      {state.status === 'ready' && (
        <>
          <EmailCard data={state.data} reload={reload} />
          <TwoFactorCard data={state.data} reload={reload} />
          <SignOutEverywhere onSignedOut={onSignedOut} />
        </>
      )}
      {state.status === 'ready' && !state.data.enabled && !state.data.mfaRequired && (
        <p className="flex items-start gap-2 px-1 text-[12px] leading-5 text-slate-500 dark:text-slate-400">
          <Plus size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          Ключ доступа — это вход отпечатком, лицом или PIN-кодом устройства. Его нельзя подсмотреть или ввести на поддельном сайте.
        </p>
      )}
    </section>
  );
}

/**
 * Обязательная настройка двухфакторной защиты для сотрудника (экран
 * админ-панели): те же способы, что в профиле. onEnabled — когда первый
 * способ добавлен и резервные коды сохранены (сессия уже повышена сервером).
 */
export function MfaSetupPanel({ onEnabled }) {
  const [state, , reload] = useLoaded(resolveSecurity, { status: 'loading', data: null, error: null });
  if (state.status === 'loading') return <div className="space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-10" /></div>;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;
  return <TwoFactorCard data={state.data} reload={reload} onFactorAdded={onEnabled} />;
}
