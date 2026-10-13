#!/usr/bin/env node
// cloud-offload-api.mjs v2 — 本地网关：CDP 驱动 Edge 里的 chatglm.cn，带前端/设置/统计/防封轮换。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.API_PORT || 8788);
const readTok = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; } };
const TOKEN = readTok(path.join(process.env.HOME, '.cloud-offload-token')) || 'glm-edge-token';
let BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:8787';
if (BRIDGE.endsWith('/')) BRIDGE = BRIDGE.slice(0, -1);
const SETTINGS_FILE = path.join(HERE, 'settings.json');
const LEDGER = path.join(HERE, 'token-ledger.jsonl');
const CACHE_FILE = path.join(HERE, 'cache.json');
let CACHE = {}; try { CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { CACHE = {}; }
function cacheSave() { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE)); } catch (e) {} }
const PUBLIC = path.join(HERE, 'public');
const MAX_TURNS = Number(process.env.MAX_TOOL_TURNS || 4);
let STABLE_MS = Number(process.env.STABLE_MS || 4500);
let POLL_MS = Number(process.env.POLL_MS || 900);
const ANSWER_TIMEOUT_MS = Number(process.env.ANSWER_TIMEOUT_MS || 300000);
const BT3 = String.fromCharCode(96, 96, 96);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SETTINGS = {
  provider: 'chatglm',
  model: 'GLM-Flash',
  rotation: ['GLM-Flash', 'GLM-5.3'],
  antiBan: true,
  minIntervalMs: 15000,
  dailyCap: 400,
  performanceMode: 'balanced',
  taskType: 'auto',
  policy: {
    enabled: true,
    preset: 'balanced',
    threshold: 800,
    allowTypes: { write: true, summary: true, translate: true, rewrite: true, code: true, tag: true, chat: false },
    protectSensitive: true,
    protectInteractive: true,
    notifyOnCloud: false,
    windowStart: '',
    windowEnd: '',
    savedTarget: 0,
  },
};
let settings = { ...DEFAULT_SETTINGS };
try { if (fs.existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) {}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8'); } catch (e) {} }
function deepMerge(base, patch) { const out = Object.assign({}, base); for (const k of Object.keys(patch || {})) { const v = patch[k]; if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v); else out[k] = v; } return out; }
function applyTuning() { if (settings.stableMs) STABLE_MS = Number(settings.stableMs); if (settings.pollMs) POLL_MS = Number(settings.pollMs); }

applyTuning();
const state = { rotIdx: 0, lastCallAt: 0, todayCount: 0, todayKey: new Date().toISOString().slice(0, 10), currentModel: settings.model, logs: [] };

function pushLog(o) { state.logs.unshift({ ts: new Date().toISOString(), ...o }); state.logs = state.logs.slice(0, 200); }

const j = async (u, opt) => { const r = await fetch(u, opt); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } };

async function pickPage() {
  const list = await j(CDP + '/json/list');
  const arr = Array.isArray(list) ? list : [];
  const p = arr.find((t) => t.type === 'page' && /chatglm[.]cn/.test(t.url || ''));
  if (!p) throw new Error('没有 chatglm.cn 页面');
  return p;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    ws.addEventListener('open', () => resolve({ ws, cmd: (method, params) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => { pend.delete(i); rej(new Error('CDP 调用超时: ' + method)); }, 20000); pend.set(i, (m) => { clearTimeout(to); res(m); }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }) }));
    ws.addEventListener('error', reject);
  });
}

async function evalJs(cmd, expression) {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const res = r && r.result;
  if (res && res.exceptionDetails) throw new Error('eval failed');
  return res && res.result ? res.result.value : undefined;
}

