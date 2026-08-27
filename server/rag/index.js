import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf-8'));

// 中文没有空格分词，用连续汉字的相邻字符 bigram 近似分词；英文/数字按整段小写 token 处理。
function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  const re = /[一-龥]+|[a-zA-Z0-9]+/g;
  let match;
  while ((match = re.exec(text))) {
    const seg = match[0];
    if (/[一-龥]/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg);
      } else {
        for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
      }
    } else {
      tokens.push(seg.toLowerCase());
    }
  }
  return tokens;
}

function buildIndex(records) {
  // question 权重更高：重复拼接两遍再和 answer 一起分词
  const docs = records.map((r) => ({
    record: r,
    tokens: tokenize(`${r.question} ${r.question} ${r.answer}`),
  }));

  const df = new Map();
  for (const doc of docs) {
    for (const t of new Set(doc.tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const N = docs.length;
  const idf = new Map();
  for (const [t, c] of df) {
    idf.set(t, Math.log((N + 1) / (c + 0.5)) + 1);
  }

  const docVectors = docs.map((doc) => {
    const tf = new Map();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    let normSq = 0;
    for (const [t, f] of tf) {
      const w = f * (idf.get(t) || 0);
      vec.set(t, w);
      normSq += w * w;
    }
    return { vec, norm: Math.sqrt(normSq) || 1, record: doc.record };
  });

  return { idf, docVectors };
}

const index = buildIndex(corpus);

export function searchKnowledge(query, topK = 3) {
  if (!query || !query.trim()) return [];

  const tf = new Map();
  for (const t of tokenize(query)) tf.set(t, (tf.get(t) || 0) + 1);

  const qVec = new Map();
  let qNormSq = 0;
  for (const [t, f] of tf) {
    const w = f * (index.idf.get(t) || 0);
    if (w > 0) {
      qVec.set(t, w);
      qNormSq += w * w;
    }
  }
  const qNorm = Math.sqrt(qNormSq) || 1;

  const scored = index.docVectors.map(({ vec, norm, record }) => {
    let dot = 0;
    for (const [t, w] of qVec) {
      const dv = vec.get(t);
      if (dv) dot += dv * w;
    }
    return { record, score: dot / (qNorm * norm) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, topK)
    .filter((s) => s.score > 0)
    .map((s) => ({
      id: s.record.id,
      question: s.record.question,
      answer: s.record.answer,
      score: Math.round(s.score * 1000) / 1000,
    }));
}
