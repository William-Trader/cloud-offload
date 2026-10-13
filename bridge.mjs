#!/usr/bin/env node
/**
 * 本地 Agent 桥 · Local Agent Bridge
 * 零依赖 Node HTTP 服务：让 ChatGLM 网页（经用户脚本）把"工具调用"转交本机执行。
 *
 * 启动:  node bridge.mjs
 * 鉴权:  Authorization: Bearer <TOKEN>   (TOKEN 打印在启动日志；或环境变量 BRIDGE_TOKEN)
 * 端点:  GET  /health
 *        GET  /tools
 *        POST /tool   { "name": "...", "args": {...} }
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN = (() => { try { return fs.readFileSync(process.env.HOME + '/.cloud-offload-token', 'utf8').trim(); } catch (e) { return 'devtoken-abc123'; } })();
const WORKDIR = process.env.BRIDGE_WORKDIR || process.env.HOME || '/tmp';
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 20000);
const MAX_OUT = Number(process.env.BRIDGE_MAX_OUT || 20000);

const sh = (cmd, opts = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile('/bin/zsh', ['-lc', cmd], { cwd: opts.cwd || WORKDIR, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 8 },
    (err, stdout, stderr) => {
      let out = String(stdout || '');
      if (stderr) out += (out ? '\n' : '') + String(stderr);
      if (err && !out) out = String(err.message || err);
      if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + '\n...[截断]';
      resolve({ exitCode: err && typeof err.code === 'number' ? err.code : 0, out, ms: Date.now() - t0 });
    });
});

const tools = {
  run_shell: { desc: '在本机执行一条 shell 命令（zsh -lc）。危险：拥有当前用户全部权限。', args: { cmd: 'string' },
    run: async (a) => { if (!a.cmd) throw new Error('缺少 cmd'); const r = await sh(String(a.cmd)); return { exit_code: r.exitCode, ms: r.ms, output: r.out }; } },
  read_file: { desc: '读取文本文件（≤256KB）。', args: { path: 'string' },
    run: async (a) => { const { readFile } = await import('node:fs/promises'); const s = await readFile(String(a.path), 'utf8'); return { path: a.path, content: s.slice(0, 262144) }; } },
  write_file: { desc: '写入文本文件。', args: { path: 'string', content: 'string' },
    run: async (a) => { const { writeFile, mkdir } = await import('node:fs/promises'); const p = String(a.path); const d = p.replace(/\/[^/]*$/, ''); if (d) await mkdir(d, { recursive: true }); await writeFile(p, String(a.content ?? ''), 'utf8'); return { path: p, bytes: Buffer.byteLength(String(a.content ?? '')) }; } },
  list_dir: { desc: '列目录。', args: { path: 'string' },
    run: async (a) => { const { readdir } = await import('node:fs/promises'); const es = await readdir(String(a.path || WORKDIR), { withFileTypes: true }); return { path: a.path || WORKDIR, entries: es.map(e => (e.isDirectory() ? e.name + '/' : e.name)).slice(0, 500) }; } },
  http_get: { desc: 'GET 一个 URL 并返回前 64KB 文本。', args: { url: 'string' },
    run: async (a) => { const res = await fetch(String(a.url), { signal: AbortSignal.timeout(TIMEOUT_MS) }); const t = await res.text(); return { status: res.status, body: t.slice(0, 65536) }; } },
};

const isLocalReq = (req) => { const a = (req.socket && req.socket.remoteAddress) || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => resolve(d)); });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'cloud-offload-bridge', workdir: WORKDIR, tools: Object.keys(tools) });
  const auth = String(req.headers['authorization'] || '');
  if (auth !== 'Bearer ' + TOKEN && !isLocalReq(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
  if (url.pathname === '/tools') return send(res, 200, { ok: true, tools: Object.entries(tools).map(([n, t]) => ({ name: n, desc: t.desc, args: t.args })) });
  if (url.pathname === '/tool' && req.method === 'POST') {
    let body; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
    const t = tools[body.name]; if (!t) return send(res, 200, { ok: false, error: 'unknown tool: ' + body.name });
    try { const r = await t.run(body.args || {}); return send(res, 200, { ok: true, tool: body.name, result: r }); }
    catch (e) { return send(res, 200, { ok: false, tool: body.name, error: String(e && e.message || e) }); }
  }
  return send(res, 404, { ok: false, error: 'not found' });
}).listen(PORT, HOST, () => {
  console.log('[bridge] listening http://' + HOST + ':' + PORT);
  console.log('[bridge] workdir  ' + WORKDIR);
  console.log('[bridge] TOKEN     ' + TOKEN);
  console.log('[bridge] tools     ' + Object.keys(tools).join(', '));
});
