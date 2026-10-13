// ==UserScript==
// @name         Cloud Offload · 云端算力桥
// @namespace    openclaw.local.bridge
// @version      1.0.0
// @description  识别 ChatGLM 回复里的工具调用块，转交本机 bridge 执行，并把结果回灌继续对话
// @match        https://chatglm.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  var DEFAULTS = {
    bridge: 'http://127.0.0.1:8787',
    token: 'devtoken-abc123',
    inputSelectors: ['textarea', '[contenteditable="true"]'],
    sendSelectors: ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', '[class*="send"] button', 'button[type="submit"]'],
  };
  var cfg = {
    bridge: GM_getValue('bridge', DEFAULTS.bridge),
    token: GM_getValue('token', DEFAULTS.token),
    auto: GM_getValue('auto', true),
  };
  function save() { GM_setValue('bridge', cfg.bridge); GM_setValue('token', cfg.token); GM_setValue('auto', cfg.auto); }
  var INSTRUCT = [
    '你现在可以调用本机工具。需要时，只输出一个代码块（不要额外解释）：',
    '',
    '```bridge',
    '{"name":"工具名","args":{...}}',
    '```',
    '',
    '可用工具：run_shell{cmd} / read_file{path} / write_file{path,content} / list_dir{path} / http_get{url}。',
    '我会把执行结果以 ```bridge-result 代码块回给你，然后你继续。',
  ].join('\n');
  function callBridge(name, args) {
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.bridge.replace(/\/$/, '') + '/tool',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token },
        data: JSON.stringify({ name: name, args: args || {} }),
        timeout: 30000,
        onload: function (r) { var j; try { j = JSON.parse(r.responseText); } catch (e) { j = { ok: false, error: 'bad response' }; } resolve(j); },
        onerror: function () { resolve({ ok: false, error: 'bridge unreachable' }); },
        ontimeout: function () { resolve({ ok: false, error: 'bridge timeout' }); },
      });
    });
  }
  function pick(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = Array.prototype.slice.call(document.querySelectorAll(selectors[i])).filter(function (e) { return e.offsetParent !== null; });
      if (els.length) return els[els.length - 1];
    }
    return null;
  }
  function setInput(el, text) {
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
    return true;
  }
  function doSend() {
    var btn = pick(DEFAULTS.sendSelectors);
    if (btn) { btn.click(); return true; }
    var el = pick(DEFAULTS.inputSelectors);
    if (el) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return true; }
    return false;
  }
  var done = new Set();
  function scan() {
    if (!cfg.auto) return;
    var codes = document.querySelectorAll('pre code, code');
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      var cls = (c.className || '') + ' ' + ((c.parentElement && c.parentElement.className) || '');
      if (/bridge-result/.test(cls)) continue;
      var txt = (c.textContent || '').trim();
      if (txt.charAt(0) !== '{') continue;
      var payload; try { payload = JSON.parse(txt); } catch (e) { continue; }
      if (!payload || !payload.name) continue;
      var k = payload.name + '|' + JSON.stringify(payload.args || {});
      if (done.has(k)) continue;
      done.add(k);
      log('→ 工具调用: ' + payload.name);
      var name = payload.name, args = payload.args;
      callBridge(name, args).then(function (r) {
        var out = '```bridge-result\n' + JSON.stringify(r) + '\n```';
        var el = pick(DEFAULTS.inputSelectors);
        if (setInput(el, out)) setTimeout(doSend, 300);
        log(r && r.ok ? ('✓ ' + name + ' 已执行，结果已回灌') : ('✗ ' + (r && r.error)));
      });
      return;
    }
  }
  var logEl = null;
  function log(m) { if (logEl) { logEl.textContent = (m + '\n' + logEl.textContent).slice(0, 800); } }
  function panel() {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;width:280px;background:#0f1115;color:#ddd;border:1px solid #333;border-radius:10px;padding:10px;font:12px/1.5 -apple-system,Menlo,monospace;box-shadow:0 6px 20px rgba(0,0,0,.45)';
    d.innerHTML = '<div style="font-weight:700;color:#c9a45c;margin-bottom:6px">本地 Agent 桥</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="b-url" style="flex:1;min-width:0;background:#1a1d23;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px">'
      + '<input id="b-tok" style="width:104px;background:#1a1d23;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px"></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:6px"><button id="b-save" style="flex:1;background:#c9a45c;color:#111;border:0;border-radius:6px;padding:4px;font-weight:700">保存</button>'
      + '<button id="b-auto" style="flex:1;background:#1a1d23;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px">自动</button>'
      + '<button id="b-instr" style="flex:1;background:#1a1d23;color:#ddd;border:1px solid #333;border-radius:6px;padding:4px">注入说明</button></div>'
      + '<div id="b-log" style="height:70px;overflow:auto;background:#0a0c10;border:1px solid #222;border-radius:6px;padding:4px;color:#8aa"></div>';
    document.body.appendChild(d);
    var q = function (s) { return d.querySelector(s); };
    q('#b-url').value = cfg.bridge; q('#b-tok').value = cfg.token;
    function sync() { q('#b-auto').textContent = '自动:' + (cfg.auto ? '开' : '关'); q('#b-auto').style.borderColor = cfg.auto ? '#2e7d32' : '#333'; }
    sync();
    q('#b-save').onclick = function () { cfg.bridge = q('#b-url').value.trim(); cfg.token = q('#b-tok').value.trim(); save(); log('已保存'); };
    q('#b-auto').onclick = function () { cfg.auto = !cfg.auto; save(); sync(); log('自动 ' + (cfg.auto ? '开' : '关')); };
    q('#b-instr').onclick = function () { var el = pick(DEFAULTS.inputSelectors); if (setInput(el, INSTRUCT)) log('已注入工具说明，点发送即可'); else log('找不到输入框，请手动粘贴'); };
    logEl = q('#b-log');
    log('就绪。点「注入说明」开始。');
  }
  function boot() {
    if (!document.body) { setTimeout(boot, 500); return; }
    panel();
    new MutationObserver(function () { try { scan(); } catch (e) {} }).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(scan, 4000);
  }
  boot();
})();
