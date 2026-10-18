/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сведения о клиенте для истории входов и списка сессий — грубые намеренно:
 * «Chrome 129 · macOS» и сеть /24 (IPv6 — /48), а не полная строка
 * User-Agent и адрес. Этого хватает, чтобы узнать «не моё устройство», и
 * не хватает, чтобы следить за человеком.
 */

import net from 'node:net';

const BROWSERS = [
  [/YaBrowser\/(\d+)/, 'Яндекс Браузер'],
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/FxiOS\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)/, 'Chrome'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//, 'Safari'],
  [/curl\/(\d+)/, 'curl'],
  [/node(?:-fetch)?\/?(\d+)?/i, 'Node.js'],
];

const SYSTEMS = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows NT/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** «Chrome 129 · macOS» или «Неизвестный клиент». Строка до 60 символов. */
export const describeClient = (userAgent) => {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  if (!ua) return 'Неизвестный клиент';
  let browser = null;
  for (const [pattern, name] of BROWSERS) {
    const match = ua.match(pattern);
    if (match) {
      browser = match[1] ? `${name} ${match[1]}` : name;
      break;
    }
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] || null;
  const mobile = /Mobile|Android|iPhone/.test(ua) && system !== 'macOS' ? ' (мобильный)' : '';
  const label = [browser, system ? `${system}${mobile}` : null].filter(Boolean).join(' · ');
  return (label || 'Неизвестный клиент').slice(0, 60);
};

/** Сеть адреса: 203.0.113.0/24, 2001:db8:1::/48. Не IP — null. */
export const networkPrefix = (ip) => {
  let address = typeof ip === 'string' ? ip.trim() : '';
  if (address.startsWith('::ffff:') && net.isIPv4(address.slice(7))) address = address.slice(7);
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (net.isIPv6(address)) {
    const [head] = address.split('%');
    const halves = head.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${groups.slice(0, 3).map((group) => (group || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return null;
};
