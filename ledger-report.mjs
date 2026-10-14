#!/usr/bin/env node
// ledger-report.mjs — 汇总 token-ledger.jsonl 的累计节省。
import fs from 'node:fs';
import path from 'node:path';
const LEDGER = process.env.OFFLOAD_LEDGER || path.join(process.env.HOME, 'openclaw资产库/cloud-offload/token-ledger.jsonl');
if (!fs.existsSync(LEDGER)) { console.log('暂无账本: ' + LEDGER); process.exit(0); }
const rows = fs.readFileSync(LEDGER, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const ok = rows.filter((r) => r.ok);
const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
const saved = sum('est_tokens_saved');
const would = sum('est_local_tokens_if_done_locally');
const spent = sum('est_local_tokens_spent');
const callRows = rows.filter((r) => r.kind !== 'reread');
const rereadRows = rows.filter((r) => r.kind === 'reread');
const rereadChars = rereadRows.reduce((a, r) => a + (r.re_read_chars || 0), 0);
const rereadTok = rereadRows.reduce((a, r) => a + (r.re_read_tok != null ? r.re_read_tok : Math.ceil((r.re_read_chars || 0) / 1.5)), 0);
const net = saved - rereadTok;
console.log('调用次数      : ' + callRows.length + '（成功 ' + ok.length + '）');
console.log('云端产出字符  : ' + sum('out_chars'));
console.log('本地实花≈tok  : ' + spent);
console.log('本地自做≈tok  : ' + would);
console.log('毛省≈tok      : ' + saved);
console.log('本地回读≈tok  : ' + rereadTok + '（' + rereadChars + ' 字符, ' + rereadRows.length + ' 次）');
console.log('净省≈tok      : ' + net);
console.log('净节省率      : ' + (would > 0 ? (100 * net / would).toFixed(1) : '0') + '%');
