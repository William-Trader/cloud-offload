// cloud-offload-batch.mjs — 复杂任务协作：本地拆解 → 云端分段产出 → 本地拼装
// 用法: node cloud-offload-batch.mjs --spec plan.json --out result.md [--material-file m.txt] [--quiet]
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.OFFLOAD_API || 'http://127.0.0.1:8788/api/offload';
function arg(name, def) { const i = process.argv.indexOf('--' + name); if (i < 0) return def; const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) return true; return v; }
function argAll(name) { const out = []; for (let i = 0; i < process.argv.length; i++) { if (process.argv[i] === '--' + name) { const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) out.push(true); else out.push(v); } } return out; }

const specFile = arg('spec', '');
const outPath = arg('out', '');
const materialFile = arg('material-file', '');
const quiet = !!arg('quiet', false);
const assertList = argAll('assert').filter(function (x) { return x !== true; }).map(String);
const forbidList = argAll('forbid').filter(function (x) { return x !== true; }).map(String);
const minChars = Number(arg('min-chars', 0)) || 0;
const minCjk = Number(arg('min-cjk', 0)) || 0;
const checkFile = arg('check', '');
if ((!specFile || specFile === true) && !(checkFile && checkFile !== true)) { console.log('用法: node cloud-offload-batch.mjs --spec plan.json --out result.md [--material-file m.txt]  或  --check <文件> [--assert 模式] [--forbid 模式]'); process.exit(2); }

const spec = (specFile && specFile !== true) ? JSON.parse(fs.readFileSync(String(specFile), 'utf8')) : {};
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
if (!(checkFile && checkFile !== true)) { for (let i = 0; i < parts.length; i++) results.push(await runPart(parts[i], i)); }

const NL = String.fromCharCode(10);
const blocks = [];
if (spec.title) blocks.push('# ' + spec.title, '');
for (const r of results) { if (r.heading) blocks.push('## ' + r.heading, ''); blocks.push(r.body, ''); }
let doc = blocks.join(NL);
if (checkFile && checkFile !== true) { doc = fs.readFileSync(String(checkFile), 'utf8'); console.log('校验模式: 读取 ' + checkFile + '（不调云端）'); }

if (outPath && outPath !== true) { fs.mkdirSync(path.dirname(String(outPath)), { recursive: true }); fs.writeFileSync(String(outPath), doc, 'utf8'); }

const totalMs = results.reduce(function (a, r) { return a + r.ms; }, 0);
const okN = results.filter(function (r) { return r.ok; }).length;
const cachedN = results.filter(function (r) { return r.cached; }).length;
const cjk = (doc.match(/[\u4e00-\u9fff]/g) || []).length;
console.log('拼装完成: ' + okN + '/' + parts.length + ' 段, ' + doc.length + ' 字符, 累计 ' + totalMs + 'ms, 缓存命中 ' + cachedN + '/' + parts.length + (outPath && outPath !== true ? (', 已写入 ' + outPath) : ''));

// ---- 机械断言：零本地回读，只回一行 PASS/FAIL ----
const failed = [];
for (const p of assertList) { let re; try { re = new RegExp(p); } catch (e) { failed.push('assert-bad-regex:' + p); continue; } if (!re.test(doc)) failed.push('missing:' + p); }
for (const p of forbidList) { let re; try { re = new RegExp(p, 'g'); } catch (e) { failed.push('forbid-bad-regex:' + p); continue; } const m = doc.match(re); if (m && m.length) failed.push('forbidden:' + p + ' x' + m.length); }
if (minChars && doc.length < minChars) failed.push('too-short:' + doc.length + '<' + minChars);
if (minCjk && cjk < minCjk) failed.push('too-few-cjk:' + cjk + '<' + minCjk);
const assertOk = failed.length === 0;
console.log('[assert] ' + (assertOk ? 'PASS' : 'FAIL') + ' | 段 ' + okN + '/' + parts.length + ' | chars=' + doc.length + ' | cjk=' + cjk + (failed.length ? (' | 失败=' + failed.join(';')) : ''));

if (outPath && outPath !== true) {
  const receipt = { ts: new Date().toISOString(), out: String(outPath), parts: { total: parts.length, ok: okN, cached: cachedN }, chars: doc.length, cjk: cjk, ms: totalMs, assert: { ok: assertOk, failed: failed, assertPatterns: assertList, forbidPatterns: forbidList, minChars: minChars, minCjk: minCjk } };
  try { fs.writeFileSync(String(outPath) + '.receipt.json', JSON.stringify(receipt, null, 2), 'utf8'); } catch (e) {}
}
if ((!outPath || outPath === true) && !(checkFile && checkFile !== true)) console.log(doc);
process.exit(assertOk ? 0 : 3);
