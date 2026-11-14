/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Загрузка файлов моделей NER с зафиксированных ревизий Hugging Face и проверка SHA-256.
 * Запускается вручную при установке; сервис сам ничего не скачивает.
 *   node services/pii-ner/fetch-model.mjs [каталог]   (по умолчанию services/pii-ner/model)
 * rubert-tiny скачивается готовым (ONNX int8). redmadrobot публикуется только в safetensors:
 * скачиваются исходные файлы, ONNX int8 собирает export-onnx.py (Python нужен один раз).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'model.json'), 'utf8'));
const target = path.resolve(process.argv[2] || path.join(here, 'model'));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const download = async (id, revision, file, destination, expected = null) => {
  if (fs.existsSync(destination) && (!expected || sha256(fs.readFileSync(destination)) === expected)) return console.log(`есть: ${file}`);
  const response = await fetch(`https://huggingface.co/${id}/resolve/${revision}/${file}`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${id}/${file}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (expected && sha256(buffer) !== expected) throw new Error(`${file}: SHA-256 не совпадает с model.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.writeFileSync(destination, buffer, { mode: 0o644 });
  console.log(`загружен${expected ? ' и проверен' : ''}: ${id}/${file} (${Math.round(buffer.length / 1024)} КБ)`);
};

for (const spec of manifest.models) {
  const dir = path.join(target, spec.name);
  if (spec.export) {
    // Исходники для экспорта; итоговые файлы сверит export-onnx.py с model.json.
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors']) await download(spec.id, spec.revision, file, path.join(dir, 'source', file));
    console.log(`${spec.name}: дальше — python3 services/pii-ner/export-onnx.py ${dir}`);
    continue;
  }
  for (const [file, expected] of Object.entries(spec.files)) await download(spec.id, spec.revision, file, path.join(dir, file), expected);
}
