/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Документы на форме создания аккаунта и первой установки пароля.
 *
 * Два отдельных элемента (152-ФЗ, docs/privacy/02-legal-bases.md):
 *   1. Отметка «Принимаю Пользовательское соглашение» — по умолчанию снята,
 *      без неё кнопка не отправляет форму (и сервер аккаунт не создаёт).
 *   2. Политика обработки персональных данных — ссылка и пояснение, а не
 *      «согласие»: данные аккаунта обрабатываются для исполнения соглашения,
 *      отдельного согласия на это не нужно и оно не собирается.
 * Рекламных рассылок и согласия на сведения о здоровье здесь нет.
 *
 * Ссылки открывают текст той редакции, что будет принята (версия в адресе).
 */
import { useId } from 'react';
import { FileText } from 'lucide-react';

import { formatVersion, legalHref } from './legalFormat';

const DocLink = ({ slug, version, children, testId }) => (
  <a
    href={legalHref(slug, version)}
    target="_blank"
    rel="noopener"
    className="font-medium text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
    data-testid={testId}
  >
    {children}
  </a>
);

/**
 * @param {object} props
 * @param {{terms: {version: string, draft?: boolean}, privacy_policy: {version: string, draft?: boolean}}} props.documents редакции с сервера
 * @param {boolean} props.checked
 * @param {(value: boolean) => void} props.onChange
 * @param {string} [props.error] текст ошибки под отметкой
 * @param {string} [props.action] название кнопки — для пояснения о политике
 */
export default function LegalAcceptance({ documents, checked, onChange, error = '', action = 'Создать аккаунт' }) {
  const checkboxId = useId();
  const errorId = useId();
  const terms = documents?.terms;
  const policy = documents?.privacy_policy;
  const draft = Boolean(terms?.draft || policy?.draft);
  if (!terms) return null;
  return (
    <div className="space-y-3" data-testid="legal-acceptance">
      {draft && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200" data-testid="legal-draft-note">
          Документы — проект: сведения об операторе ещё не заполнены. Тестовый стенд.
        </p>
      )}
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-slate-400 text-blue-700 focus:ring-4 focus:ring-blue-600/25 dark:border-slate-500 dark:bg-slate-900"
          data-testid="legal-accept-terms"
        />
        <label htmlFor={checkboxId} className="cursor-pointer text-[14px] leading-5 text-slate-700 dark:text-slate-200">
          Принимаю{' '}
          <DocLink slug="terms" version={terms.version} testId="legal-terms-link">Пользовательское соглашение</DocLink>
          {' '}(редакция от {formatVersion(terms.version)})
        </label>
      </div>
      {error && <p id={errorId} role="alert" className="text-[13.5px] font-medium text-red-700 dark:text-red-400" data-testid="legal-error">{error}</p>}
      {policy && (
        <p className="flex items-start gap-2 text-[13px] leading-5 text-slate-500 dark:text-slate-400" data-testid="legal-policy-note">
          <FileText size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Нажимая «{action}», вы подтверждаете, что ознакомились с{' '}
            <DocLink slug="privacy" version={policy.version} testId="legal-policy-link">Политикой обработки персональных данных</DocLink>.
            {' '}Email и данные аккаунта нужны, чтобы аккаунт работал; отдельного согласия на это не требуется.
          </span>
        </p>
      )}
    </div>
  );
}