const COUNT = '(() => document.querySelectorAll(".answer-content-wrap").length)()';
const LAST = '(() => { const a = document.querySelectorAll(".answer-content-wrap"); return a.length ? a[a.length - 1].innerText : ""; })()';
const STATE = '(() => { const a = document.querySelectorAll(".answer-content-wrap"); const w = a.length ? a[a.length - 1] : null; const cls = w ? String(w.className) : ""; const thinking = /thinking/i.test(cls); let reg = false; if (w) { let box = w.parentElement; for (let d = 0; d < 4 && box; d++) { if (box.querySelector && box.querySelector(".regenerate-part,.regenerate")) { reg = true; break; } box = box.parentElement; } } const stop = Array.from(document.querySelectorAll("div,span,button,i")).find((e) => e.offsetParent && /^(停止|停止生成|停止回答)$/.test((e.textContent || "").trim())); const st = w ? w.innerText : ""; const busyText = /生成中|正在生成|思考中|Generating/.test(st); const statusOnly = st.length < 40 && /生成|代码/.test(st); const ps = document.querySelectorAll("pre"); const preLen = ps.length ? ps[ps.length - 1].innerText.length : 0; return JSON.stringify({ n: a.length, thinking: thinking, reg: reg, busyText: busyText, statusOnly: statusOnly, preLen: preLen, len: st.length, stop: !!stop }); })()';
const TYPE_SYS = {
  write: '你是中文写作引擎。输出成篇正文，结构清晰，不要解释。',
  summary: '你是摘要引擎。输出要点列表，每条不超过 40 字，不要解释。',
  translate: '你是翻译引擎。输出译文本身，不要注释、不要原文。',
  rewrite: '你是改写引擎。输出改写后的文本，不要解释。',
  tag: '你是分类引擎。输出标签或类别，一行一个，不要解释。',
};
const PLAIN_SYSTEM = '【角色】你是纯文本创作/加工引擎。只输出成品本身；禁止输出思考过程、推理、计划、要求复述或英文分析；不要询问；不要调用任何工具。' + NL + NL + '【任务】' + NL;
const AGENT_SYSTEM = '【系统指令】需要调用本机工具时，只输出一个 JSON 对象：' + BT3 + 'bridge' + NL + '{"name":"工具名","args":{...}}' + NL + BT3 + ' 可用：run_shell{cmd}/read_file{path}/write_file{path,content}/list_dir{path}/http_get{url}。结果以 ' + BT3 + 'bridge-result 回给你。' + NL + NL + '【用户】' + NL;

async function switchModel(cmd, name) {
  if (!name) return false;
  try {
    const cur = await evalJs(cmd, '(document.body.innerText||"")');
    if (cur && cur.includes(name)) return true;
    await evalJs(cmd, '(() => { const els = Array.from(document.querySelectorAll("[class*=model],button,div")); const t = els.find((e) => /GLM-/.test(e.textContent||"") && (e.textContent||"").length < 40 && e.offsetParent); if (t) { t.click(); return "open"; } return "no-btn"; })()');
    await sleep(800);
    const hit = await evalJs(cmd, '(() => { const want = ' + JSON.stringify(String(name)) + '; const els = Array.from(document.querySelectorAll("div,span,li")); const t = els.find((e) => (e.textContent||"").trim() === want && e.offsetParent); if (t) { t.click(); return "ok"; } return "miss"; })()');
    await sleep(600);
    return hit === 'ok';
  } catch (e) { return false; }
}

async function resetChat(cmd) {
  try {
    await cmd('Page.navigate', { url: 'https://chatglm.cn/main/alltoolsdetail' });
    for (let i = 0; i < 40; i++) { await sleep(400); const ok = await evalJs(cmd, '(!!document.querySelector("textarea"))'); if (ok) { await sleep(800); return true; } }
  } catch (e) {}
  return false;
}

