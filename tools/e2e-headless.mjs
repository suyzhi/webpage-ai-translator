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
      targetLang: 'zh-CN', displayMode: 'bilingual', concurrency: 4,
      streaming: true          // 本地地址不在流式白名单内：强制开启，走通 service worker 里的 SSE 读取；其余 e2e 覆盖非流式
    };
    await cdp.evalIn(optSession, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(settings) + ' }); return true; })()');

    const page = await cdp.send('Target.createTarget', { url: PAGE_URL });
    const pageSession = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pageSession);
    await waitFor('演示页加载完成', async () => (await cdp.evalIn(pageSession, 'document.readyState')) === 'complete', 20000);
    // 固定高度、overflow:hidden 的横向导航条：块级译文会被截掉，应自动改为行内追加
    await cdp.evalIn(pageSession, '(function(){ const n = document.createElement("nav"); n.id = "e2e-strip";' +
      ' n.style.cssText = "display:flex;gap:20px;height:34px;overflow:hidden;align-items:flex-start;padding:6px 12px";' +
      ' n.innerHTML = ["Headlines today", "Ukraine war", "Climate desk"].map(function(t){ return \'<a href="#" style="display:block;flex:0 0 auto"><span style="display:block">\' + t + "</span></a>"; }).join("");' +
      ' const box = document.createElement("div"); box.id = "e2e-narrow"; box.style.cssText = "width:110px;height:22px;overflow:hidden";' +
      ' box.innerHTML = "<p style=\\"margin:0\\">Weather alerts</p>";' +
      ' document.body.insertBefore(box, document.body.firstChild); document.body.insertBefore(n, document.body.firstChild);' +
      // 横向导航（Microsoft Learn 式）：块级 a > span 的菜单项，最后一项定宽很窄
      ' const menu = document.createElement("nav"); menu.id = "e2e-menu";' +
      ' menu.innerHTML = \'<ul style="display:flex;gap:18px;list-style:none;margin:0;padding:8px 12px">\' + ["Release notes", "Developer tools", "Pricing plans"].map(function(t, i){' +
      '   return \'<li\' + (i === 2 ? \' style="width:96px"\' : "") + \'><a href="#" style="display:block"><span style="display:block">\' + t + "</span></a></li>"; }).join("") + "</ul>";' +
      ' document.body.insertBefore(menu, document.body.firstChild);' +
      // 定高但 overflow 可见：块级译文会溢出压住下一段
      ' const spill = document.createElement("section"); spill.id = "e2e-spill";' +
      ' spill.innerHTML = \'<div style="height:28px;line-height:24px"><p style="margin:0">Important update for readers</p></div><p id="e2e-next" style="margin:0">Following paragraph stays readable.</p>\';' +
      ' document.body.insertBefore(spill, document.body.firstChild); return true; })()');

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

    await sleep(1200);                                 // 裁切检查在入场动画结束后（380ms + 错峰最多 360ms）
    const strip = await cdp.evalIn(pageSession, '(function(){ const nav = document.getElementById("e2e-strip"); const nb = nav.getBoundingClientRect().bottom;' +
      ' const ts = [].slice.call(nav.querySelectorAll(".wpt-translation")); return { n: ts.length, inline: ts.filter(function(t){ return t.style.display === "inline"; }).length,' +
      ' visible: ts.filter(function(t){ return t.getBoundingClientRect().bottom <= nb + 1; }).length,' +
      ' narrow: document.querySelectorAll("#e2e-narrow .wpt-translation").length }; })()');
    check('定高导航条：被裁切的译文改为行内追加且完整可见', strip.n === 3 && strip.inline === 3 && strip.visible === 3, JSON.stringify(strip));
    check('改为行内后仍被截的译文不显示（不留半截碎片）', strip.narrow === 0, JSON.stringify(strip));
    const menu = await cdp.evalIn(pageSession, '(function(){ const items = [].slice.call(document.querySelectorAll("#e2e-menu li"));' +
      ' return items.map(function(li){ const t = li.querySelector(".wpt-translation"); if (!t) return "none";' +
      '   const s = li.querySelector("span").getClientRects()[0]; const r = t.getClientRects(); return t.style.display + (r[r.length - 1].bottom <= s.bottom + 2 ? ":same-line" : ":wrapped"); }); })()');
    const spill = await cdp.evalIn(pageSession, '(function(){ const box = document.querySelector("#e2e-spill > div"); const t = box.querySelector(".wpt-translation");' +
      ' const next = document.getElementById("e2e-next").getBoundingClientRect(); if (!t) return { t: false };' +
      ' const r = t.getBoundingClientRect(); return { t: true, display: t.style.display, overlaps: r.bottom > next.top + 1 && r.top < next.bottom }; })()');
    check('定高容器（overflow 可见）：译文不溢出压住下一段', !spill.t || (spill.display === 'inline' && !spill.overlaps), JSON.stringify(spill));
    check('横向导航：短标签译文行内同一行，放不下的撤掉', menu[0] === 'inline:same-line' && menu[1] === 'inline:same-line' && menu[2] === 'none', JSON.stringify(menu));

    const stats = await httpJson(MOCK + '/__stats');
    check('确实发起了 API 请求', stats.requests > 0, 'requests=' + stats.requests);
    check('请求走流式（SSE）', stats.streamed === stats.requests, 'streamed=' + stats.streamed + ' / ' + stats.requests);
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
