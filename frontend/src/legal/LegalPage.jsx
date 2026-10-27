/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * /legal/privacy, /legal/terms, /legal/health-consent — тексты документов.
 * ?version=ГГГГ-ММ-ДД — прежняя редакция (их не удаляют и не меняют: журнал
 * согласий хранит хэш принятого текста). Текст — из legal/*.md через
 * /api/legal; разметка разбирается здесь в элементы React (без innerHTML).
 */
import { Fragment, useEffect, useState } from 'react';
import { ArrowLeft, FileText, History } from 'lucide-react';

import { fetchLegalDocument } from '../services/account';
import { BrandMark } from '../auth/AuthLayout';
import { formatVersion } from '../auth/legalFormat';
import { ThemeToggle } from '../ui/kit';
import { useTheme } from '../ui/hooks';
import { useLocation } from '../ui/navigation';
import { Link } from '../ui/router';

const DOCS = [
  { slug: 'privacy', title: 'Политика обработки персональных данных' },
  { slug: 'terms', title: 'Пользовательское соглашение' },
];

/* ------------------------- разметка (подмножество) ------------------------- */

/** **жирный** внутри строки. */
const inline = (text, keyPrefix) => text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
  part.startsWith('**') && part.endsWith('**')
    ? <strong key={`${keyPrefix}-${index}`} className="font-semibold text-slate-900 dark:text-white">{part.slice(2, -2)}</strong>
    : <Fragment key={`${keyPrefix}-${index}`}>{part}</Fragment>
));

