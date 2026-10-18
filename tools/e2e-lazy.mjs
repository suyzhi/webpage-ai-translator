#!/usr/bin/env node
/*
 * 省 token 行为的端到端测试（零依赖，Node 18+）：
 *   1. 按需翻译：长页面只请求视口附近的段落，滚动到底部后才请求底部段落，中间跳过的不请求；
 *   2. 原文持续改写（模拟 AI 聊天流式输出）：等文本稳定后只重译一次，而不是每次变动都重译；
 *   3. 快捷键同款的 toggle：已翻译时再次触发即还原；
 *   4. token 用量：本页用量上报到内容脚本，累计用量写入存储；
 *   5. 按网站自动翻译：名单外的网站不注入脚本，名单内的网站打开即翻译。
 *
 * 用法：node tools/e2e-lazy.mjs   （CHROME_PATH 可指定浏览器）
 * 退出码：0 全部通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log('[e2e-lazy]', ...args);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

const N = 300;

async function main() {
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  let mock = null;
  let browser = null;

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, dict: 'demo/showcase-dict.json' });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);

    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-e2e-')) });
    const cdp = browser.cdp;
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;

    const opt = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options/options.html' });
    const optSession = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, optSession);
    await waitFor('设置页就绪', async () => (await cdp.evalIn(optSession, 'document.readyState')) === 'complete', 15000);
    const settings = { provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN', concurrency: 4, useCache: false };
    await cdp.evalIn(optSession, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(settings) + ' }); return true; })()');

    const page = await cdp.send('Target.createTarget', { url: MOCK + '/demo/showcase.html' });
    const ps = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, ps);
    await waitFor('页面加载完成', async () => (await cdp.evalIn(ps, 'document.readyState')) === 'complete', 20000);

    // 在页面末尾追加一长串独一无二的段落
    await cdp.evalIn(ps, '(function(){ const box = document.createElement("section"); for (let i = 0; i < ' + N + '; i++) { const p = document.createElement("p"); p.id = "lz" + i; p.textContent = "Lazy paragraph number " + i + ": the quick brown fox jumps over the lazy dog."; box.appendChild(p); } document.body.appendChild(box); window.scrollTo(0, 0); return true; })()');

    const tabQuery = '(await chrome.tabs.query({ url: "' + MOCK + '/*" }))[0].id';
    const send = (type) => cdp.evalIn(optSession, '(async () => { try { return await chrome.tabs.sendMessage(' + tabQuery + ', { type: "' + type + '" }); } catch (e) { return { error: String(e) }; } })()');
    const waitDone = (label) => waitFor(label, async () => { const st = await send('wpt:state'); return st && st.status === 'done' ? st : null; }, 60000, 300);
    const lazyTexts = async () => (await httpJson(MOCK + '/__stats')).texts.filter((t) => t.indexOf('Lazy paragraph number') === 0);

    await cdp.evalIn(optSession, '(async () => chrome.runtime.sendMessage({ type: "wpt:inject", tabId: ' + tabQuery + ', toggle: true }))()');
    const firstState = await waitDone('首屏翻译完成');
    await delay(800);
    check('用量：本页用量已上报', firstState.usage && firstState.usage.input > 0 && firstState.usage.output > 0, JSON.stringify(firstState.usage));
    const total = await cdp.evalIn(optSession, '(async () => (await chrome.storage.local.get("wpt.usage.v1"))["wpt.usage.v1"])()');
    check('用量：累计用量已写入存储', total && total.input >= firstState.usage.input && total.cached > 0, JSON.stringify(total));
    const first = await lazyTexts();
    check('按需翻译：首屏阶段远处段落没有被请求', first.length < N / 3, 'requested=' + first.length + '/' + N);

    await cdp.evalIn(ps, '(function(){ window.scrollTo(0, document.documentElement.scrollHeight); return true; })()');
    await waitFor('底部段落已翻译', async () => cdp.evalIn(ps, '!!document.querySelector("#lz' + (N - 1) + ' .wpt-translation, #lz' + (N - 1) + ' + .wpt-translation")'), 20000, 300);
    await waitDone('滚动后翻译完成');
    const second = await lazyTexts();
    check('按需翻译：滚动到底部后底部段落被请求', second.some((t) => t.indexOf('number ' + (N - 1) + ':') > 0), 'requested=' + second.length);
    check('按需翻译：中间跳过的段落没有被请求', second.length < N * 0.6, 'requested=' + second.length + '/' + N);
    const reqBeforeStream = (await httpJson(MOCK + '/__stats')).batches;
    check('增量请求不切小首批（无单段批次泛滥）', reqBeforeStream.filter((n) => n === 1).length <= 2, JSON.stringify(reqBeforeStream));

    // 模拟流式输出：每 250ms 往同一段落追加一个词，共 16 次（约 4 秒）
    const target = 'lz' + (N - 2);
    await cdp.evalIn(ps, '(async function(){ const p = document.getElementById("' + target + '"); const tn = p.firstChild; for (let i = 0; i < 16; i++) { await new Promise(r => setTimeout(r, 250)); tn.nodeValue = "Streaming answer grows word" + " more".repeat(i + 1) + "."; } return true; })()');
    await delay(4500);
    const streamed = (await httpJson(MOCK + '/__stats')).texts.filter((t) => t.indexOf('Streaming answer grows') === 0);
    check('流式改写：稳定后才重译（请求 ≤ 2 次而非每次变动一次）', streamed.length >= 1 && streamed.length <= 2, 'requests=' + streamed.length + ' ' + JSON.stringify(streamed.map((t) => t.length)));
    const finalText = await cdp.evalIn(ps, '(function(){ const p = document.getElementById("' + target + '"); const t = p.querySelector(".wpt-translation") || (p.nextElementSibling && p.nextElementSibling.classList.contains("wpt-translation") ? p.nextElementSibling : null); return t ? t.textContent : ""; })()');
    check('流式改写：最终版本有译文', !!finalText, finalText.slice(0, 60));

    await send('wpt:toggle');
    await delay(400);
    const left = await cdp.evalIn(ps, 'document.querySelectorAll(".wpt-translation").length');
    const st = await send('wpt:state');
    check('toggle：已翻译时再次触发即还原', left === 0 && st.status === 'idle', 'left=' + left + ' status=' + st.status);

    // 按网站自动翻译
    const setAuto = (sites) => cdp.evalIn(optSession, '(async () => { const k = "wpt.settings.v1"; const s = (await chrome.storage.local.get(k))[k]; s.autoTranslate = true; s.autoSites = ' + JSON.stringify(sites) + '; await chrome.storage.local.set({ [k]: s }); return true; })()');
    const stateAt = (url) => cdp.evalIn(optSession, '(async () => { const t = (await chrome.tabs.query({ url: "' + url + '" }))[0]; if (!t) return null; try { return await chrome.tabs.sendMessage(t.id, { type: "wpt:state" }); } catch (e) { return null; } })()');
    await setAuto(['example.com']);
    await delay(600);
    await cdp.send('Target.createTarget', { url: MOCK + '/demo/test-page.html?off' });
    await delay(2500);
    check('按网站自动翻译：名单外的网站不注入、不翻译', (await stateAt(MOCK + '/demo/test-page.html?off')) === null);
    await setAuto(['127.0.0.1']);
    await delay(600);
    await cdp.send('Target.createTarget', { url: MOCK + '/demo/test-page.html?on' });
    const auto = await waitFor('名单内网站自动翻译', async () => { const s = await stateAt(MOCK + '/demo/test-page.html?on'); return s && s.status === 'done' ? s : null; }, 30000, 400).catch(() => null);
    check('按网站自动翻译：名单内的网站打开即翻译', auto && auto.translated > 0, auto ? 'translated=' + auto.translated : 'not translated');
    // 整页已是目标语言：自动翻译不请求、不弹提示
    const reqBefore = (await (await fetch(MOCK + '/__stats')).json()).requests;
    const zh = await cdp.send('Target.createTarget', { url: MOCK + '/demo/zh-page.html' });
    await delay(2500);
    const zhState = await stateAt(MOCK + '/demo/zh-page.html');
    const reqAfter = (await (await fetch(MOCK + '/__stats')).json()).requests;
    const zhS = (await cdp.send('Target.attachToTarget', { targetId: zh.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, zhS);
    const zhUi = await cdp.evalIn(zhS, '!!document.querySelector("wpt-ui")');
    check('自动翻译：中文页面不发请求、不弹提示', zhState && zhState.status === 'idle' && reqAfter === reqBefore && !zhUi,
      JSON.stringify({ status: zhState && zhState.status, requests: reqAfter - reqBefore, ui: zhUi }));
  } catch (err) {
    check('端到端流程抛出异常', false, err && err.message);
    if (browser && browser.stderr.length) console.error(browser.stderr.join('').slice(-1500));
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
  if (failed) { console.error('[e2e-lazy] ' + failed + '/' + checks.length + ' 项断言失败'); return 1; }
  log('全部通过：' + checks.length + ' 项断言');
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(e && e.code === 'NO_BROWSER' ? 2 : 1); });