async function askGLM(prompt, mode, system, model) {
  const page = await pickPage();
  const { ws, cmd } = await connect(page.webSocketDebuggerUrl);
  try {
    await cmd('Runtime.enable');
    const cntNow = (await evalJs(cmd, COUNT)) || 0;
    if (cntNow > 36) { const ok = await resetChat(cmd); pushLog({ kind: 'reset', n: cntNow, ok: ok }); }
    let switched = null;
    if (model) { switched = await switchModel(cmd, model); state.currentModel = model; }
    const text = (system || (mode === 'plain' ? PLAIN_SYSTEM : AGENT_SYSTEM)) + prompt;
    const setExpr = '(() => { const ta = document.querySelector("textarea"); if (!ta) return "no-textarea"; const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; s.call(ta, ' + JSON.stringify(text) + '); ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); return "ok"; })()';
    const setRes = await evalJs(cmd, setExpr);
    if (setRes !== 'ok') throw new Error('设置输入框失败: ' + setRes);
    await sleep(300);
    const n0 = (await evalJs(cmd, COUNT)) || 0;
    const t0 = Date.now();
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: CR, unmodifiedText: CR });
    await cmd('Input.dispatchKeyEvent', { type: 'char', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: CR, unmodifiedText: CR });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    let lastLen = -1, lastChange = Date.now(), started = false, done = false, sawBusy = false;
    const hardDeadline = t0 + ANSWER_TIMEOUT_MS;
    while (Date.now() < hardDeadline) {
      await sleep(POLL_MS);
      let s = {};
      try { s = JSON.parse((await evalJs(cmd, STATE)) || '{}'); } catch (e) { s = {}; }
      const n = s.n || 0, thinking = !!s.thinking, reg = !!s.reg, len = s.len || 0, stop = !!s.stop, busyText = !!s.busyText, statusOnly = !!s.statusOnly, preLen = s.preLen || 0;
      const waitingCode = statusOnly && preLen < 20;
      if (n > n0) started = true;
      if (thinking || stop || busyText || waitingCode) sawBusy = true;
      if (started) {
        if (thinking || stop || busyText || waitingCode) { lastChange = Date.now(); lastLen = len; }
        else if (reg) { done = true; break; }
        else if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
        else if (Date.now() - lastChange > STABLE_MS * 4) { done = true; break; }
      }
    }
    if (!started) throw new Error('未检测到回答开始（页面可能未登录或改版）');
    let ans = ((await evalJs(cmd, LAST)) || '').trim();
    if (ans.length < 40 && /生成|代码/.test(ans)) { const pre = await evalJs(cmd, '(()=>{const a=document.querySelectorAll("pre");return a.length?a[a.length-1].innerText.trim():"";})()'); if (pre && pre.length > ans.length) ans = String(pre).trim(); }
    const mk = ans.lastIndexOf('思考结束');
    if (mk >= 0) ans = ans.slice(mk + 4).trim();
    const mk2 = ans.lastIndexOf('深度思考');
    if (mk2 >= 0 && mk2 < 40) ans = ans.slice(mk2 + 4).trim();
    return { answer: ans, ms: Date.now() - t0, switched, complete: done, truncated: !done, sawBusy };
  } finally { try { ws.close(); } catch (e) {} }
}

async function callBridge(name, args) { return await j(BRIDGE + '/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args: args || {} }) }); }

function extractCall(text) {
  const t = String(text || '');
  const fence = t.match(new RegExp(BT3 + 'bridge([^]*?)' + BT3));
  if (fence) { try { const o = JSON.parse(fence[1]); if (o && o.name) return o; } catch (e) {} }
  for (let i = 0; i < t.length; i++) {
    if (t.charAt(i) !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < t.length; k++) {
      const ch = t.charAt(k);
      if (inStr) { if (esc) esc = false; else if (ch === BS) esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(t.slice(i, k + 1)); if (o && o.name) return o; } catch (e) {} break; } }
    }
  }
  return null;
}

let CHAIN = Promise.resolve();
function withLock(fn) { const run = CHAIN.then(fn, fn); CHAIN = run.then(() => {}, () => {}); return run; }

function nextModel() {
  const rot = Array.isArray(settings.rotation) && settings.rotation.length ? settings.rotation : [settings.model];
  if (!settings.antiBan) return settings.model;
  state.rotIdx = (state.rotIdx + 1) % rot.length;
  return rot[state.rotIdx];
}
async function pace() {
  if (!settings.antiBan) return;
  const wait = settings.minIntervalMs - (Date.now() - state.lastCallAt);
  if (wait > 0) await sleep(wait);
}
function bumpDaily() { const k = new Date().toISOString().slice(0, 10); if (k !== state.todayKey) { state.todayKey = k; state.todayCount = 0; } state.todayCount++; }

