import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.OFFLOAD_API_BASE || 'http://127.0.0.1:8788';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function rec(name, ok, ms, detail) { results.push({ name: name, ok: !!ok, ms: ms || 0, detail: detail || '' }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (ms || 0) + 'ms | ' + (detail || '')); }
async function jget(p) { const t0 = Date.now(); const r = await fetch(API + p); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j: j, ms: Date.now() - t0 }; }
async function jpost(p, b) { const t0 = Date.now(); const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j: j, ms: Date.now() - t0 }; }

async function main() {
  let r;
  r = await jget('/health');
  rec('health 返回 200 且 ok', r.status === 200 && r.j && r.j.ok === true, r.ms, r.j && r.j.service);

  r = await jget('/api/health-full');
  rec('health-full cdp 且 glmPages>=1', r.status === 200 && r.j && r.j.cdp === true && r.j.glmPages >= 1, r.ms, 'glmPages=' + (r.j && r.j.glmPages));

  r = await jget('/api/route?est=5000&type=write&interactive=false&sensitive=false');
  rec('route 大任务判云端', r.status === 200 && r.j.decision.use === 'cloud', r.ms, r.j.decision.reason);

  r = await jget('/api/route?est=50&type=write&interactive=false&sensitive=false');
  rec('route 小任务判本地', r.status === 200 && r.j.decision.use === 'local', r.ms, r.j.decision.reason);

  r = await jget('/api/route?est=5000&type=write&sensitive=true');
  rec('route 敏感内容强制本地', r.status === 200 && r.j.decision.use === 'local', r.ms, r.j.decision.reason);

  const s0 = (await jget('/api/settings')).j.settings;
  const s1 = await jpost('/api/settings', { dailyCap: s0.dailyCap });
  rec('settings 保存并生效', s1.status === 200 && s1.j.ok === true, s1.ms, 'dailyCap=' + s0.dailyCap);

  r = await jget('/api/nope');
  rec('未知路由返回 404', r.status === 404, r.ms, 'status=' + r.status);

  // 真实复杂任务：约 350 字长文
  const LONG = '请写一篇约 350 字的短文，主题：城市通勤中的时间成本。要求分三段，最后一句总结。直接给正文。';
  r = await jpost('/api/offload', { task: LONG, type: 'write', model: 'GLM-Flash' });
  const a1 = (r.j && r.j.answer) || '';
  rec('offload 复杂长文（约350字）', r.status === 200 && r.j.ok === true && r.j.complete === true && a1.length >= 250, r.ms, 'out=' + a1.length + ' 字符, saved=' + (r.j.metrics && r.j.metrics.est_tokens_saved));

  const r2 = await jpost('/api/offload', { task: LONG, type: 'write', model: 'GLM-Flash' });
  rec('同题命中结果缓存', r2.status === 200 && r2.j.metrics && r2.j.metrics.cached === true, r2.ms, 'ms=' + r2.j.metrics.ms + ' saved=' + r2.j.metrics.est_tokens_saved);

  const w = await jpost('/api/write', { path: '/tmp/co-test-write.txt', content: 'hello-cloud-offload' });
  rec('write 落盘成功', w.status === 200 && w.j.ok === true, w.ms, JSON.stringify(w.j));

  // 批量协作：3 段拼装
  const plan = { title: '测试报告', type: 'write', model: 'GLM-Flash', parts: [
    { heading: '第一节', task: '写 120 字左右，介绍主题背景。直接给正文。' },
    { heading: '第二节', task: '写 120 字左右，分析主要问题。直接给正文。' },
    { heading: '第三节', task: '写 120 字左右，给出建议。直接给正文。' },
  ] };
  fs.writeFileSync('/tmp/co-plan.json', JSON.stringify(plan));
  const t0 = Date.now();
  let batchOk = false, batchDetail = '';
  try {
    execFileSync(process.execPath, [path.join(HERE, 'cloud-offload-batch.mjs'), '--spec', '/tmp/co-plan.json', '--out', '/tmp/co-batch.md', '--quiet'], { timeout: 600000 });
    const doc = fs.readFileSync('/tmp/co-batch.md', 'utf8');
    const heads = (doc.match(/^## /gm) || []).length;
    batchOk = heads >= 3 && doc.length > 300;
    batchDetail = '段数=' + heads + ' 字符=' + doc.length;
  } catch (e) { batchDetail = '失败 ' + e.message; }
  rec('批量协作 3 段拼装', batchOk, Date.now() - t0, batchDetail);

  const N = 3; let okc = 0; const lat = [];
  for (let i = 0; i < N; i++) {
    const tt = Date.now();
    const rr = await jpost('/api/offload', { task: '写 80 字左右，主题：效率。序号 ' + i, type: 'write', model: 'GLM-Flash' });
    lat.push(Date.now() - tt);
    if (rr.j.ok && rr.j.complete) okc++;
  }
  rec('串行压力 ' + N + ' 次（真实短任务）', okc === N, Math.round(lat.reduce(function (a, b) { return a + b; }, 0) / N), 'ok=' + okc + '/' + N + ' 各次=' + lat.join(','));

  const par = await Promise.all([0, 1, 2].map(function (i) { return jpost('/api/offload', { task: '写 60 字左右，主题：并发测试 ' + i, type: 'write', model: 'GLM-Flash' }); }));
  const parOk = par.filter(function (x) { return x.j && x.j.ok; }).length;
  rec('并发 3 请求（串行且不崩）', parOk === 3, 0, 'ok=' + parOk + '/3');

  const passed = results.filter(function (x) { return x.ok; }).length;
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, passed: passed, failed: results.length - passed, results: results }));
}
main().catch(function (e) { console.log('FATAL ' + e.message); });
