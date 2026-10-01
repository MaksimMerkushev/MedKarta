/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Обратная связь: «Нашли, куда обратиться?» и «Данные неверны».
 *
 * Ответы — только из готовых вариантов. Поле для свободного текста здесь
 * намеренно нет: человек напишет туда диагноз или телефон, а хранить такое
 * нам незачем. Аналитика получает код причины, не слова.
 */
import { useState } from 'react';
import { Check, Flag, ThumbsDown, ThumbsUp, X } from 'lucide-react';

const SEARCH_REASONS = [
  ['no_doctor', 'Нет нужного врача'],
  ['too_far', 'Далеко'],
  ['bad_time', 'Неудобное время'],
  ['too_expensive', 'Дорого'],
  ['not_covered', 'Не по ОМС / ДМС'],
  ['wrong_data', 'Данные неверны'],
  ['other', 'Другое'],
];

const DATA_REASONS = [
  ['closed', 'Не работает / закрыто'],
  ['wrong_hours', 'Другие часы работы'],
  ['wrong_phone', 'Телефон не отвечает'],
  ['wrong_address', 'Неверный адрес'],
  ['doctor_left', 'Врач здесь не принимает'],
  ['other', 'Другое'],
];

const chipClass =
  'rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

/**
 * Вопрос после поиска. Показывается один раз на поиск; закрытие — тоже ответ
 * («не сейчас»), повторно тот же вопрос не задаётся.
 */
export function SearchFeedbackPrompt({ onAnswer, onDismiss }) {
  const [stage, setStage] = useState('ask');

  if (stage === 'thanks') {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200" role="status">
        <Check size={16} aria-hidden="true" /> Спасибо! Это помогает сделать поиск точнее.
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40" aria-label="Оценка поиска">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {stage === 'ask' ? 'Нашли, куда обратиться?' : 'Что помешало?'}
        </p>
        <button type="button" onClick={onDismiss} aria-label="Закрыть вопрос" className="-mr-1 -mt-1 rounded-lg p-1 text-slate-400 hover:bg-white/70 dark:hover:bg-slate-700">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {stage === 'ask' ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={chipClass}
            onClick={() => {
              onAnswer('yes', null);
              setStage('thanks');
            }}
          >
            <ThumbsUp size={13} className="mr-1 inline -translate-y-px" aria-hidden="true" /> Да
          </button>
          <button type="button" className={chipClass} onClick={() => setStage('reasons')}>
            <ThumbsDown size={13} className="mr-1 inline -translate-y-px" aria-hidden="true" /> Нет
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {SEARCH_REASONS.map(([code, label]) => (
            <button
              key={code}
              type="button"
              className={chipClass}
              onClick={() => {
                onAnswer('no', code);
                setStage('thanks');
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Кнопка в карточке: сообщить, что данные о месте устарели. */
export function DataReportButton({ onReport }) {
  const [stage, setStage] = useState('idle');

  if (stage === 'sent') {
    return (
      <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300" role="status">
        <Check size={13} aria-hidden="true" /> Спасибо, проверим эту запись.
      </p>
    );
  }

  if (stage === 'idle') {
    return (
      <button
        type="button"
        onClick={() => setStage('choose')}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 underline decoration-dotted underline-offset-4 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
      >
        <Flag size={12} aria-hidden="true" /> Сообщить об ошибке в данных
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Что не так?</span>
        <button type="button" onClick={() => setStage('idle')} aria-label="Отмена" className="rounded p-0.5 text-slate-400 hover:text-slate-600">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {DATA_REASONS.map(([code, label]) => (
          <button
            key={code}
            type="button"
            className={chipClass}
            onClick={() => {
              onReport(code);
              setStage('sent');
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
