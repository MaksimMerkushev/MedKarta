/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Корень приложения: /admin…, /profile, /login и /activate — отдельными
 * чанками (карта их код не грузит), всё остальное — карта.
 */
import { lazy, Suspense } from 'react'
import App from './App.jsx'
import { useLocation } from './ui/navigation.js'

const AdminApp = lazy(() => import('./admin/AdminApp.jsx'))
const ProfilePage = lazy(() => import('./profile/ProfilePage.jsx'))
const LoginPage = lazy(() => import('./auth/LoginPage.jsx'))
const ActivationPage = lazy(() => import('./auth/ActivationPage.jsx'))

const Fallback = () => <div className="h-full bg-slate-50 dark:bg-slate-950" />
const AuthFallback = () => <div className="h-full bg-white dark:bg-slate-950" />

export default function Root() {
  const { path } = useLocation()
  if (path === '/admin' || path.startsWith('/admin/')) {
    return <Suspense fallback={<Fallback />}><AdminApp /></Suspense>
  }
  if (path === '/profile') {
    return <Suspense fallback={<Fallback />}><ProfilePage /></Suspense>
  }
  if (path === '/login') {
    return <Suspense fallback={<AuthFallback />}><LoginPage /></Suspense>
  }
  if (path === '/activate') {
    return <Suspense fallback={<AuthFallback />}><ActivationPage /></Suspense>
  }
  return <App />
}
