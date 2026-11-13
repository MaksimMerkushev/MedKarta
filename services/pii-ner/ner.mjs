/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальная модель распознавания имён, организаций и мест (rubert-tiny, ONNX int8).
 * Возвращает только найденные фрагменты: тип, позицию и уверенность. Текст не
 * переписывает и ничего не придумывает. Позиции — в единицах строки JavaScript
 * (UTF-16), как у вызывающего кода.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const isControl = (ch) => ch !== '\t' && ch !== '\n' && ch !== '\r' && /\p{Cc}|\p{Cf}/u.test(ch);
const isPunct = (ch) => {
  const cp = ch.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(ch);
};

/** Базовая токенизация BERT (регистр сохраняется) с позициями в исходной строке. */
export const basicTokenize = (text) => {
  const tokens = [];
  let current = null;
  const flush = () => { if (current) tokens.push(current); current = null; };
  let index = 0;
  for (const ch of text) {
    const start = index;
    index += ch.length;
    if (ch === '\u0000' || ch === '�' || isControl(ch) || /\s/u.test(ch)) { flush(); continue; }
    if (isPunct(ch)) { flush(); tokens.push({ text: ch, start, end: index }); continue; }
    if (!current) current = { text: '', start, end: start };
    current.text += ch;
    current.end = index;
  }
  flush();
  return tokens;
};

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Файлы модели должны совпасть с model.json: подменённая или повреждённая модель не загружается. */
export const verifyModelFiles = (dir, manifest) => {
  for (const [file, expected] of Object.entries(manifest.files)) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) throw new Error(`нет файла модели: ${file}`);
    if (sha256File(full) !== expected) throw new Error(`файл модели изменён: ${file}`);
  }
};

export const loadNer = async ({ ort, dir, manifest, threads = 1, maxPieces = 512 }) => {
  verifyModelFiles(dir, manifest);
  const vocab = new Map(fs.readFileSync(path.join(dir, 'vocab.txt'), 'utf8').split('\n').map((token, id) => [token, id]));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const labels = Object.entries(config.id2label).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, label]) => label);
  const session = await ort.InferenceSession.create(path.join(dir, 'onnx/model_int8.onnx'), {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });
  const UNK = vocab.get('[UNK]');
  const CLS = vocab.get('[CLS]');
  const SEP = vocab.get('[SEP]');

  const wordpiece = (word) => {
    const chars = [...word.text];
    if (chars.length > 100) return [{ id: UNK }];
    const pieces = [];
    let i = 0;
    while (i < chars.length) {
      let j = chars.length;
      let found = null;
      while (j > i) {
        const sub = (i > 0 ? '##' : '') + chars.slice(i, j).join('');
        if (vocab.has(sub)) { found = sub; break; }
        j -= 1;
      }
      if (!found) return [{ id: UNK }];
      pieces.push({ id: vocab.get(found) });
      i = j;
    }
    return pieces;
  };

  const tagChunk = async (words) => {
    const pieces = [];
    words.forEach((word, w) => { for (const piece of word.pieces) pieces.push({ id: piece.id, word: w }); });
    const ids = [CLS, ...pieces.map((p) => p.id), SEP];
    const tensor = (values) => new ort.Tensor('int64', BigInt64Array.from(values, (v) => BigInt(v)), [1, ids.length]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) };
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
    const output = await session.run(feeds);
    const logits = output[session.outputNames[0]].data;
    const k = labels.length;
    const result = words.map(() => ({ label: 'O', score: 1 }));
    const seen = new Set();
    pieces.forEach((piece, p) => {
      if (seen.has(piece.word)) return; // метка слова — по первой его части
      seen.add(piece.word);
      const row = Array.from(logits.subarray((p + 1) * k, (p + 2) * k));
      const max = Math.max(...row);
      const exps = row.map((v) => Math.exp(v - max));
      const best = row.indexOf(max);
      result[piece.word] = { label: labels[best], score: exps[best] / exps.reduce((a, b) => a + b, 0) };
    });
    return result;
  };

  /** @returns {Promise<Array<{type: string, start: number, end: number, score: number}>>} */
  const entities = async (text) => {
    const words = basicTokenize(text).map((word) => ({ ...word, pieces: wordpiece(word) }));
    const tags = [];
    let chunk = [];
    let budget = 0;
    for (const word of words) {
      const size = Math.min(word.pieces.length, maxPieces - 2);
      if (budget + size > maxPieces - 2 && chunk.length) { tags.push(...await tagChunk(chunk)); chunk = []; budget = 0; }
      chunk.push(word);
      budget += size;
    }
    if (chunk.length) tags.push(...await tagChunk(chunk));
    const found = [];
    let previous = -2;
    tags.forEach((tag, w) => {
      if (tag.label === 'O') return;
      const [prefix, type] = tag.label.split('-');
      const last = found.at(-1);
      if (prefix === 'I' && last && last.type === type && previous === w - 1) {
        last.end = words[w].end;
        last.score = Math.min(last.score, tag.score);
      } else {
        found.push({ type, start: words[w].start, end: words[w].end, score: tag.score });
      }
      previous = w;
    });
    return found.map((item) => ({ ...item, score: Math.round(item.score * 1000) / 1000 }));
  };

  return { entities, labels };
};
