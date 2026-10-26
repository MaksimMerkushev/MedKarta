/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Профиль → «Мои данные» (152-ФЗ, docs/privacy/06-subject-requests.md):
 *   - принятые документы и их редакции; новая редакция — принять здесь;
 *   - согласия (сейчас сайт их не собирает — показано, почему);
 *   - статистика использования: отказ в этом браузере;
 *   - выгрузка всех своих данных (со свежим подтверждением личности);
 *   - обращения по персональным данным со сроками ответа;
 *   - удаление аккаунта «Пользователь».
 * Только свои данные: сервер берёт пользователя из сессии.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileCheck2, FileText, Inbox, Send, Trash2 } from 'lucide-react';

import { PRIVACY_LIMITS, PRIVACY_REQUEST_TYPES } from '@shared/legal.js';
import { formatVersion, legalHref } from '../auth/legalFormat';
import { acceptDocuments, createPrivacyRequest, deleteAccount, exportMyData, fetchPrivacy, legalVersions } from '../services/account';
import { browserOptOut, isAnalyticsOptedOut, setAnalyticsOptOut } from '../services/analytics';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, SelectInput, Skeleton, Toggle, inputClass } from '../ui/kit';
import { formatDateTime } from '../ui/format';
import { useLoaded, useReauth, useToast } from '../ui/hooks';

const SLUGS = { terms: 'terms', privacy_policy: 'privacy', health_consent: 'health-consent' };
const ACTION_LABELS = { granted: 'принято', withdrawn: 'отозвано', closed: 'закрыто' };
const KIND_LABELS = { acceptance: 'Соглашение', acknowledgement: 'Политика', consent: 'Согласие' };
const STATUS_TONES = { received: 'blue', in_progress: 'amber', completed: 'green', rejected: 'red' };

const resolvePrivacy = async () => {
  try {
    return { status: 'ready', data: await fetchPrivacy(), error: null };
  } catch (error) {
    return { status: 'error', data: null, error };
  }
};

