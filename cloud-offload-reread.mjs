#!/usr/bin/env node
// cloud-offload-reread.mjs — 诚实记账：把『本地为核对/交付又把云端产出读回上下文』的字符数记入账本。
// 用法: node cloud-offload-reread.mjs --chars <读回字符数> [--what "说明"] [--tok <显式token>]
import fs from 'node:fs';
import path from 'node:path';
const LEDGER = process.env.OFFLOAD_LEDGER || path.join(process.env.HOME, 'openclaw资产库/cloud-offload/token-ledger.jsonl');
function arg(name, def) { const i = process.argv.indexOf('--' + name); if (i < 0) return def; const v = process.argv[i + 1]; if (v === undefined || String(v).startsWith('--')) return true; return v; }
const chars = Number(arg('chars', 0)) || 0;
const tokArg = Number(arg('tok', 0)) || 0;
const what = arg('what', '');
if (!chars && !tokArg) { console.log('用法: node cloud-offload-reread.mjs --chars <读回字符数> [--what "说明"] [--tok <显式token>]'); process.exit(2); }
const reTok = tokArg || Math.ceil(chars / 1.5);
const entry = { ts: new Date().toISOString(), kind: 'reread', re_read_chars: chars, re_read_tok: reTok, what: (what && what !== true) ? String(what) : '' };
try { fs.appendFileSync(LEDGER, JSON.stringify(entry) + String.fromCharCode(10)); } catch (e) { console.log('[reread] 写账本失败: ' + e.message); process.exit(1); }
console.log('[reread] 已记账 ' + chars + ' 字符 ≈ ' + reTok + ' tok' + (entry.what ? ('（' + entry.what + '）') : ''));