async function offload(task, material, opts) {
  opts = opts || {};
  if (!String(task || '').trim() && !String(material || '').trim()) throw new Error('空任务：task 与 material 均为空');
  return withLock(async () => {
    if (settings.antiBan && state.todayCount >= settings.dailyCap) throw new Error('已达每日上限 ' + settings.dailyCap + '（防封号）');
    await pace();
    const model = opts.model || nextModel();
    const prompt = material ? ('【材料】' + NL + material + NL + NL + '【任务】' + NL + task) : task;
    const ckey = crypto.createHash('sha1').update(task + String.fromCharCode(1) + material + String.fromCharCode(1) + model + String.fromCharCode(1) + (opts.system || '')).digest('hex');
    let r, fromCache = false;
    if (settings.cache !== false && CACHE[ckey]) { r = { answer: CACHE[ckey], ms: 0, switched: false, complete: true, truncated: false }; fromCache = true; }
    else { r = await askGLM(prompt, opts.agent ? 'agent' : 'plain', opts.system || '', model); if (r.answer && r.complete !== false) { CACHE[ckey] = r.answer; cacheSave(); } }
    state.lastCallAt = Date.now(); if (!fromCache) bumpDaily();
    let answer = r.answer;
    if (opts.agent) {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const call = extractCall(answer);
        if (!call) break;
        const res = await callBridge(call.name, call.args);
        const r2 = await askGLM(BT3 + 'bridge-result' + NL + JSON.stringify(res) + NL + BT3 + NL + '请继续。', 'agent', '', model);
        answer = r2.answer;
      }
    }
    const est = (s) => { const t = String(s == null ? '' : s); let k = 0, x = 0, o = 0; for (const ch of t) { const c = ch.codePointAt(0); if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) k++; else if (c < 128) x++; else o++; } return Math.ceil(k * 1.06 + x * 0.305 + o * 0.9); };
    const inTok = est(task) + est(material);
    const outTok = est(answer);
    const savedTok = inTok + outTok;
    const receipt = 'OK ' + answer.length + '字/' + Math.round(r.ms / 1000) + 's';
    const spent = est(receipt);
    const ifLocal = savedTok + spent;
    const row = { ts: new Date().toISOString(), ok: !!answer, ms: r.ms, model, out_chars: answer.length, material_chars: (material || '').length, in_tokens: inTok, out_tokens: outTok, est_tokens_saved: savedTok, est_local_tokens_spent: spent, est_local_tokens_if_done_locally: ifLocal, cached: fromCache, switched: r.switched, truncated: !!r.truncated, complete: r.complete !== false };
    try { fs.appendFileSync(LEDGER, JSON.stringify(row) + NL); } catch (e) {}
    pushLog({ kind: 'offload', model, ms: r.ms, out: answer.length, saved: row.est_tokens_saved });
    return { answer, row, complete: r.complete !== false, truncated: !!r.truncated };
  });
}

