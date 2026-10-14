#!/usr/bin/env node
// cloud-offload-job.mjs — 走异步任务接口：POST 提交立即拿到 jobId，再单次阻塞 wait，本地只有两次 HTTP、一轮工具调用。
// 目的：替代『后台跑 + 反复 process poll』（实测一轮 10 段任务要 poll ~20 次，全是本地工具往返）。
// 用法: node cloud-offload-job.mjs --task "<指令>" [--material-file m.txt] [--out o.md] [--type write] [--wait-timeout 300000] [--quiet]
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.OFFLOAD_BASE || 'http://127.0.0.1:8788';
function arg(name, def) { const i = process.argv.indexOf('--' + name); if (i < 0) return def; const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) return true; return v; }
const task = arg('task', '');
const materialFile = arg('material-file', '');
const outPath = arg('out', '');
const type = arg('type', 'write');
const waitTimeout = Number(arg('wait-timeout', 300000)) || 300000;
const quiet = !!arg('quiet', false);
if (!task || task === true) { console.log('用法: node cloud-offload-job.mjs --task "<指令>" [--material-file m.txt] [--out o.md] [--type write] [--wait-timeout 300000]'); process.exit(2); }
const material = (materialFile && materialFile !== true) ? fs.readFileSync(materialFile, 'utf8') : '';
let sub;
try { sub = await (await fetch(BASE + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: String(task), material: material, type: type }) })).json(); }
catch (e) { console.log('[job] ✗ 提交失败: ' + e.message); process.exit(1); }
if (!sub || !sub.id) { console.log('[job] ✗ 提交被拒: ' + JSON.stringify(sub).slice(0, 200)); process.exit(1); }
let r;
try { r = await (await fetch(BASE + '/api/jobs/' + sub.id + '/wait?timeout=' + waitTimeout)).json(); }
catch (e) { console.log('[job] ✗ 等待失败: ' + e.message + '（jobId=' + sub.id + '）'); process.exit(1); }
if (r.status !== 'done') { console.log('[job] ✗ ' + r.status + (r.error ? (': ' + r.error) : '') + '（jobId=' + sub.id + ', ' + r.ms + 'ms）'); process.exit(1); }
const answer = String(r.answer || '');
let written = null;
if (outPath && outPath !== true) { fs.mkdirSync(path.dirname(String(outPath)), { recursive: true }); fs.writeFileSync(String(outPath), answer, 'utf8'); written = String(outPath); }
const ok = !!(answer && r.complete !== false);
console.log('[job] ' + (ok ? 'OK' : '未完成') + '（jobId=' + r.id + ', ' + r.ms + 'ms, ' + answer.length + ' 字符' + (r.truncated ? ', truncated' : '') + '）' + (written ? (' 已写入 ' + written) : ''));
if (!written && !quiet) console.log(answer);
process.exit(ok ? 0 : 1);