#!/usr/bin/env node
/*
 * 动态内容 + 高并发端到端测试（零依赖）。
 *
 * 用慢速 mock AI 服务（每次请求 500ms）+ 小并发真实加载扩展，验证：
 *   1. 翻译进行中追加新段落（SPA / 无限滚动）：增量翻译，不中止在途请求、不重复请求；
 *   2. 同一密钥下多个标签页同时翻译：服务端观察到的峰值并发不超过设置值；
 *   3. 页面改写已翻译段落的原文：旧译文作废并自动重译；
 *   4. 页面框架抹掉译文节点：自动补回；
 *   5. 仅译文模式下列表项原文被隐藏，还原后完整恢复。
 *
 * 用法：node tools/e2e-dynamic.mjs      退出码：0 通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log('[dyn]', ...args);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

async function main() {
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  let mock = null, browser = null;
  const CONC = 2;

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, delay: 500 });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-dyn-')) });
    const cdp = browser.cdp;
    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails && p.exceptionDetails.text) || 'error'));
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;

    const attach = async (url) => {
      const t = await cdp.send('Target.createTarget', { url });
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, s);
      await waitFor('页面加载 ' + url, async () => (await cdp.evalIn(s, 'document.readyState')) === 'complete', 20000);
      return s;
    };
    const ext = await attach('chrome-extension://' + extId + '/src/options/options.html');
    const setSettings = (extra) => cdp.evalIn(ext, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(Object.assign({
      provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN',
      displayMode: 'bilingual', concurrency: CONC, batchItems: 2, batchChars: 300, firstBatchChars: 200, animations: true,
      lazyTranslate: false          // 此处验证整页增量机制；按需翻译见 e2e-lazy.mjs
    }, extra || {})) + ' }); return true; })()');
    const tabExpr = (file, body) => '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + file + '" }); const id = tabs[0].id; ' + body + ' })()';
    const toggle = (file) => cdp.evalIn(ext, tabExpr(file, 'return await chrome.runtime.sendMessage({ type: "wpt:inject", tabId: id, toggle: true });'));
    const stateOf = (file) => cdp.evalIn(ext, tabExpr(file, 'try { return await chrome.tabs.sendMessage(id, { type: "wpt:state" }); } catch (e) { return null; }'));
    const send = (file, type) => cdp.evalIn(ext, tabExpr(file, 'return await chrome.tabs.sendMessage(id, { type: "' + type + '" });'));
    const waitDone = (file) => waitFor('翻译完成 ' + file, async () => { const s = await stateOf(file); return s && s.status === 'done' ? s : null; }, 90000, 300);
    const resetStats = async () => (await httpJson(MOCK + '/__stats'));

    /* ---- 1. 翻译进行中追加新段落 ---- */
    await setSettings();
    const T = '/demo/test-page.html';
    const page = await attach(MOCK + T);
    const before = await resetStats();
    await toggle(T);
    await delay(350);
    await cdp.evalIn(page, '(function(){ for (let i = 0; i < 6; i++) { const p = document.createElement("p"); p.className = "dyn"; p.textContent = "Dynamic paragraph number " + i + " appended while the page is being translated."; document.body.appendChild(p); } return true; })()');
    const st1 = await waitDone(T);
    const s1 = await httpJson(MOCK + '/__stats');
    const texts = s1.texts.slice(before.texts.length);
    const dup = texts.filter((t, i) => texts.indexOf(t) !== i);
    const dyn = await cdp.evalIn(page, '[].filter.call(document.querySelectorAll("p.dyn"), function(p){ return p.querySelector(".wpt-translation"); }).length');
    check('进行中追加：新段落全部翻译', dyn === 6, 'translated=' + dyn + '/6');
    check('进行中追加：无失败', st1.failed === 0, 'failed=' + st1.failed);
    check('进行中追加：没有重复请求（未中止重来）', dup.length === 0, dup.length ? '重复 ' + dup.length + '：' + dup[0].slice(0, 40) : 'segments=' + texts.length);
    check('并发上限：服务端峰值并发 ≤ ' + CONC, s1.peak <= CONC, 'peak=' + s1.peak);

    /* ---- 3. 页面改写已翻译段落 ---- */
    await cdp.evalIn(page, '(function(){ const h = document.querySelector("h2"); h.firstChild.nodeValue = "Rewritten heading by the application"; return true; })()');
    const rewritten = await waitFor('改写后重译', async () => {
      const t = await cdp.evalIn(page, '(function(){ const n = document.querySelector("h2 .wpt-translation"); return n ? n.textContent : ""; })()');
      return /Rewritten heading/.test(t) ? t : null;
    }, 15000, 250).catch(() => null);
    check('原文被页面改写后自动重译', !!rewritten, rewritten || 'timeout');
    const h2Count = await cdp.evalIn(page, 'document.querySelectorAll("h2")[0].querySelectorAll(".wpt-translation").length');
    check('重译后不残留旧译文', h2Count === 1, 'count=' + h2Count);

    /* ---- 4. 框架抹掉译文节点 ---- */
    await cdp.evalIn(page, '(function(){ const n = document.querySelector(".lead .wpt-translation"); n.parentNode.removeChild(n); return true; })()');
    const back = await waitFor('译文补回', async () => (await cdp.evalIn(page, '!!document.querySelector(".lead .wpt-translation")')) || null, 5000, 150).catch(() => false);
    check('译文被外部移除后自动补回', !!back, back);

    /* ---- 2. 多标签页共享并发上限 ---- */
    await send(T, 'wpt:restore');
    await setSettings({ useCache: false });
    const S = '/demo/showcase.html';
    await attach(MOCK + S);
    const mark = await resetStats();
    await Promise.all([toggle(T), toggle(S)]);
    await Promise.all([waitDone(T), waitDone(S)]);
    const s2 = await httpJson(MOCK + '/__stats');
    check('两个标签页同时翻译：合计峰值并发 ≤ ' + CONC, s2.peak <= CONC && s2.requests > mark.requests, 'peak=' + s2.peak + ' requests=' + (s2.requests - mark.requests));

    /* ---- 5. 仅译文模式：列表原文隐藏，还原后恢复 ---- */
    await send(T, 'wpt:restore');
    await setSettings({ displayMode: 'translation' });
    await toggle(T);
    await waitDone(T);
    const only = await cdp.evalIn(page, '(function(){ const li = document.querySelector("ul li"); return { visible: li.innerText.trim() }; })()');
    check('仅译文：列表项只显示译文', /^【译】/.test(only.visible) && only.visible.split('Concurrency').length === 2, only.visible.slice(0, 60));
    await send(T, 'wpt:restore');
    await delay(200);
    const restored = await cdp.evalIn(page, '(function(){ const li = document.querySelector("ul li"); return li.innerText.trim(); })()');
    check('仅译文还原后原文完整恢复', restored === 'Concurrency is configurable between one and thirty-two parallel requests.', restored);

    check('页面无运行时异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('动态测试抛出异常', false, err && err.message);
    console.error('[dyn] 失败：' + (err && err.stack ? err.stack : err));
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) {}
      killTree(browser.proc);
      try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) {}
    }
    if (mock) killTree(mock);
    await delay(250);
  }

  for (const c of checks) console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + (c.detail ? '  -> ' + c.detail : ''));
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.error('[dyn] ' + failed + '/' + checks.length + ' 项断言失败'); return 1; }
  log('全部通过：' + checks.length + ' 项断言');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  if (err && err.code === 'NO_BROWSER') { console.error(err.message); process.exit(2); }
  console.error(err);
  process.exit(1);
});
