/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Загрузка файлов модели NER с зафиксированной ревизии Hugging Face и проверка SHA-256.
 * Запускается один раз при установке, вручную; сервис сам ничего не скачивает.
 *   node services/pii-ner/fetch-model.mjs [каталог]   (по умолчанию services/pii-ner/model)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'model.json'), 'utf8'));
const target = path.resolve(process.argv[2] || path.join(here, 'model'));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

for (const [file, expected] of Object.entries(manifest.files)) {
  const destination = path.join(target, file);
  if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) === expected) {
    console.log(`есть: ${file}`);
    continue;
  }
  const url = `https://huggingface.co/${manifest.id}/resolve/${manifest.revision}/${file}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual} не совпадает с ${expected}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.writeFileSync(destination, buffer, { mode: 0o644 });
  console.log(`загружен и проверен: ${file} (${Math.round(buffer.length / 1024)} КБ)`);
}
