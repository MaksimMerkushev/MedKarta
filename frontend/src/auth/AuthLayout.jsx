/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Каркас страниц /login и /activate: слева форма, справа (от 1024 px)
 * иллюстрация — фрагмент карты Казани с зонами доступности. На телефоне —
 * только форма, без лишнего. Форма прижата к верху (а не по центру): при
 * смене шага меняется высота, и заголовок не должен прыгать. Шрифт —
 * системный, как во всём приложении: без запросов к сторонним шрифтовым
 * сервисам. Страница прокручивается сама: html и body у приложения с
 * overflow: hidden (из-за карты).
 */
import { ArrowLeft } from 'lucide-react';

import { ThemeToggle } from '../ui/kit';
import { useTheme } from '../ui/hooks';
import { Link } from '../ui/router';
import CityIllustration from './CityIllustration';

/** Знак МедКарты: метка с крестом на фрагменте карты — как иконка приложения. */
export function BrandMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" className="fill-blue-50 dark:fill-slate-800" />
      <path d="M0 21h32M11 0v32M24 0v32" className="stroke-blue-200 dark:stroke-slate-700" strokeWidth="2" />
      <path d="M16 27c-1.6-4.4-8-7.6-8-13a8 8 0 0 1 16 0c0 5.4-6.4 8.6-8 13z" fill="#dc2626" />
      <path d="M14.75 9.5h2.5v3.25h3.25v2.5h-3.25v3.25h-2.5v-3.25H11.5v-2.5h3.25z" fill="#fff" />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="-ml-1.5 inline-flex items-center gap-2.5 rounded-xl px-1.5 py-1" aria-label="МедКарта — на главную">
      <BrandMark />
      <span className="text-[17px] font-bold tracking-[-0.01em] text-slate-900 dark:text-white">МедКарта</span>
    </Link>
  );
}

export default function AuthLayout({ children, support = null, back = null }) {
  const theme = useTheme();
  return (
    <div className="mk-auth h-full overflow-y-auto overflow-x-hidden bg-white dark:bg-slate-950" data-testid="auth-page">
      <div className="grid min-h-full lg:grid-cols-2">
        <div className="flex min-h-full min-w-0 flex-col px-4 pb-5 pt-4 sm:px-8 sm:pt-6 lg:px-12">
          <header className="flex items-center justify-between gap-3">
            <Brand />
            <ThemeToggle theme={theme} />
          </header>

          <main className="flex flex-1 items-start justify-center pb-10 pt-10 sm:pt-[12vh]">
            <div className="w-full max-w-[400px]">
              {back && (
                <Link to={back.to} className="mb-6 inline-flex items-center gap-1.5 rounded-md text-[14px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
                  <ArrowLeft size={16} aria-hidden="true" />
                  {back.label}
                </Link>
              )}
              {children}
            </div>
          </main>

          <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px] text-slate-500 dark:text-slate-400">
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span>МедКарта, Казань</span>
              <a className="underline-offset-4 hover:text-slate-800 hover:underline dark:hover:text-slate-200" href="/legal/privacy" data-testid="footer-privacy">Политика обработки данных</a>
              <a className="underline-offset-4 hover:text-slate-800 hover:underline dark:hover:text-slate-200" href="/legal/terms" data-testid="footer-terms">Соглашение</a>
            </span>
            {(support?.email || support?.phone) && (
              <span className="min-w-0 truncate">
                Поддержка:{' '}
                {support.email
                  ? <a className="font-medium text-slate-700 underline-offset-4 hover:underline dark:text-slate-200" href={`mailto:${support.email}`}>{support.email}</a>
                  : <a className="font-medium text-slate-700 underline-offset-4 hover:underline dark:text-slate-200" href={`tel:${support.phone.replace(/[^\d+]/g, '')}`}>{support.phone}</a>}
              </span>
            )}
          </footer>
        </div>

        <aside className="sticky top-0 hidden h-dvh min-h-[600px] p-3 lg:block" aria-hidden="true">
          <div className="flex h-full flex-col overflow-hidden rounded-[20px] border border-slate-200 dark:border-slate-800">
            <div className="min-h-0 flex-1">
              <CityIllustration />
            </div>
            <div className="border-t border-slate-200 bg-white px-7 py-6 dark:border-slate-800 dark:bg-slate-950">
              <p className="text-[19px] font-semibold leading-7 tracking-[-0.01em] text-slate-900 dark:text-white">Врачи и клиники Казани на одной карте</p>
              <p className="mt-1.5 max-w-[440px] text-[14.5px] leading-[22px] text-slate-600 dark:text-slate-400">Расписание, программы ДМС и маршрут до клиники — в вашем аккаунте.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
