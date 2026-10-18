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
      ' document.body.insertBefore(spill, document.body.firstChild);' +
      // 限高的长段落预览（Reddit 信息流摘要式）：译文应放到预览框之后，截成与原文露出部分相同的行数
      ' const clamp = document.createElement("section"); clamp.id = "e2e-clamp"; clamp.style.width = "320px";' +
      ' clamp.innerHTML = \'<div class="pv" style="max-height:48px;line-height:24px;overflow:hidden"><p style="margin:0">The city council approved a new transit plan on Tuesday that would add three bus lines, extend late-night service and lower fares for students and seniors starting next spring.</p></div><p id="e2e-clamp-next" style="margin:0">Read more</p>\';' +
      ' document.body.insertBefore(clamp, document.body.firstChild);' +
      // 影子宿主只有具名 slot（Reddit shreddit-post-text-body 式）：追加进宿主的译文必须进同一个 slot 才显示
      ' const host = document.createElement("x-e2e-body"); host.id = "e2e-host"; host.style.display = "block";' +
      ' host.attachShadow({ mode: "open" }).innerHTML = \'<div><slot name="body"></slot></div>\';' +
      ' host.innerHTML = \'<span slot="body">Scientists say the migrating insects can travel hundreds of kilometres without any harm.</span>\';' +
      ' document.body.insertBefore(host, document.body.firstChild);' +
      // 块之间的一小段文字（徽章）与行内块里的短标签（下拉按钮）：译文应在同一行
      ' const mix = document.createElement("div"); mix.id = "e2e-mix";' +
      ' mix.innerHTML = \'<div id="e2e-flair">Biology<p style="margin:0">A longer paragraph sits in the same container right below the badge.</p></div>\' +' +
      '   \'<div id="e2e-sort"><span style="display:inline-flex;padding:2px 8px;border:1px solid #888">This Year</span></div>\';' +
      ' document.body.insertBefore(mix, document.body.firstChild);' +
      // 瀑布流（Microsoft Learn 式）：页面脚本按内容算出定高的纵向换行 flex，只在 resize 时重算
      ' const mas = document.createElement("div"); mas.id = "e2e-masonry"; mas.style.cssText = "display:flex;flex-direction:column;flex-wrap:wrap;width:100%";' +
      ' mas.innerHTML = [1,2,3,4,5,6].map(function(i){ return \'<div style="width:33%;box-sizing:border-box;padding:4px"><p style="margin:0">Masonry card number \' + i + \' explains one topic in a single sentence.</p></div>\'; }).join("");' +
      ' document.body.insertBefore(mas, document.body.firstChild);' +
      ' function lay(){ let sum = 0; for (const k of mas.children) sum += k.offsetHeight; mas.style.height = Math.ceil(sum / 3 + 8) + "px"; }' +
      ' lay(); window.addEventListener("resize", lay); return true; })()');

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
    const clamp = await cdp.evalIn(pageSession, '(function(){ const box = document.querySelector("#e2e-clamp .pv"); const t = box.nextElementSibling;' +
      ' if (!t || !t.classList.contains("wpt-translation")) return { after: false, inside: box.querySelectorAll(".wpt-translation").length };' +
      ' const r = t.getBoundingClientRect(), next = document.getElementById("e2e-clamp-next").getBoundingClientRect();' +
      ' return { after: true, lines: t.style.webkitLineClamp, h: Math.round(r.height), overlaps: r.bottom > next.top + 1, cjk: /[\\u4e00-\\u9fff]/.test(t.textContent) }; })()');
    check('限高的长段落预览：译文放到预览框之后、截成同样行数、不压住下文', clamp.after && clamp.lines === '2' && clamp.h <= 60 && !clamp.overlaps && clamp.cjk, JSON.stringify(clamp));
    const mas = await cdp.evalIn(pageSession, '({ sw: document.documentElement.scrollWidth, w: innerWidth, n: document.querySelectorAll("#e2e-masonry .wpt-translation").length })');
    check('瀑布流：译文撑高后补发 resize，页面重新排版、不出现横向滚动', mas.n === 6 && mas.sw <= mas.w + 1, JSON.stringify(mas));
    const slotted = await cdp.evalIn(pageSession, '(function(){ const t = document.querySelector("#e2e-host > .wpt-translation"); if (!t) return { t: false };' +
      ' const r = t.getBoundingClientRect(); return { t: true, slot: t.getAttribute("slot"), visible: r.width > 0 && r.height > 0 }; })()');
    check('影子宿主里追加的译文进入同一个具名 slot 并可见', slotted.t && slotted.slot === 'body' && slotted.visible, JSON.stringify(slotted));
    const sameLine = await cdp.evalIn(pageSession, '(function(){ function chk(sel, srcSel){ const box = document.querySelector(sel); const t = box && box.querySelector(".wpt-translation"); if (!t) return "none";' +
      ' const rg = document.createRange(); const src = srcSel ? box.querySelector(srcSel) : box.firstChild; rg.selectNodeContents(src); const s = rg.getClientRects()[0]; const r = t.getClientRects()[0];' +
      ' return t.style.display + (Math.abs(r.top - s.top) < s.height ? ":same-line" : ":below"); }' +
      ' return { flair: chk("#e2e-flair"), sort: chk("#e2e-sort", "span") }; })()');
    check('块之间的短文字、行内块里的短标签：译文在同一行', sameLine.flair === 'inline:same-line' && sameLine.sort === 'inline:same-line', JSON.stringify(sameLine));
    check('横向导航：短标签译文行内同一行，放不下的撤掉', menu[0] === 'inline:same-line' && menu[1] === 'inline:same-line' && menu[2] === 'none', JSON.stringify(menu));

    const stats = await httpJson(MOCK + '/__stats');
    check('确实发起了 API 请求', stats.requests > 0, 'requests=' + stats.requests);
    check('请求走流式（SSE）', stats.streamed === stats.requests, 'streamed=' + stats.streamed + ' / ' + stats.requests);
    check('批量打包生效（存在多段批次）', stats.batches.some((n) => n > 1), JSON.stringify(stats.batches));
    check('请求段数不超过单元数（相同文本去重生效）', stats.segments <= state.total, 'segments=' + stats.segments + ' total=' + state.total);
    check('请求段数覆盖全部译文节点', stats.segments >= dom.count, 'segments=' + stats.segments + ' rendered=' + dom.count);

    const titles = await cdp.evalIn(pageSession, '(function(){ const p = document.querySelector("#e2e-narrow p"); const s = document.querySelectorAll("#e2e-menu li span")[2]; return [p.title, s.title]; })()');
    check('撤掉的译文改挂在悬停提示上', titles.every(function (t) { return /[\u4e00-\u9fff]/.test(t); }), JSON.stringify(titles));
    await cdp.evalIn(optSession, '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); await chrome.tabs.sendMessage(tabs[0].id, { type: "wpt:restore" }); return true; })()');
    await sleep(400);
    const afterRestore = await cdp.evalIn(pageSession, 'document.querySelectorAll(".wpt-translation").length');
    check('还原原文后译文清空', afterRestore === 0, 'left=' + afterRestore);
    const titlesLeft = await cdp.evalIn(pageSession, 'document.querySelectorAll("#e2e-narrow [title], #e2e-menu [title]").length');
    check('还原后悬停提示一并摘掉', titlesLeft === 0, 'left=' + titlesLeft);

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
