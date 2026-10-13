// tests/code-tests.mjs — 代码产物测试：真实语法校验（py/html/json/sql/bash/js/regex）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.OFFLOAD_API_BASE || 'http://127.0.0.1:8788';
const OUT = '/tmp/code-tests';
fs.mkdirSync(OUT, { recursive: true });
const BT = String.fromCharCode(96);
const BT3 = BT + BT + BT;
const NL = String.fromCharCode(10);

const results = [];
function rec(name, ok, ms, detail) { results.push({ name: name, ok: !!ok, ms: ms || 0, detail: detail || '' }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (ms || 0) + 'ms | ' + (detail || '')); }

function stripFence(t) {
  if (t.indexOf(BT3) < 0) return t;
  const parts = t.split(BT3);
  if (parts.length >= 3) {
    let block = parts[1];
    const nl = block.indexOf(NL);
    if (nl >= 0) { const first = block.slice(0, nl).trim(); if (first.length <= 14 && first.indexOf(' ') < 0) block = block.slice(nl + 1); }
    return block.trim();
  }
  return t;
}
function normalizeJson(code) {
  return code.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, '$1');
}
function extract(raw, lang) {
  let t = stripFence(String(raw || '')).trim();
  const marks = {
    python: [/^#/, /^import /, /^from /, /^def /, /^class /, /^@/],
    html: [/^<!doctype/i, /^<html/i],
    json: [/^\{/, /^\[/],
    sql: [/^select\b/i, /^with\b/i],
    bash: [/^#!/, /^set /, /^#/, /^for /, /^if /, /^rm /, /^find /],
    js: [/^function /, /^const /, /^let /, /^var /, /^\/\//, /^export /, /^import /],
  };
  const ms = marks[lang] || [];
  const lines = t.split(NL);
  for (let i = 0; i < lines.length; i++) {
    for (const re of ms) { if (re.test(lines[i].trim())) { let out = lines.slice(i).join(NL).trim(); if (lang === 'json') out = normalizeJson(out); return out; } }
  }
  if (lang === 'json') t = normalizeJson(t);
  return t;
}

async function gen(task, lang) {
  const t0 = Date.now();
  const r = await fetch(API + '/api/offload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: task, type: 'code', model: 'GLM-Flash' }) });
  const j = await r.json();
  const raw = String(j.answer || '');
  const code = extract(raw, lang);
  return { ms: Date.now() - t0, raw: raw, code: code, ok: j.ok !== false, complete: j.complete !== false, cached: !!j.cached };
}

function pyCheck(code) { const f = path.join(OUT, 'a.py'); fs.writeFileSync(f, code); try { execFileSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', f], { stdio: 'pipe' }); return { ok: true }; } catch (e) { return { ok: false, err: String(e.stderr || e.message).slice(0, 160) }; } }
function bashCheck(code) { const f = path.join(OUT, 'a.sh'); fs.writeFileSync(f, code); try { execFileSync('/bin/bash', ['-n', f], { stdio: 'pipe' }); return { ok: true }; } catch (e) { return { ok: false, err: String(e.stderr || e.message).slice(0, 160) }; } }
function jsCheck(code) { const f = path.join(OUT, 'a.js'); fs.writeFileSync(f, code); try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return { ok: true }; } catch (e) { return { ok: false, err: String(e.stderr || e.message).slice(0, 160) }; } }
function htmlCheck(code) { const ok = /<!doctype/i.test(code) && /<\/html>/i.test(code) && /<(div|body|h1|p|svg|canvas)/i.test(code); return { ok: ok, err: ok ? '' : 'missing doctype/close/body' }; }
function jsonCheck(code) { try { const o = JSON.parse(code); return { ok: Array.isArray(o) || typeof o === 'object', err: '' }; } catch (e) { return { ok: false, err: e.message.slice(0, 120) }; } }
function sqlCheck(code) { const ok = /^(select|with)\b/i.test(code.trim()) && /\bfrom\b/i.test(code); return { ok: ok, err: ok ? '' : 'not a SELECT' }; }
function regexCheck(code) { const m = code.match(/\/(.+)\/([gimsuy]*)/); if (!m) return { ok: false, err: 'no literal' }; try { new RegExp(m[1], m[2]); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } }

async function main() {
  const cases = [
    { name: 'python 函数', lang: 'python', check: pyCheck, task: '写一个 Python 函数 is_prime(n: int) -> bool，用试除法判断素数。只输出代码，不要任何解释。' },
    { name: 'python 类', lang: 'python', check: pyCheck, task: '写一个 Python 类 LRUCache，基于 collections.OrderedDict，实现 get(key) 和 put(key, value)，容量固定。只输出代码。' },
    { name: 'html 页面', lang: 'html', check: htmlCheck, task: '写一个单文件 HTML 页面：一个 CSS 动画的加载转圈（spinner），居中显示。只输出 HTML 源码，不要解释。' },
    { name: 'json 数据', lang: 'json', check: jsonCheck, task: '只输出一个 JSON 数组，包含 3 个对象，每个对象有 name(string)、age(number)、tags(array) 三个字段。必须使用 ASCII 双引号（"），禁止中文引号。不要解释、不要代码围栏。' },
    { name: 'sql 查询', lang: 'sql', check: sqlCheck, task: '只输出一条 SQL：从 users 表选出 age >= 18 的记录，按 created_at 倒序，取前 10 条。不要解释。' },
    { name: 'bash 脚本', lang: 'bash', check: bashCheck, task: '写一个 bash 脚本：删除 /tmp 目录下 7 天前的 .log 文件。只输出脚本，不要解释。' },
    { name: 'javascript 函数', lang: 'js', check: jsCheck, task: '写一个 JavaScript 函数 debounce(fn, wait)，返回防抖后的函数。只输出代码。' },
    { name: '正则表达式', lang: 'regex', check: regexCheck, task: '只输出一个 JavaScript 正则字面量（形如 /.../ ），用于匹配邮箱地址。不要解释、不要代码围栏。' },
  ];

  for (const c of cases) {
    let g;
    try { g = await gen(c.task, c.lang); }
    catch (e) { rec('gen ' + c.name, false, 0, '请求失败 ' + e.message); continue; }
    let v;
    try { v = c.check(g.code); } catch (e) { v = { ok: false, err: String(e.message).slice(0, 120) }; }
    rec(c.name, g.ok && v.ok, g.ms, 'len=' + g.code.length + (g.cached ? ' 缓存' : '') + (v.ok ? '' : (' 校验失败: ' + v.err)));
    if (!v.ok) { try { fs.writeFileSync(path.join(OUT, c.lang + '-fail.txt'), g.raw); } catch (e) {} }
  }

  const passed = results.filter(function (x) { return x.ok; }).length;
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, passed: passed, failed: results.length - passed }));
}
main().catch(function (e) { console.log('FATAL ' + e.message); });
