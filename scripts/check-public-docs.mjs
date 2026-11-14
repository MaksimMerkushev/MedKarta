#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Внутренние документы не публикуются на сайте документации: каждый прежний
 * адрес должен отдавать 404. Только GET-запросы, ничего не меняет.
 *
 *   node scripts/check-public-docs.mjs https://docs.navimed.tech
 *
 * Код выхода 1 — какой-то внутренний документ ещё открывается.
 */

export const INTERNAL_PATHS = Object.freeze([
  ...['README', '01-data-map', '02-legal-bases', '03-findings', '04-health-data', '05-retention-and-destruction', '06-subject-requests',
    '07-incident-response', '08-processing-registry', '09-security-measures', '10-processors-and-localization', '11-rkn-notification',
    '12-legal-questions', '13-operator-checklist'].map((name) => `privacy/${name}.md`),
  '08-security.md', '18-known-limitations.md', 'ai-pipeline-report.md', 'labs-report.md', 'medical-rules.md',
  'privacy-architecture.md', 'privacy-evaluation.md', 'routing.md', 'demo.md', 'accounts.md', 'auth-threat-model.md',
  'mail-setup.md', 'admin-security-runbook.md', 'analytics.md', 'data-pipeline.md', 'deployment.md', 'legacy/README.md',
]);

const base = String(process.argv[2] || '').replace(/\/+$/, '');
if (process.argv[1]?.endsWith('check-public-docs.mjs')) {
  if (!/^https?:\/\//.test(base)) {
    console.error('Укажите адрес сайта документации: node scripts/check-public-docs.mjs https://docs.navimed.tech');
    process.exit(2);
  }
  const open = [];
  for (const item of INTERNAL_PATHS) {
    const response = await fetch(`${base}/${item}`, { headers: { 'User-Agent': 'MedKarta-docs-check/1.0' } });
    if (response.status !== 404) open.push(`${item} → HTTP ${response.status}`);
  }
  if (open.length) {
    console.log(`Открываются ${open.length} из ${INTERNAL_PATHS.length} внутренних документов:`);
    for (const line of open) console.log(` - ${line}`);
    process.exit(1);
  }
  console.log(`Все ${INTERNAL_PATHS.length} внутренних документов отдают 404.`);
}
