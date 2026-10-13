#!/usr/bin/env node
// cloud-offload.mjs — 云端算力卸载：把『烧 token 的生成/加工』交给云端，本地只花一句指令。
// 核心：--out 模式让长正文直接落盘，本地上下文只收一条极短回执。
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.OFFLOAD_API || 'http://127.0.0.1:8788/v1/chat/completions';
const LEDGER = process.env.OFFLOAD_LEDGER || path.join(process.env.HOME, 'openclaw资产库/cloud-offload/token-ledger.jsonl');
const est = (s) => { const t = String(s == null ? '' : s); let k = 0, x = 0, o = 0; for (const ch of t) { const c = ch.codePointAt(0); if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) k++; else if (c < 128) x++; else o++; } return Math.ceil(k * 1.06 + x * 0.305 + o * 0.9); };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) return true;
  return v;
}

const task = arg('task', '');
const materialFile = arg('material-file', '');
const outPath = arg('out', '');
const sys = arg('system', '');
const quiet = !!arg('quiet', false);

if (!task || task === true) {
  console.log('用法: node cloud-offload.mjs --task "任务" [--material-file 材料文件] [--out 输出文件] [--system 角色指令]');
  process.exit(2);
}

const material = (materialFile && materialFile !== true) ? fs.readFileSync(materialFile, 'utf8') : '';
const prompt = material ? ('【材料】' + String.fromCharCode(10) + material + String.fromCharCode(10, 10) + '【任务】' + String.fromCharCode(10) + task) : String(task);

const t0 = Date.now();
let res, json;
try {
  res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'plain', system: (sys && sys !== true) ? sys : '', messages: [{ role: 'user', content: prompt }] }),
  });
  json = await res.json();
} catch (e) {
  console.log('[offload] ✗ 云端不可达: ' + e.message);
  process.exit(1);
}
const ms = Date.now() - t0;
const text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
const ok = res.status === 200 && !!text;

let written = null;
if (ok && outPath && outPath !== true) {
  fs.mkdirSync(path.dirname(String(outPath)), { recursive: true });
  fs.writeFileSync(String(outPath), text, 'utf8');
  written = String(outPath);
}

const receipt = written ? ('已写入 ' + written + '（' + text.length + ' 字符）') : text;
const taskTok = est(task);
const matTok = est(material);
const outTok = est(text);
const overhead = 60;
const baseline = taskTok + matTok + outTok;
const localSpent = taskTok + est('OK ' + text.length + '字/' + Math.round(ms / 1000) + 's') + overhead;
const saved = Math.max(0, baseline - localSpent);
const ifLocal = baseline;

const entry = { ts: new Date().toISOString(), ok, ms, task_chars: String(task).length, material_chars: material.length, out_chars: text.length, in_tokens: taskTok + matTok, out_tokens: outTok, tool_overhead: overhead, written: written, est_local_tokens_spent: localSpent, est_local_tokens_if_done_locally: ifLocal, est_tokens_saved: saved };
try { fs.appendFileSync(LEDGER, JSON.stringify(entry) + String.fromCharCode(10)); } catch (e) {}

if (!quiet) {
  if (ok) {
    if (written) console.log('[offload] OK 已写入 ' + written + '（' + text.length + ' 字符, ' + ms + 'ms）');
    else console.log('[offload] OK ' + ms + 'ms' + String.fromCharCode(10) + text);
    console.log('[offload] 本地约 ' + localSpent + ' tok | 本地自做约 ' + ifLocal + ' tok | 省约 ' + saved + ' tok');
  } else {
    console.log('[offload] ✗ 失败: ' + JSON.stringify(json).slice(0, 200));
  }
}
process.exit(ok ? 0 : 1);
