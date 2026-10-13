#!/usr/bin/env node
// selftest.mjs — 自证：跑真实任务，打印『本地自做 vs 云端外包』对照表。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'cloud-offload.mjs');
const TMP = '/tmp/cloud-offload-selftest';
fs.mkdirSync(TMP, { recursive: true });

const est = (n) => Math.ceil(n / 1.5);

async function health() {
  try { const r = await fetch('http://127.0.0.1:8788/health'); return (await r.json()).ok === true; } catch (e) { return false; }
}

// 造一份长材料（约 4000 字），模拟真实大输入
const materialPath = path.join(TMP, 'material.txt');
const base = '本季度该行业营收同比增长，毛利率小幅回落，主要因原材料价格上行与产品结构变化。';
fs.writeFileSync(materialPath, Array.from({ length: 60 }, (_, i) => '第' + (i + 1) + '条：' + base).join(String.fromCharCode(10)), 'utf8');
const materialChars = fs.statSync(materialPath).size;

const TASKS = [
  { name: 'A 长文创作', args: ['--task', '写一篇 700 字左右、结构清晰的中文短文，主题：云端算力卸载如何降低 AI 使用成本。', '--out', TMP + '/a.md'] },
  { name: 'B 长材料摘要', args: ['--task', '把材料提炼成 6 条要点，每条不超过 40 字。', '--material-file', materialPath, '--out', TMP + '/b.md'] },
  { name: 'C 批量改写', args: ['--task', '把材料改写为 3 个面向大众的短句，语气口语化。', '--material-file', materialPath, '--out', TMP + '/c.md'] },
];

const ok0 = await health();
console.log('云端健康: ' + (ok0 ? 'OK' : 'FAIL'));
if (!ok0) process.exit(1);
console.log('长材料: ' + materialChars + ' 字符');
console.log('');
console.log('任务            | 耗时ms | 产出字符 | 本地自做≈tok | 本地实花≈tok | 省≈tok');
console.log('----------------|--------|----------|--------------|--------------|--------');

let totalSaved = 0;
for (const t of TASKS) {
  const t0 = Date.now();
  let out = '';
  try { out = execFileSync(process.execPath, [TOOL, ...t.args, '--quiet'], { encoding: 'utf8' }); } catch (e) { out = String(e.stdout || '') ; }
  const ms = Date.now() - t0;
  const outFile = t.args[t.args.indexOf('--out') + 1];
  const chars = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').length : 0;
  const usedMaterial = t.args.includes('--material-file');
  const ifLocal = est(t.args[1].length) + est(chars) + (usedMaterial ? est(materialChars) : 0);
  const spent = est(t.args[1].length) + est(60);
  const saved = Math.max(0, ifLocal - spent);
  totalSaved += saved;
  console.log(t.name.padEnd(15) + ' | ' + String(ms).padStart(6) + ' | ' + String(chars).padStart(8) + ' | ' + String(ifLocal).padStart(12) + ' | ' + String(spent).padStart(12) + ' | ' + String(saved).padStart(6));
}
console.log('');
console.log('合计省下 ≈ ' + totalSaved + ' token（本地自做 vs 云端外包）');
