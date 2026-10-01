#!/usr/bin/env node
/*
 * 无头浏览器端到端测试（零依赖，Node 18+）。
 *
 * 真实启动一个 headless Chrome / Chromium / Edge，通过 CDP 的 Extensions.loadUnpacked
 * 加载本仓库的扩展，再用仓库自带的 mock AI 服务跑通完整链路：
 *   写入设置 -> 注入内容脚本 -> 抽段 -> 打包 -> 并发请求 -> 渲染译文 -> 还原原文。
 *
 * 用法：
 *   node tools/e2e-headless.mjs
 *   CHROME_PATH=/path/to/chrome node tools/e2e-headless.mjs
 *   WPT_E2E_KEEP=1 node tools/e2e-headless.mjs      # 保留临时 profile，便于排查
 *
 * 退出码：0 全部通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = !!process.env.WPT_E2E_KEEP;
const log = (...args) => console.log('[e2e]', ...args);
const sleep = (ms) => delay(ms);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

async function main() {
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  const PAGE_URL = MOCK + '/demo/showcase.html';
  let mock = null;
  let browser = null;
  let exitCode = 0;

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, dict: 'demo/showcase-dict.json' });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    log('mock AI 服务：' + MOCK);

    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-e2e-')) });
    const cdp = browser.cdp;
    log('浏览器：' + browser.browserPath);

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    const extId = loaded.id;
    check('扩展加载成功', !!extId, extId);
    log('扩展已加载：' + extId);

    const opt = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options/options.html' });
    const optSession = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, optSession);
    await waitFor('设置页就绪', async () => (await cdp.evalIn(optSession, 'document.readyState')) === 'complete', 15000);

    const settings = {
      provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock',
      targetLang: 'zh-CN', displayMode: 'bilingual', concurrency: 4
    };
    await cdp.evalIn(optSession, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(settings) + ' }); return true; })()');

    const page = await cdp.send('Target.createTarget', { url: PAGE_URL });
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pageSession);
    await waitFor('演示页加载完成', async () => (await cdp.evalIn(pageSession, 'document.readyState')) === 'complete', 20000);

    const trigger = await cdp.evalIn(optSession, '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); if (!tabs.length) return { error: "no tab" }; const r = await chrome.runtime.sendMessage({ type: "wpt:inject", tabId: tabs[0].id, toggle: true }); return { tabId: tabs[0].id, r }; })()');
    check('内容脚本注入', trigger && trigger.r && trigger.r.ok, JSON.stringify(trigger));

    const stateExpr = '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); if (!tabs.length) return null; try { return await chrome.tabs.sendMessage(tabs[0].id, { type: "wpt:state" }); } catch (e) { return { error: String(e) }; } })()';
    const state = await waitFor('翻译完成', async () => {
      const st = await cdp.evalIn(optSession, stateExpr);
      if (!st || st.error) return null;
      return st.status === 'done' ? st : null;
    }, 60000, 400);
    check('翻译状态 done', state.status === 'done', state.status);
    check('无失败片段', state.failed === 0, 'failed=' + state.failed);
    check('整体进度完成', state.done === state.total, state.done + '/' + state.total);

    const dom = await cdp.evalIn(pageSession, '(function(){ const nodes = [].slice.call(document.querySelectorAll(".wpt-translation")); const first = nodes[0]; return { count: nodes.length, title: document.title, firstText: first ? first.textContent : "" }; })()');
    check('渲染出译文节点', dom.count > 0, 'count=' + dom.count);
    check('译文数量与状态一致', dom.count === state.translated, dom.count + ' vs ' + state.translated);
    check('首个译文为目标语言', /[\u4e00-\u9fff]/.test(dom.firstText || ''), (dom.firstText || '').slice(0, 40));
    check('网页标题已翻译', /[\u4e00-\u9fff]/.test(dom.title || ''), dom.title);

    const stats = await httpJson(MOCK + '/__stats');
    check('确实发起了 API 请求', stats.requests > 0, 'requests=' + stats.requests);
    check('批量打包生效（存在多段批次）', stats.batches.some((n) => n > 1), JSON.stringify(stats.batches));
    check('请求段数不超过单元数（相同文本去重生效）', stats.segments <= state.total, 'segments=' + stats.segments + ' total=' + state.total);
    check('请求段数覆盖全部译文节点', stats.segments >= dom.count, 'segments=' + stats.segments + ' rendered=' + dom.count);

    await cdp.evalIn(optSession, '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); await chrome.tabs.sendMessage(tabs[0].id, { type: "wpt:restore" }); return true; })()');
    await sleep(400);
    const afterRestore = await cdp.evalIn(pageSession, 'document.querySelectorAll(".wpt-translation").length');
    check('还原原文后译文清空', afterRestore === 0, 'left=' + afterRestore);

    log('统计：' + JSON.stringify({ requests: stats.requests, segments: stats.segments, batches: stats.batches }));
  } catch (err) {
    check('端到端流程抛出异常', false, err && err.message);
    console.error('[e2e] 失败：' + (err && err.stack ? err.stack : err));
    if (browser && browser.stderr.length) console.error('[e2e] 浏览器日志尾部：\n' + browser.stderr.join('').slice(-1500));
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) {}
      killTree(browser.proc);
      if (!KEEP) { try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) {} }
    }
    if (mock) killTree(mock);
    await sleep(250);
  }

  for (const c of checks) console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + (c.detail ? '  -> ' + c.detail : ''));
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.error('[e2e] ' + failed + '/' + checks.length + ' 项断言失败'); exitCode = 1; }
  else log('全部通过：' + checks.length + ' 项断言');
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  if (err && err.code === 'NO_BROWSER') { console.error(err.message); process.exit(2); }
  console.error(err);
  process.exit(1);
});