/** Заголовки #–###, абзацы, списки «- », разделитель «---». */
const renderLegalText = (text) => {
  const blocks = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p${blocks.length}`;
    blocks.push(<p key={key} className="my-3 text-[15px] leading-[24px] text-slate-700 dark:text-slate-300">{inline(paragraph.join(' '), key)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    const key = `l${blocks.length}`;
    blocks.push(
      <ul key={key} className="my-3 list-disc space-y-1.5 pl-6 text-[15px] leading-[24px] text-slate-700 marker:text-slate-400 dark:text-slate-300">
        {list.map((item, index) => <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`)}</li>)}
      </ul>,
    );
    list = [];
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const key = `h${blocks.length}`;
      if (level === 1) continue; // Заголовок документа — в шапке страницы.
      blocks.push(level === 2
        ? <h2 key={key} className="mb-2 mt-8 text-[19px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-white">{inline(heading[2], key)}</h2>
        : <h3 key={key} className="mb-1 mt-5 text-[16px] font-semibold text-slate-900 dark:text-white">{inline(heading[2], key)}</h3>);
    } else if (/^---+$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(<hr key={`r${blocks.length}`} className="my-6 border-slate-200 dark:border-slate-800" />);
    } else if (/^\s*-\s+/.test(line)) {
      flushParagraph();
      list.push(line.replace(/^\s*-\s+/, ''));
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (list.length > 0 && /^\s{2,}\S/.test(raw)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
};

/* --------------------------------- страница -------------------------------- */

const readVersion = () => {
  try {
    return new URLSearchParams(window.location.search).get('version');
  } catch {
    return null;
  }
};

export default function LegalPage() {
  const theme = useTheme();
  const { path } = useLocation();
  const slug = path.replace(/^\/legal\/?/, '').split('/')[0] || 'privacy';
  const [version, setVersion] = useState(readVersion);
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    const onPop = () => setVersion(readVersion());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    fetchLegalDocument(slug, version)
      .then((payload) => {
        if (!alive) return;
        setState({ status: 'ready', document: payload.document, history: payload.history || [] });
        document.title = `${payload.document.title} — МедКарта`;
      })
      .catch((error) => alive && setState({ status: 'error', error }));
    return () => {
      alive = false;
    };
  }, [slug, version]);

  const doc = state.document;
  const current = state.history?.[0]?.version || null;
  const archived = doc && current && doc.version !== current;

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-slate-950" data-testid="legal-page" data-slug={slug}>
      <div className="mx-auto flex min-h-full max-w-[760px] flex-col px-4 pb-10 pt-4 sm:px-8 sm:pt-6">
        <header className="flex items-center justify-between gap-3">
          <Link to="/" className="-ml-1.5 inline-flex items-center gap-2.5 rounded-xl px-1.5 py-1" aria-label="МедКарта — на главную">
            <BrandMark />
            <span className="text-[17px] font-bold tracking-[-0.01em] text-slate-900 dark:text-white">МедКарта</span>
          </Link>
          <ThemeToggle theme={theme} />
        </header>

        <nav className="mt-6 flex flex-wrap gap-2" aria-label="Документы">
          {DOCS.map((item) => (
            <a
              key={item.slug}
              href={`/legal/${item.slug}`}
              aria-current={item.slug === slug && !archived ? 'page' : undefined}
              className={`rounded-full border px-3 py-1.5 text-[13.5px] font-medium ${item.slug === slug
                ? 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200'
                : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:text-white'}`}
            >
              {item.title}
            </a>
          ))}
        </nav>

        <main className="mt-6 flex-1">
          {state.status === 'loading' && <div className="h-40 animate-pulse rounded-xl bg-slate-100 motion-reduce:animate-none dark:bg-slate-900" />}
          {state.status === 'error' && (
            <div data-testid="legal-error-page">
              <h1 className="text-[24px] font-bold text-slate-900 dark:text-white">Документ не найден</h1>
              <p className="mt-3 text-[15px] text-slate-600 dark:text-slate-300">
                {state.error?.status === 404 ? 'Такой редакции нет. Откройте действующую редакцию по ссылке выше.' : 'Не получилось загрузить документ. Проверьте интернет и обновите страницу.'}
              </p>
            </div>
          )}
          {state.status === 'ready' && (
            <article data-testid="legal-document" data-version={doc.version}>
              <h1 className="flex items-start gap-3 text-[26px] font-bold leading-tight tracking-[-0.02em] text-slate-900 dark:text-white">
                <FileText size={26} className="mt-1 shrink-0 text-blue-700 dark:text-blue-300" aria-hidden="true" />
                {doc.title}
              </h1>
              <p className="mt-2 text-[13.5px] text-slate-500 dark:text-slate-400">
                Редакция от {formatVersion(doc.version)}{archived ? ' — прежняя редакция' : ''}
                {doc.status === 'not_offered' ? ' · не применяется' : ''}
              </p>
              {archived && (
                <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[14px] text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                  Это прежняя редакция.{' '}
                  <a href={`/legal/${slug}`} className="font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">Действующая редакция — от {formatVersion(current)}</a>
                </p>
              )}
              {doc.draft && (
                <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200" data-testid="legal-document-draft">
                  Проект документа: сведения об операторе не заполнены, юридическая проверка не проведена.
                </p>
              )}
              <div className="mt-4">{renderLegalText(doc.text)}</div>

              {state.history.length > 1 && (
                <section className="mt-10 border-t border-slate-200 pt-6 dark:border-slate-800" aria-labelledby="legal-history">
                  <h2 id="legal-history" className="flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-white">
                    <History size={16} aria-hidden="true" /> Все редакции
                  </h2>
                  <ul className="mt-2 space-y-1 text-[14px]">
                    {state.history.map((item) => (
                      <li key={item.version}>
                        <a
                          href={`/legal/${slug}?version=${encodeURIComponent(item.version)}`}
                          onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                            event.preventDefault();
                            window.history.pushState(null, '', `/legal/${slug}?version=${encodeURIComponent(item.version)}`);
                            setVersion(item.version);
                          }}
                          className={`underline-offset-2 hover:underline ${item.version === doc.version ? 'font-semibold text-slate-900 dark:text-white' : 'text-blue-700 dark:text-blue-300'}`}
                        >
                          Редакция от {formatVersion(item.version)}{item.version === current ? ' (действующая)' : ''}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="mt-8 break-all text-[12px] text-slate-400 dark:text-slate-500">SHA-256 текста редакции: {doc.sha256}</p>
            </article>
          )}
        </main>

        <footer className="mt-8">
          <Link to="/" className="inline-flex items-center gap-1.5 rounded-md text-[14px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
            <ArrowLeft size={16} aria-hidden="true" /> На карту
          </Link>
        </footer>
      </div>
    </div>
  );
}