function ledgerStats() {
  let rows = [];
  try { rows = fs.readFileSync(LEDGER, 'utf8').split(NL).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const byModel = {};
  for (const r of rows) { const m = r.model || '?'; byModel[m] = byModel[m] || { calls: 0, ms: 0, out: 0, saved: 0 }; byModel[m].calls++; byModel[m].ms += r.ms || 0; byModel[m].out += r.out_chars || 0; byModel[m].saved += r.est_tokens_saved || 0; }
  const byModelArr = Object.entries(byModel).map(([m, v]) => ({ model: m, calls: v.calls, avg_ms: Math.round(v.ms / v.calls), out: v.out, saved: v.saved }));
  const cloudN = ROUTE_LOG.filter((d) => d.use === 'cloud').length; const localN = ROUTE_LOG.filter((d) => d.use === 'local').length;
  return { routeCloud: cloudN, routeLocal: localN, calls: rows.length, ok: rows.filter((r) => r.ok).length, out_chars: sum('out_chars'), spent: sum('est_local_tokens_spent'), would: sum('est_local_tokens_if_done_locally'), saved: sum('est_tokens_saved'), byModel: byModelArr, recent: rows.slice(-40) };
}

const ROUTE_LOG = [];
function decideRoute(q) {
  const p = settings.policy || {};
  const est = Number(q.est || 0);
  const type = String(q.type || 'auto');
  const sensitive = String(q.sensitive) === 'true';
  const interactive = String(q.interactive) === 'true';
  let use = 'cloud'; let reason = '预计 ' + est + ' tok 值得外包'; let code = 'worth_offloading';
  if (!p.enabled) { use = 'local'; reason = '总开关关闭'; code = 'master_off'; }
  else if (sensitive && p.protectSensitive) { use = 'local'; reason = '含敏感信息（保护规则）'; code = 'sensitive'; }
  else if (interactive && p.protectInteractive) { use = 'local'; reason = '用户正在等待（交互态）'; code = 'interactive'; }
  else if (p.allowTypes && p.allowTypes[type] === false) { use = 'local'; reason = '类型 ' + type + ' 已禁用外包'; code = 'type_disabled'; }
  else if (est < (p.threshold || 800)) { use = 'local'; reason = '预计仅 ' + est + ' tok < 阈值 ' + (p.threshold || 800); code = 'below_threshold'; }
  else if (settings.antiBan && state.todayCount >= settings.dailyCap) { use = 'local'; reason = '今日额度已用完（防封号）'; code = 'quota'; }
  else if (p.windowStart && p.windowEnd) { const h = new Date().getHours(); const a = Number(p.windowStart.slice(0,2)); const b = Number(p.windowEnd.slice(0,2)); const inWin = a <= b ? (h >= a && h < b) : (h >= a || h < b); if (!inWin) { use = 'local'; reason = '不在允许时段 ' + p.windowStart + '-' + p.windowEnd; code = 'window'; } }
  else if (p.savedTarget > 0) { const st = ledgerStats(); if (st.saved >= p.savedTarget) { use = 'local'; reason = '已达今日省 token 目标 ' + p.savedTarget; code = 'target_reached'; } }
  const rec = { ts: new Date().toISOString(), est, type, sensitive, interactive, use, reason, code };
  ROUTE_LOG.unshift(rec); ROUTE_LOG.length = Math.min(ROUTE_LOG.length, 200);
  return rec;
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const out = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); });
const isLocalReq = (req) => { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return out(res, 200, { ok: true, service: 'cloud-offload-api', cdp: CDP, bridge: BRIDGE, model: state.currentModel });
  if (url.pathname === '/' || url.pathname === '/index.html') { try { const h = fs.readFileSync(path.join(PUBLIC, 'index.html')); res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); return res.end(h); } catch (e) { return out(res, 404, { ok: false, error: 'no ui' }); } }
  if (String(req.headers['authorization'] || '') !== 'Bearer ' + TOKEN && !isLocalReq(req)) return out(res, 401, { ok: false, error: 'unauthorized' });
  if (url.pathname === '/v1/models') return out(res, 200, { object: 'list', data: (settings.rotation || ['GLM-Flash']).map((m) => ({ id: m, object: 'model', owned_by: 'chatglm.cn' })) });
  if (url.pathname === '/api/settings' && req.method === 'GET') return out(res, 200, { ok: true, settings, state: { currentModel: state.currentModel, todayCount: state.todayCount, rotIdx: state.rotIdx } });
  if (url.pathname === '/api/settings' && req.method === 'POST') { try { const b = JSON.parse(await readBody(req)); settings = deepMerge(settings, b); applyTuning(); saveSettings(); pushLog({ kind: 'settings', payload: b }); return out(res, 200, { ok: true, settings }); } catch (e) { return out(res, 400, { ok: false, error: String(e.message) }); } }
  if (url.pathname === '/api/stats') return out(res, 200, { ok: true, stats: ledgerStats(), state: { todayCount: state.todayCount, dailyCap: settings.dailyCap, antiBan: settings.antiBan, currentModel: state.currentModel } });
  if (url.pathname === '/api/logs') return out(res, 200, { ok: true, logs: state.logs });
  if (url.pathname === '/api/health-full') { let cdp = false, page = 0; try { const v = await j(CDP + '/json/version'); cdp = !!(v && v.Browser); const l = await j(CDP + '/json/list'); page = (Array.isArray(l) ? l : []).filter((t) => t.type === 'page' && /chatglm[.]cn/.test(t.url || '')).length; } catch (e) {} return out(res, 200, { ok: true, cdp, glmPages: page }); }
  if (url.pathname === '/api/offload' && req.method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return out(res, 400, { ok: false, error: 'bad json' }); }
    try { const sys = b.system || TYPE_SYS[b.type] || ''; const r = await offload(String(b.task || ''), String(b.material || ''), { model: b.model, agent: b.agent, system: sys }); return out(res, 200, { ok: true, answer: r.answer, metrics: r.row, complete: r.complete, truncated: r.truncated }); }
    catch (e) { pushLog({ kind: 'error', error: String(e.message) }); return out(res, 200, { ok: false, error: String(e.message) }); }
  }
  if ((url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return out(res, 400, { ok: false, error: 'bad json' }); }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const prompt = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(NL + NL) || String(body.prompt || '');
    try {
      const mode = String(body.mode || 'plain');
      if (mode === 'plain') { const r = await offload(prompt, '', { model: body.model }); const created = Math.floor(Date.now() / 1000); return out(res, 200, { id: 'chatcmpl-' + created, object: 'chat.completion', created, model: state.currentModel, choices: [{ index: 0, message: { role: 'assistant', content: r.answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }); }
      const r = await withLock(() => askGLM(prompt, 'agent', '', body.model));
      const created = Math.floor(Date.now() / 1000);
      return out(res, 200, { id: 'chatcmpl-' + created, object: 'chat.completion', created, model: state.currentModel, choices: [{ index: 0, message: { role: 'assistant', content: r.answer }, finish_reason: 'stop' }] });
    } catch (e) { return out(res, 200, { ok: false, error: String(e && e.message || e) }); }
  }
  if (url.pathname === '/api/write' && req.method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return out(res, 400, { ok: false, error: 'bad json' }); }
    try { const p = String(b.path || ''); if (!p) throw new Error('缺 path'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(b.content || ''), 'utf8'); pushLog({ kind: 'write', model: '', ms: 0, out: String(b.content || '').length, saved: 0 }); return out(res, 200, { ok: true, path: p, chars: String(b.content || '').length }); }
    catch (e) { return out(res, 200, { ok: false, error: String(e.message) }); }
  }
  if (url.pathname === '/api/reset' && req.method === 'POST') { try { const page = await pickPage(); const { ws, cmd } = await connect(page.webSocketDebuggerUrl); let ok = false; try { await cmd('Runtime.enable'); ok = await resetChat(cmd); } finally { try { ws.close(); } catch (e) {} } return out(res, 200, { ok: ok }); } catch (e) { return out(res, 200, { ok: false, error: String(e.message) }); } }
  if (url.pathname === '/api/cache' && req.method === 'GET') return out(res, 200, { ok: true, size: Object.keys(CACHE).length, enabled: settings.cache !== false });
  if (url.pathname === '/api/cache' && req.method === 'DELETE') { CACHE = {}; cacheSave(); return out(res, 200, { ok: true, size: 0 }); }
  if (url.pathname === '/api/route') return out(res, 200, { ok: true, decision: decideRoute(Object.fromEntries(url.searchParams)) });
  if (url.pathname === '/api/decisions') return out(res, 200, { ok: true, decisions: ROUTE_LOG.slice(0, 30) });
  return out(res, 404, { ok: false, error: 'not found' });
}).listen(PORT, '127.0.0.1', () => {
  console.log('[cloud-offload] http://127.0.0.1:' + PORT + '/  (UI: /index.html)');
  console.log('[cloud-offload] CDP=' + CDP + '  BRIDGE=' + BRIDGE + '  MODEL=' + settings.model);
});
