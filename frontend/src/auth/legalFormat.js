/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ссылки на редакции документов и дата редакции для подписи.
 */

/** /legal/<slug>?version=… — текст именно той редакции, что принимают. */
export const legalHref = (slug, version) => `/legal/${slug}${version ? `?version=${encodeURIComponent(version)}` : ''}`;

/** «2026-10-26» → «26.10.2026»; «2026-10-26.1» → «26.10.2026 (1)»; иные форматы — как есть. */
export const formatVersion = (version) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(\.\d+)?$/.exec(String(version || ''));
  return match ? `${match[3]}.${match[2]}.${match[1]}${match[4] ? ` (${match[4].slice(1)})` : ''}` : String(version || '');
};
