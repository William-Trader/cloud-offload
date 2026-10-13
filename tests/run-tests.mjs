const API = process.env.OFFLOAD_API_BASE || 'http://127.0.0.1:8788';
const results = [];
function rec(name, ok, ms, detail) { results.push({ name: name, ok: !!ok, ms: ms || 0, detail: detail || '' }); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (ms || 0) + 'ms | ' + (detail || '')); }
async function jget(p) { const t0 = Date.now(); const r = await fetch(API + p); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j: j, ms: Date.now() - t0 }; }
async function jpost(p, b) { const t0 = Date.now(); const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j: j, ms: Date.now() - t0 }; }

async function main() {
  let r;
  r = await jget('/health');
  rec('health 返回 200 且 ok', r.status === 200 && r.j && r.j.ok === true, r.ms, r.j && r.j.service);

  r = await jget('/api/health-full');
  rec('health-full 有 cdp 且 glmPages>=1', r.status === 200 && r.j && r.j.cdp === true && r.j.glmPages >= 1, r.ms, 'glmPages=' + (r.j && r.j.glmPages));

  r = await jget('/api/route?est=5000&type=write&interactive=false&sensitive=false');
  rec('route 大任务判云端', r.status === 200 && r.j && r.j.decision && r.j.decision.use === 'cloud', r.ms, r.j && r.j.decision && r.j.decision.reason);

  r = await jget('/api/route?est=50&type=write&interactive=false&sensitive=false');
  rec('route 小任务判本地', r.status === 200 && r.j && r.j.decision && r.j.decision.use === 'local', r.ms, r.j && r.j.decision && r.j.decision.reason);

  r = await jget('/api/route?est=5000&type=write&sensitive=true');
  rec('route 敏感内容强制本地', r.status === 200 && r.j && r.j.decision && r.j.decision.use === 'local', r.ms, r.j && r.j.decision && r.j.decision.reason);

  const s0 = (await jget('/api/settings')).j.settings;
  const s1 = await jpost('/api/settings', { dailyCap: s0.dailyCap });
  rec('settings 保存并生效', s1.status === 200 && s1.j && s1.j.ok === true, s1.ms, 'dailyCap=' + s0.dailyCap);

  r = await jget('/api/nope');
  rec('未知路由返回 404', r.status === 404, r.ms, 'status=' + r.status);

  r = await jpost('/api/offload', { task: '只输出四个字：云端算力', type: 'tag', model: 'GLM-Flash' });
  const ans = (r.j && r.j.answer) || '';
  rec('offload 小任务完成且标记完整', r.status === 200 && r.j && r.j.ok === true && r.j.complete === true && ans.length > 0, r.ms, 'out=' + ans.length + ' complete=' + (r.j && r.j.complete));

  const w = await jpost('/api/write', { path: '/tmp/co-test-write.txt', content: 'hello-cloud-offload' });
  rec('write 落盘成功', w.status === 200 && w.j && w.j.ok === true, w.ms, JSON.stringify(w.j));

  const N = 3; let okc = 0; const lat = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const rr = await jpost('/api/offload', { task: '只输出三个字：测试', type: 'tag', model: 'GLM-Flash' });
    lat.push(Date.now() - t0);
    if (rr.j && rr.j.ok && rr.j.complete) okc++;
  }
  rec('串行压力 ' + N + ' 次成功率', okc === N, Math.round(lat.reduce(function (a, b) { return a + b; }, 0) / N), 'ok=' + okc + '/' + N + ' 各次耗时=' + lat.join(','));

  const par = await Promise.all([0, 1, 2].map(function () { return jpost('/api/offload', { task: '只输出两个字：并发', type: 'tag', model: 'GLM-Flash' }); }));
  const parOk = par.filter(function (x) { return x.j && x.j.ok; }).length;
  rec('并发 3 请求（应串行且不崩）', parOk === 3, 0, 'ok=' + parOk + '/3');

  const passed = results.filter(function (x) { return x.ok; }).length;
  console.log('SUMMARY ' + JSON.stringify({ total: results.length, passed: passed, failed: results.length - passed, results: results }));
}
main().catch(function (e) { console.log('FATAL ' + e.message); });
