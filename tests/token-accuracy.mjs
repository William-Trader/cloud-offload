import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { encode } = req('gpt-tokenizer');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['README.md','CLOUD_OFFLOAD.md','实验报告.md','cloud-offload-api.mjs','cloud-offload.mjs','bridge.mjs','public/index.html','settings.json'];

function cls(t) {
  let cjk = 0, ascii = 0, other = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++;
    else if (c < 128) ascii++;
    else other++;
  }
  return { cjk: cjk, ascii: ascii, other: other };
}

const rows = [];
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const t = fs.readFileSync(p, 'utf8');
  const n = cls(t);
  const real = encode(t).length;
  rows.push({ file: f, chars: t.length, realTokens: real, cjk: n.cjk, ascii: n.ascii, other: n.other, charsPerToken: Number((t.length / real).toFixed(3)) });
}

let Sxx = 0, Syy = 0, Sxy = 0, Sxt = 0, Syt = 0;
for (const r of rows) { Sxx += r.cjk * r.cjk; Syy += r.ascii * r.ascii; Sxy += r.cjk * r.ascii; Sxt += r.cjk * r.realTokens; Syt += r.ascii * r.realTokens; }
const det = Sxx * Syy - Sxy * Sxy;
const a = (Sxt * Syy - Syt * Sxy) / det;
const b = (Syt * Sxx - Sxt * Sxy) / det;

function mapeOf(fn) { let s = 0; for (const r of rows) s += Math.abs(fn(r) - r.realTokens) / r.realTokens; return Number((s / rows.length * 100).toFixed(1)); }
const oldEst = function (r) { return Math.ceil(r.chars / 1.5); };
const mix4 = function (r) { return Math.ceil(r.cjk / 1.7 + (r.ascii + r.other) / 4); };
const fitted = function (r) { return Math.ceil(a * r.cjk + b * r.ascii + r.other * 0.9); };

const totalReal = rows.reduce(function (x, r) { return x + r.realTokens; }, 0);
const totalCjk = rows.reduce(function (x, r) { return x + r.cjk; }, 0);
const totalAscii = rows.reduce(function (x, r) { return x + r.ascii; }, 0);
const totalOther = rows.reduce(function (x, r) { return x + r.other; }, 0);

console.log(JSON.stringify({
  model: 'gpt-tokenizer cl100k_base',
  fitted: { a_perCjk: Number(a.toFixed(4)), b_perAscii: Number(b.toFixed(4)), otherPer: 0.9 },
  overall: { charsPerToken: Number((totalCjk + totalAscii + totalOther) / totalReal, 3), cjkShare: Number((totalCjk / (totalCjk + totalAscii + totalOther)).toFixed(3)) },
  mapePct: { old_div1_5: mapeOf(oldEst), mix_cjk1_7_ascii4: mapeOf(mix4), fitted: mapeOf(fitted) },
  rows: rows
}, null, 2));
