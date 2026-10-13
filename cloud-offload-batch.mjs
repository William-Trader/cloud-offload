// cloud-offload-batch.mjs — 复杂任务协作：本地拆解 → 云端分段产出 → 本地拼装
// 用法: node cloud-offload-batch.mjs --spec plan.json --out result.md [--material-file m.txt] [--quiet]
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.OFFLOAD_API || 'http://127.0.0.1:8788/api/offload';
function arg(name, def) { const i = process.argv.indexOf('--' + name); if (i < 0) return def; const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) return true; return v; }

const specFile = arg('spec', '');
const outPath = arg('out', '');
const materialFile = arg('material-file', '');
const quiet = !!arg('quiet', false);
if (!specFile || specFile === true) { console.log('用法: node cloud-offload-batch.mjs --spec plan.json --out result.md [--material-file m.txt]'); process.exit(2); }

const spec = JSON.parse(fs.readFileSync(String(specFile), 'utf8'));
const material = (materialFile && materialFile !== true) ? fs.readFileSync(String(materialFile), 'utf8') : '';
const parts = Array.isArray(spec.parts) ? spec.parts : [];

async function runPart(p, i) {
  const t0 = Date.now();
  let j = {};
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: p.task, material: p.material || material, type: spec.type || 'write', model: spec.model }) });
    j = await r.json();
  } catch (e) { j = { ok: false, error: String(e.message) }; }
  const ans = String(j.answer || '');
  if (!quiet) console.log('[part ' + (i + 1) + '/' + parts.length + '] ' + (p.heading || '') + ' -> ' + (Date.now() - t0) + 'ms, ' + ans.length + ' 字符' + (j.cached ? ' (缓存)' : '') + (j.ok === false ? (' 失败: ' + j.error) : ''));
  return { heading: p.heading, body: ans, ms: Date.now() - t0, cached: !!j.cached, ok: j.ok !== false && !!ans };
}

const results = [];
for (let i = 0; i < parts.length; i++) results.push(await runPart(parts[i], i));

const NL = String.fromCharCode(10);
const blocks = [];
if (spec.title) blocks.push('# ' + spec.title, '');
for (const r of results) { if (r.heading) blocks.push('## ' + r.heading, ''); blocks.push(r.body, ''); }
const doc = blocks.join(NL);

if (outPath && outPath !== true) { fs.mkdirSync(path.dirname(String(outPath)), { recursive: true }); fs.writeFileSync(String(outPath), doc, 'utf8'); }

const totalMs = results.reduce(function (a, r) { return a + r.ms; }, 0);
const okN = results.filter(function (r) { return r.ok; }).length;
const cachedN = results.filter(function (r) { return r.cached; }).length;
console.log('拼装完成: ' + okN + '/' + parts.length + ' 段, ' + doc.length + ' 字符, 累计 ' + totalMs + 'ms, 缓存命中 ' + cachedN + '/' + parts.length + (outPath && outPath !== true ? (', 已写入 ' + outPath) : ''));
if (!outPath || outPath === true) console.log(doc);
