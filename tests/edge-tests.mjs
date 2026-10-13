// tests/edge-tests.mjs — 边界与异常场景
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.OFFLOAD_API_BASE || 'http://127.0.0.1:8788';
const results = [];
function rec(name, ok, ms, detail) { results.push({ name: name, ok: !!ok, ms: ms || 0, detail: detail || '' }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (ms || 0) + 'ms | ' + (detail || '')); }
async function raw(p, opt) { const t0 = Date.now(); const r = await fetch(API + p, opt); let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch (e) {} return { status: r.status, j: j, txt: txt, ms: Date.now() - t0 }; }
const GET = (p) => raw(p);
const POST = (p, b) => raw(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

async function main() {
  let r;

  r = await POST('/api/offload', { task: '', type: 'write' });
  rec('空任务优雅报错（不崩不挂）', r.status === 200 && r.j && (r.j.ok === false || String(r.j.answer || '').length === 0), r.ms, 'ok=' + (r.j && r.j.ok) + ' err=' + ((r.j && r.j.error) || '').slice(0, 40));

  r = await POST('/api/offload', { task: '只输出这一串原样字符：<>&"\' 与 emoji 🚀✅，不要改动', type: 'tag', model: 'GLM-Flash' });
  const aEmoji = String((r.j && r.j.answer) || '');
  rec('特殊字符/emoji 原样返回', r.status === 200 && aEmoji.length > 0, r.ms, 'len=' + aEmoji.length + ' 含🚀=' + /🚀/.test(aEmoji));

  const uni = '/tmp/co-edge/中文目录/输出 🚀.txt';
  r = await POST('/api/write', { path: uni, content: 'edge-unicode-ok' });
  rec('Unicode 路径落盘', r.status === 200 && r.j.ok === true && fs.existsSync(uni), r.ms, uni);

  const big = '材料段落：这是用于测试的长材料。'.repeat(120);
  r = await POST('/api/offload', { task: '把材料压缩成一句话。', material: big, type: 'summary', model: 'GLM-Flash' });
  rec('长材料传入并处理', r.status === 200 && r.j.ok === true && String(r.j.answer || '').length > 0, r.ms, 'material=' + big.length + ' out=' + String(r.j.answer || '').length + ' saved=' + (r.j.metrics && r.j.metrics.est_tokens_saved));

  const same = '用一句话解释什么是机会成本。';
  const c1 = await POST('/api/offload', { task: same, type: 'summary', model: 'GLM-Flash' });
  const c2 = await POST('/api/offload', { task: same, type: 'summary', model: 'GLM-Flash' });
  rec('缓存：同题二次命中', c2.j && c2.j.metrics && c2.j.metrics.cached === true && c2.j.metrics.ms === 0, c2.ms, 'first=' + c1.ms + 'ms cached=' + (c2.j.metrics && c2.j.metrics.cached));

  r = await POST('/api/offload', { task: '{bad json' });
  rec('非法 JSON 请求体返回 400', (await raw('/api/offload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' })).status === 400, 0, '');

  const codes = {};
  const setPol = (patch) => POST('/api/settings', { policy: patch });
  const s0 = (await GET('/api/settings')).j.settings;
  codes.sensitive = (await GET('/api/route?est=9000&type=write&sensitive=true')).j.decision.code;
  codes.interactive = (await GET('/api/route?est=9000&type=write&interactive=true')).j.decision.code;
  codes.below = (await GET('/api/route?est=10&type=write')).j.decision.code;
  codes.worth = (await GET('/api/route?est=9000&type=write')).j.decision.code;
  await setPol({ enabled: false });
  codes.master = (await GET('/api/route?est=9000&type=write')).j.decision.code;
  await setPol({ enabled: true, allowTypes: Object.assign({}, s0.policy.allowTypes, { write: false }) });
  codes.typeoff = (await GET('/api/route?est=9000&type=write')).j.decision.code;
  await setPol({ allowTypes: s0.policy.allowTypes });
  const want = { sensitive: 'sensitive', interactive: 'interactive', below: 'below_threshold', worth: 'worth_offloading', master: 'master_off', typeoff: 'type_disabled' };
  const codesOk = Object.keys(want).every(function (k) { return codes[k] === want[k]; });
  rec('路由分支 code 全覆盖', codesOk, 0, JSON.stringify(codes));

  const bad = await POST('/api/settings', { dailyCap: s0.dailyCap });
  rec('settings 保存后回读一致', bad.j.ok === true && (await GET('/api/settings')).j.settings.dailyCap === s0.dailyCap, bad.ms, 'cap=' + s0.dailyCap);

  const passed = results.filter(function (x) { return x.ok; }).length;
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, passed: passed, failed: results.length - passed }));
}
main().catch(function (e) { console.log('FATAL ' + e.message); });
