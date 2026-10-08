import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { kazanFacilities } from '../data/facilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const facilitiesPath = path.resolve(__dirname, '../data/facilities.js');

const GOV_RE = /(мвд|военн|госпитал(?:ь|я)|минздрав|гбуз|гауз|государ|городск|ркб|фкуз|росгвард|фсб|уфсин|диспансер|больниц|поликлиник|поликлиническ|станц(?:ия)? скорой|мсч|медсанчаст|ветеран|женск.*консультац|травмпункт|врач[а-я\s]+общей практики|амбулатор(?:ия|ное отделение))/i;
const PRIVATE_RE = /(ооо|ao\b|зао|клиника\s+сем|медцентр\s+сем|частн|платн|premium|private)/i;

const updated = [];
const changed = [];

for (const item of kazanFacilities) {
  const text = `${item.name || ''} ${item.clinic || ''}`;
  let nextOwnership = item.ownership || 'Частная';

  if (GOV_RE.test(text)) {
    nextOwnership = 'Государственная';
  } else if (PRIVATE_RE.test(text)) {
    nextOwnership = 'Частная';
  }

  if (nextOwnership !== item.ownership) {
    changed.push({
      id: item.id,
      name: item.name,
      from: item.ownership,
      to: nextOwnership,
    });
  }

  updated.push({
    ...item,
    ownership: nextOwnership,
  });
}

fs.writeFileSync(facilitiesPath, `export const kazanFacilities = ${JSON.stringify(updated, null, 2)};\n`);

console.log(`Checked: ${updated.length}`);
console.log(`Changed: ${changed.length}`);
for (const c of changed) {
  console.log(`- ${c.name}: ${c.from} -> ${c.to}`);
}