const download = (data) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `medkarta-my-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function PendingDocuments({ pending, onAccepted }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!pending.length) return null;
  const accept = async () => {
    setBusy(true);
    try {
      const documents = legalVersions(Object.fromEntries(pending.map((item) => [item.document, item])));
      await acceptDocuments(documents);
      toast('Новая редакция принята.');
      onAccepted();
    } catch (error) {
      toast(error.message, 'error');
      if (error?.code === 'documents_changed') onAccepted();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-[13.5px] leading-5 text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-testid="privacy-pending">
      <p className="font-semibold">Документы обновились</p>
      <ul className="mt-2 space-y-1">
        {pending.map((item) => (
          <li key={item.document}>
            <a href={legalHref(SLUGS[item.document], item.version)} target="_blank" rel="noopener" className="font-medium underline underline-offset-2">{item.title}</a>
            {' '}— редакция от {formatVersion(item.version)}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] text-blue-900/80 dark:text-blue-200/80">Если вы не согласны с новой редакцией соглашения, аккаунт можно удалить ниже.</p>
      <Button size="sm" variant="primary" className="mt-3" icon={FileCheck2} loading={busy} onClick={accept} data-testid="privacy-accept">Ознакомлен(а), принимаю</Button>
    </div>
  );
}

function RequestForm({ types, onCreated }) {
  const toast = useToast();
  const messageId = useId();
  const [type, setType] = useState('access');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { request } = await createPrivacyRequest({ type, message: message.trim() });
      setMessage('');
      toast(`Обращение принято. Ответ — не позже ${formatDateTime(request.dueAt)}.`);
      onCreated();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const hint = PRIVACY_REQUEST_TYPES[type]?.hint || '';
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="privacy-request-form">
      <SelectInput label="О чём обращение" value={type} onChange={(event) => setType(event.target.value)} options={types.map((item) => ({ value: item.key, label: item.label }))} hint={hint} data-testid="privacy-request-type" />
      <Field label="Подробности (необязательно)" htmlFor={messageId} hint="Не указывайте сведения о здоровье и номера документов — они не нужны для ответа.">
        <textarea
          id={messageId}
          className={`${inputClass} min-h-[84px]`}
          maxLength={PRIVACY_LIMITS.MESSAGE_MAX}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          data-testid="privacy-request-message"
        />
      </Field>
      <Button type="submit" variant="primary" size="sm" icon={Send} loading={busy} data-testid="privacy-request-submit">Отправить обращение</Button>
    </form>
  );
}

export default function PrivacySection({ user, onDeleted }) {
  const toast = useToast();
  const { withReauth } = useReauth();
  const sectionRef = useRef(null);
  const [state, , load] = useLoaded(resolvePrivacy, { status: 'loading', data: null, error: null });
  const [optedOut, setOptedOut] = useState(isAnalyticsOptedOut);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const browserSignal = browserOptOut();

  // Переход по ссылке /profile#privacy (из кабинета и письма) — к этому разделу.
  useEffect(() => {
    if (window.location.hash === '#privacy' && state.status === 'ready') sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [state.status]);

  const runExport = async () => {
    setExporting(true);
    try {
      download(await withReauth(() => exportMyData()));
      toast('Файл с вашими данными сохранён.');
    } catch (error) {
      if (error?.code !== 'reauth_cancelled') toast(error.message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const data = state.data;
  return (
    <div ref={sectionRef} id="privacy" className="scroll-mt-4">
      <Card
        title="Мои данные"
        description="Документы, которые вы приняли, обращения по персональным данным, выгрузка и удаление аккаунта."
      >
        {state.status === 'loading' && <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-24" /></div>}
        {state.status === 'error' && <ErrorState error={state.error} onRetry={load} />}
        {state.status === 'ready' && data && (
          <div className="space-y-6" data-testid="privacy-section">
            <PendingDocuments pending={data.pending || []} onAccepted={load} />

            <section aria-labelledby="privacy-documents">
              <h3 id="privacy-documents" className="text-[13px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Документы</h3>
              <p className="mt-1 text-[13px] leading-5 text-slate-600 dark:text-slate-300">
                <a href="/legal/privacy" target="_blank" rel="noopener" className="font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">Политика обработки персональных данных</a>
                {' · '}
                <a href="/legal/terms" target="_blank" rel="noopener" className="font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">Пользовательское соглашение</a>
              </p>
              {data.history.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-slate-500 dark:text-slate-400">
                  {user.role === 'user' ? 'Записей пока нет: аккаунт создан до появления журнала — примите действующую редакцию выше.' : 'Сотрудники работают по внутренним документам оператора.'}
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100 text-[13px] dark:divide-slate-800" data-testid="privacy-history">
                  {data.history.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={item.action === 'granted' ? 'green' : 'slate'}>{KIND_LABELS[item.kind] || item.kind}</Badge>
                        {item.version ? (
                          <a href={legalHref(SLUGS[item.document], item.version)} target="_blank" rel="noopener" className="text-slate-700 underline-offset-2 hover:underline dark:text-slate-200">
                            редакция от {formatVersion(item.version)}
                          </a>
                        ) : null}
                        <span className="text-slate-500 dark:text-slate-400">— {ACTION_LABELS[item.action] || item.action}</span>
                      </span>
                      <span className="tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(item.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="privacy-consents" className="space-y-3">
              <h3 id="privacy-consents" className="text-[13px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Согласия и настройки</h3>
              {data.consents.length === 0 && (
                <p className="text-[13px] leading-5 text-slate-600 dark:text-slate-300" data-testid="privacy-no-consents">
                  Сайт не запрашивает у вас согласий: данные аккаунта обрабатываются, чтобы аккаунт работал (исполнение соглашения). Сведения о здоровье с аккаунтом не связываются и не хранятся, рекламных рассылок нет.
                </p>
              )}
              <Toggle
                checked={!optedOut}
                disabled={browserSignal}
                onChange={(value) => setOptedOut(setAnalyticsOptOut(!value))}
                label="Обезличенная статистика использования"
                description={browserSignal
                  ? 'Ваш браузер передаёт сигнал «не отслеживать» — статистика не отправляется.'
                  : 'Какие функции открывают (без текста поиска, координат и данных о вас). Настройка действует в этом браузере.'}
              />
            </section>

            <section aria-labelledby="privacy-export" className="space-y-2">
              <h3 id="privacy-export" className="text-[13px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Выгрузка</h3>
              <p className="text-[13px] leading-5 text-slate-600 dark:text-slate-300">
                Все данные аккаунта одним файлом JSON: профиль, избранное, сессии и входы, демо-записи, принятые документы, обращения и сведения об обработке. Без хэша пароля и секретов входа.
              </p>
              <Button size="sm" icon={Download} loading={exporting} onClick={runExport} data-testid="privacy-export">Скачать мои данные</Button>
            </section>

            <section aria-labelledby="privacy-requests" className="space-y-3">
              <h3 id="privacy-requests" className="text-[13px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Обращения</h3>
              <p className="text-[13px] leading-5 text-slate-600 dark:text-slate-300">
                Запрос сведений, исправление, прекращение обработки или удаление. Срок ответа — 10 рабочих дней (может быть продлён на 5 с объяснением причины), исправление и удаление — 7 рабочих дней.
              </p>
              {data.requests.length === 0 ? (
                <EmptyState icon={Inbox} title="Обращений нет" />
              ) : (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-[13px] dark:divide-slate-800 dark:border-slate-800" data-testid="privacy-requests">
                  {data.requests.map((request) => (
                    <li key={request.id} className="space-y-1 px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">{request.typeLabel}</span>
                        <Badge tone={STATUS_TONES[request.status] || 'slate'}>{request.statusLabel}</Badge>
                      </div>
                      <p className="text-[12px] text-slate-500 dark:text-slate-400">
                        Отправлено {formatDateTime(request.createdAt)} · ответ не позже {formatDateTime(request.dueAt)}
                        {request.extendedAt ? ` (срок продлён: ${request.extensionReason})` : ''}
                      </p>
                      {request.response && <p className="whitespace-pre-line rounded-lg bg-slate-50 px-3 py-2 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">{request.response}</p>}
                    </li>
                  ))}
                </ul>
              )}
              <RequestForm types={data.requestTypes} onCreated={load} />
            </section>

            {data.canDeleteAccount && !user.isDemo && (
              <section aria-labelledby="privacy-delete" className="space-y-2 border-t border-slate-100 pt-5 dark:border-slate-800">
                <h3 id="privacy-delete" className="text-[13px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">Удаление аккаунта</h3>
                <p className="text-[13px] leading-5 text-slate-600 dark:text-slate-300">
                  Аккаунт, избранное, сессии, журнал входов и письма в очереди удаляются сразу; привязка демо-записей снимается. Остаются: запись о том, какие документы и когда вы принимали (3 года, без email и имени — чтобы подтвердить законность обработки), и записи о действиях сотрудников с аккаунтом (до истечения срока журнала). В резервных копиях данные хранятся до окончания их срока, а если базу восстанавливают из копии, удаление выполняют повторно.
                </p>
                <Button size="sm" variant="dangerGhost" icon={Trash2} onClick={() => setConfirmDelete(true)} data-testid="privacy-delete">Удалить аккаунт</Button>
              </section>
            )}
            <p className="flex items-start gap-2 text-[12px] leading-5 text-slate-500 dark:text-slate-400">
              <FileText size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              Сведения об обработке (цели, основания, сроки) — в Политике и в файле выгрузки.
            </p>
          </div>
        )}
      </Card>
      {confirmDelete && (
        <ConfirmDialog
          title="Удалить аккаунт навсегда?"
          message="Восстановить аккаунт будет нельзя. Избранное и программа ДМС останутся только в этом браузере."
          confirmLabel="Удалить навсегда"
          confirmText="удалить"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await withReauth(() => deleteAccount());
            onDeleted();
          }}
        />
      )}
    </div>
  );
}
