/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Этот код является интеллектуальной собственностью автора.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, X, Send, Loader2 } from 'lucide-react';
import { analyzeSymptoms } from './services/ai';
import { LIMITS } from '@shared/contract.js';

const GREETING = {
  role: 'assistant',
  content:
    'Привет! 👋 Я ваш навигатор по МедКарте. Расскажите, какой специалист вам нужен или на что вы жалуетесь, и я помогу найти врача и построить маршрут.',
};

// Технические подробности наружу не показываем: пользователю нужен понятный текст,
// а детали ошибки остаются в консоли сервера.
const friendlyError = (error) => {
  switch (error?.code) {
    case 'timeout':
      return 'Ответ занял слишком много времени. Попробуйте ещё раз через пару секунд 🔄';
    case 'network':
      return 'Нет связи с сервером. Проверьте интернет-соединение и попробуйте снова.';
    case 'rate_limit':
      return 'Слишком много запросов подряд. Давайте сделаем небольшую паузу и продолжим 🙏';
    case 'unavailable':
      return 'Сервис временно недоступен. Мы уже работаем над этим!';
    default:
      return 'Что-то пошло не так. Попробуйте ещё раз через пару секунд 🔄';
  }
};

export default function AIAssistant({ isOpen, onClose, onApplyTriage, isMobile }) {
  const [messages, setMessages] = useState([GREETING]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [messages, isLoading]);

  useEffect(() => {
    if (isOpen && !isMobile && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, isMobile]);

  // Закрытие окна не должно оставлять висящий запрос и обновлять состояние
  // размонтированного диалога.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      /*
       * Esc в чужом поле ввода относится к нему: в строке поиска им
       * закрывают подсказки. Раньше слушатель на window закрывал чат из
       * любого места страницы, а закрытие стирало переписку.
       */
      const target = event.target instanceof Element ? event.target : null;
      const insideAssistant = Boolean(target?.closest('[aria-label="AI-помощник МедКарты"]'));
      const editableElsewhere = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]')) && !insideAssistant;
      if (editableElsewhere) return;
      handleClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleClose]);

  const handleSend = useCallback(async () => {
    const userText = inputValue.trim().slice(0, LIMITS.MAX_MESSAGE_CHARS);
    if (!userText || isLoading) {
      return;
    }

    setInputValue('');
    const nextMessages = [...messages, { role: 'user', content: userText }];
    setMessages(nextMessages);
    setIsLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await analyzeSymptoms(nextMessages, { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: result.replyText }]);
      onApplyTriage?.(result);
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: friendlyError(error) }]);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoading(false);
      }
    }
  }, [inputValue, isLoading, messages, onApplyTriage]);

  if (!isOpen) {
    return null;
  }

  const charCount = inputValue.length;
  const isNearLimit = charCount > LIMITS.MAX_MESSAGE_CHARS - 100;

  const renderMessages = (bubbleClass) => (
    <div className="space-y-4">
      {messages.map((msg, idx) => (
        <div key={`${msg.role}-${idx}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 ${bubbleClass} leading-relaxed shadow-sm ${
              msg.role === 'user'
                ? 'bg-violet-600 text-white rounded-tr-sm'
                : 'bg-slate-50 text-slate-700 border border-slate-100 rounded-tl-sm dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200'
            }`}
          >
            {msg.content}
          </div>
        </div>
      ))}
      {isLoading && (
        <div className="flex justify-start">
          <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-600 dark:bg-slate-700">
            <Loader2 size={isMobile ? 18 : 16} className="animate-spin text-violet-500" />
            <span className="text-sm text-slate-500 dark:text-slate-400">Думаю...</span>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );

  // Мобильный: полноэкранный режим
  if (isMobile) {
    return (
      <div
        className="ai-assistant-mobile fixed inset-0 z-[1100] flex flex-col bg-white dark:bg-slate-800"
        role="dialog"
        aria-modal="true"
        aria-label="AI-помощник МедКарты"
      >
        <div
          className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-violet-50 to-white px-4 py-3 dark:border-slate-700 dark:from-slate-700 dark:to-slate-800"
          style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900 dark:text-violet-300">
              <Bot size={22} aria-hidden="true" />
            </div>
            <div>
              <div className="text-[15px] font-bold text-slate-800 dark:text-white">AI-Помощник</div>
              <div className="text-[11px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
                Подбор специалиста и маршрута
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Закрыть помощника"
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition-colors active:bg-slate-100 dark:active:bg-slate-700"
          >
            <X size={22} aria-hidden="true" />
          </button>
        </div>

        <div
          className="ai-messages-area flex-1 overflow-y-auto p-4"
          style={{ WebkitOverflowScrolling: 'touch' }}
          aria-live="polite"
        >
          {renderMessages('py-3 text-[14px]')}
        </div>

        <div className="border-t border-slate-100 p-3 dark:border-slate-700" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
          <div className="relative flex items-center gap-2">
            <label className="sr-only" htmlFor="ai-input-mobile">
              Опишите, какой специалист нужен
            </label>
            <input
              id="ai-input-mobile"
              ref={inputRef}
              type="text"
              value={inputValue}
              maxLength={LIMITS.MAX_MESSAGE_CHARS}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Опишите симптомы..."
              disabled={isLoading}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 pl-4 pr-14 py-3.5 text-[15px] outline-none transition-all focus:border-violet-400 focus:ring-2 focus:ring-violet-300 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!inputValue.trim() || isLoading}
              aria-label="Отправить сообщение"
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white transition-transform active:scale-95 disabled:opacity-50"
            >
              <Send size={18} aria-hidden="true" />
            </button>
          </div>
          {isNearLimit && (
            <div className="mt-1 text-right text-[11px] text-slate-400">
              {charCount} / {LIMITS.MAX_MESSAGE_CHARS}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Десктоп/планшет: popup
  return (
    <div
      className="absolute bottom-20 right-6 z-[1050] w-[350px] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl transition-all dark:border-slate-700 dark:bg-slate-800"
      role="dialog"
      aria-label="AI-помощник МедКарты"
    >
      <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-violet-50 to-white px-4 py-3 dark:border-slate-700 dark:from-slate-700 dark:to-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900 dark:text-violet-300">
            <Bot size={18} aria-hidden="true" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-slate-800 dark:text-white">AI-Помощник</div>
            <div className="text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
              Подбор специалиста и маршрута
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Закрыть помощника"
          className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="h-[280px] overflow-y-auto p-4 scrollbar-thin" aria-live="polite">
        {renderMessages('py-2.5 text-[13px]')}
      </div>

      <div className="border-t border-slate-100 p-3 dark:border-slate-700">
        <div className="relative flex items-center gap-2">
          <label className="sr-only" htmlFor="ai-input-desktop">
            Опишите, какой специалист нужен
          </label>
          <input
            id="ai-input-desktop"
            ref={inputRef}
            type="text"
            value={inputValue}
            maxLength={LIMITS.MAX_MESSAGE_CHARS}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSend();
              }
            }}
            placeholder="Опишите симптомы..."
            disabled={isLoading}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 pl-4 pr-10 py-2.5 text-[13px] outline-none transition-all focus:border-violet-400 focus:ring-2 focus:ring-violet-300 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || isLoading}
            aria-label="Отправить сообщение"
            className="absolute right-2 top-1.5 flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-violet-600 text-white transition-transform hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
          >
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
        {isNearLimit && (
          <div className="mt-1 text-right text-[11px] text-slate-400">
            {charCount} / {LIMITS.MAX_MESSAGE_CHARS}
          </div>
        )}
      </div>
    </div>
  );
}
