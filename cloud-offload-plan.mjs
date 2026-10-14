#!/usr/bin/env node
// cloud-offload-plan.mjs — 把「拆分/规划」也外包给云端：本地只给一句 brief，收回一个 plan.json（供 batch 使用）。
// 用法: node cloud-offload-plan.mjs --brief "写一篇5000字的将进酒" --parts 9 [--type write] [--out /tmp/plan.json]
//       自检: node cloud-offload-plan.mjs --selftest
import fs from 'node:fs';
import path from 'node:path';
const API = process.env.OFFLOAD_API || 'http://127.0.0.1:8788/api/offload';
function arg(name, def) { const i = process.argv.indexOf('--' + name); if (i < 0) return def; const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) return true; return v; }
const brief = arg('brief', '');
const partsN = Number(arg('parts', 0)) || 0;
const type = arg('type', 'write');
const outPath = arg('out', '');
const title = arg('title', '');
const selftest = !!arg('selftest', false);

function buildTask(n) {
  return '你是内容规划器。请把下面这个写作需求拆成 ' + n + ' 个「互相独立、自包含」的章节。每个章节的 task 必须能单独执行（不依赖其它章节），并写清该章的文体要求与大致字数。' + String.fromCharCode(10) + '只输出一个 JSON 对象，不要任何解释、不要代码块围栏。结构：' + String.fromCharCode(10) + '{"title":"总标题","type":"write","parts":[{"heading":"章节标题","task":"该章的自包含指令"}]}' + String.fromCharCode(10,10) + '写作需求：' + brief;
}

function parsePlan(text) {
  let s = String(text == null ? '' : text).trim();
  const fence = s.match(/```(?:json)?[ \t]*[\s\S]*?```/);
  if (fence) s = s.slice(fence.index + fence[0].indexOf(String.fromCharCode(10)) + 1, fence.index + fence[0].lastIndexOf('```')).trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  let o; try { o = JSON.parse(s); } catch (e) { return { ok: false, err: 'JSON 解析失败: ' + e.message }; }
  if (!o || !Array.isArray(o.parts) || !o.parts.length) return { ok: false, err: '缺少 parts 数组' };
  const parts = o.parts.filter((p) => p && p.heading && p.task).map((p) => ({ heading: String(p.heading), task: String(p.task) }));
  if (parts.length !== o.parts.length) return { ok: false, err: '有章节缺少 heading/task' };
  return { ok: true, plan: { title: o.title || title || '未命名', type: o.type || type, parts: parts } };
}

if (selftest) {
  const fixture = '好的，下面是计划：' + String.fromCharCode(10) + '```json' + String.fromCharCode(10) + '{"title":"测试","type":"write","parts":[{"heading":"一","task":"写一段"},{"heading":"二","task":"写两段"}]}' + String.fromCharCode(10) + '```';
  const r = parsePlan(fixture);
  const bad = parsePlan('这不是 JSON');
  const okPass = r.ok && r.plan.parts.length === 2 && bad.ok === false;
  console.log('[selftest] ' + (okPass ? 'PASS' : 'FAIL') + ' | good=' + JSON.stringify(r.ok) + ' parts=' + (r.plan ? r.plan.parts.length : '-') + ' | bad=' + JSON.stringify(bad.ok) + ' (' + (bad.err||'') + ')');
  process.exit(okPass ? 0 : 1);
}

if (!brief || brief === true) { console.log('用法: node cloud-offload-plan.mjs --brief "<写作需求>" --parts <N> [--type write] [--out plan.json]  |  --selftest'); process.exit(2); }
if (!partsN || partsN < 1) { console.log('需要 --parts <N>（正整数）'); process.exit(2); }

let lastErr = '';
for (let attempt = 1; attempt <= 2; attempt++) {
  let j = {};
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: buildTask(partsN), type: type, model: undefined }) });
    j = await r.json();
  } catch (e) { lastErr = '云端不可达: ' + e.message; continue; }
  if (j && j.ok === false) { lastErr = '云端失败: ' + (j.error || ''); continue; }
  const p = parsePlan(j.answer || '');
  if (!p.ok) { lastErr = p.err; continue; }
  if (p.plan.parts.length !== partsN) { lastErr = '章节数 ' + p.plan.parts.length + ' != 要求 ' + partsN; }
  const json = JSON.stringify(p.plan, null, 2);
  if (outPath && outPath !== true) { fs.mkdirSync(path.dirname(String(outPath)), { recursive: true }); fs.writeFileSync(String(outPath), json, 'utf8'); console.log('[plan] OK 章节=' + p.plan.parts.length + ', title=' + p.plan.title + ', 已写入 ' + outPath); }
  else console.log(json);
  process.exit(0);
}
console.log('[plan] FAIL ' + lastErr);
process.exit(4);