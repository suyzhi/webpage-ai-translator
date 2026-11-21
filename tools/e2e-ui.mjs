#!/usr/bin/env node
/*
 * 插件 UI 回归（零依赖）：真实加载扩展，打开 popup / options 页面，
 *  - 断言关键布局与控件（并发上限 32、分区导航、快捷并发、label[for] 关联）；
 *  - 通过真实点击验证设置保存链路（选项页点击「8」-> chrome.storage 生效）；
 *  - 输出浅色/深色截图到 WPT_UI_OUT（默认 /tmp/wpt-ui）便于人工查看。
 *
 * 用法：node tools/e2e-ui.mjs
 * 退出码：0 通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.WPT_UI_OUT || path.join(os.tmpdir(), 'wpt-ui');
const KEEP = !!process.env.WPT_E2E_KEEP;
const log = (...args) => console.log('[ui]', ...args);
const sleep = (ms) => delay(ms);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

async function attach(cdp, url) {
  const t = await cdp.send('Target.createTarget', { url: url });
  const session = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('Page.enable', {}, session);
  return session;
}

async function shot(cdp, session, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* 后台标签的渲染时间线可能被节流，CSS 过渡会卡在起始值；截图前先冻结过渡以保证确定性。 */
async function freezeTransitions(cdp, session) {
  await cdp.evalIn(session, '(function(){ const st = document.createElement("style"); st.textContent = "*{transition:none !important;animation:none !important}"; document.documentElement.appendChild(st); return true; })()');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  let mock = null;
  let browser = null;
  let exitCode = 0;

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, dict: 'demo/showcase-dict.json' });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);

    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-ui-')) });
    const cdp = browser.cdp;
    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      pageErrors.push({ sessionId: sessionId, text: (params && params.exceptionDetails && params.exceptionDetails.text) || 'error' });
    });

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    const extId = loaded.id;
    const EXT = 'chrome-extension://' + extId;
    log('扩展：' + extId);

    // 先给扩展写好 mock 设置，避免页面出现「未配置密钥」噪音
    const bootSession = await attach(cdp, EXT + '/src/options/options.html');
    await waitFor('设置页就绪', async () => (await cdp.evalIn(bootSession, 'document.readyState')) === 'complete', 15000);
    await cdp.evalIn(bootSession, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify({
      provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN', displayMode: 'bilingual', concurrency: 4
    }) + ' }); return true; })()');

    // --- options 页面 ---
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1500, deviceScaleFactor: 2, mobile: false }, bootSession);
    await cdp.evalIn(bootSession, 'location.reload()').catch(() => {});
    await sleep(1200);
    const opt = await cdp.evalIn(bootSession, '(function(){ return { max: document.querySelector("#concurrency").max, tabs: document.querySelectorAll("#tabs a").length, presets: document.querySelectorAll("#presets .chip").length, concPresets: document.querySelectorAll("#concPresets .chip").length, labels: document.querySelectorAll("label.label[for]").length, cards: document.querySelectorAll("section.card[id]").length, presetActive: [].filter.call(document.querySelectorAll("#concPresets .chip"), function(c){ return c.getAttribute("aria-pressed") === "true"; }).length }; })()');
    check('options：并发滑块上限为 32', opt.max === '32', 'max=' + opt.max);
    check('options：三个分区导航', opt.tabs === 3, 'tabs=' + opt.tabs);
    check('options：服务商预设渲染', opt.presets >= 10, 'presets=' + opt.presets);
    check('options：并发快捷档位 5 个', opt.concPresets === 5, opt.concPresets);
    check('options：label[for] 关联充分', opt.labels >= 12, 'labels=' + opt.labels);
    check('options：三个分区卡片', opt.cards === 3, opt.cards);
    check('options：当前并发档位高亮', opt.presetActive === 1, opt.presetActive);

    // 真实点击「8」档 -> 存储生效
    await cdp.evalIn(bootSession, '[].filter.call(document.querySelectorAll("#concPresets .chip"), function(c){ return c.dataset.value === "8"; })[0].click(); true');
    await sleep(700);
    const saved = await cdp.evalIn(bootSession, '(async () => { const g = await chrome.storage.local.get("wpt.settings.v1"); return g["wpt.settings.v1"].concurrency; })()');
    check('options：点击 8 档后设置已保存', saved === 8, 'concurrency=' + saved);

    // 推理模型提示：普通模型不显示，填入推理模型后显示（之后改回，避免影响后续截图）
    const warnVisible = () => cdp.evalIn(bootSession, 'getComputedStyle(document.getElementById("modelWarn")).display !== "none"');
    const setModel = (m) => cdp.evalIn(bootSession, '(function(){ const el = document.getElementById("model"); el.value = ' + JSON.stringify(m) + '; el.dispatchEvent(new Event("change")); return true; })()');
    check('options：普通模型不显示推理模型提示', !(await warnVisible()));
    const prevModel = await cdp.evalIn(bootSession, 'document.getElementById("model").value');
    await setModel('deepseek-reasoner');
    await sleep(500);
    check('options：推理模型显示提示', await warnVisible());
    await setModel(prevModel);
    await sleep(500);

    await freezeTransitions(cdp, bootSession);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, bootSession);
    await sleep(300);
    const light = await shot(cdp, bootSession, 'options-light.png');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, bootSession);
    await sleep(300);
    const dark = await shot(cdp, bootSession, 'options-dark.png');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }, bootSession);
    log('options 截图：' + light + ' / ' + dark);

    // --- 打开演示页并翻译，让 popup 有真实状态 ---
    const demo = await attach(cdp, MOCK + '/demo/showcase.html');
    await waitFor('演示页加载', async () => (await cdp.evalIn(demo, 'document.readyState')) === 'complete', 20000);
    const st = '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); if (!tabs.length) return null; try { return await chrome.tabs.sendMessage(tabs[0].id, { type: "wpt:state" }); } catch (e) { return null; } })()';
    await cdp.evalIn(bootSession, '(async () => { const tabs = await chrome.tabs.query({ url: "' + MOCK + '/*" }); await chrome.runtime.sendMessage({ type: "wpt:inject", tabId: tabs[0].id, toggle: true }); return true; })()');
    const done = await waitFor('演示页翻译完成', async () => {
      const s = await cdp.evalIn(bootSession, st);
      return s && s.status === 'done' ? s : null;
    }, 60000, 400);
    check('popup 前置：演示页已翻译', done.translated > 0, 'translated=' + done.translated);

    // --- popup 页面（后台标签，保持演示页为活动标签）---
    let popAttr;
    try { popAttr = await cdp.send('Target.createTarget', { url: EXT + '/src/popup/popup.html', background: true }); }
    catch (e) { popAttr = await cdp.send('Target.createTarget', { url: EXT + '/src/popup/popup.html' }); }
    const popSession = (await cdp.send('Target.attachToTarget', { targetId: popAttr.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, popSession);
    await cdp.send('Page.enable', {}, popSession);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 640, deviceScaleFactor: 2, mobile: false }, popSession);
    await waitFor('popup 就绪', async () => (await cdp.evalIn(popSession, 'document.readyState')) === 'complete', 15000);
    await freezeTransitions(cdp, popSession);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, popSession);
    await sleep(900);
    const pop = await cdp.evalIn(popSession, '(function(){ return { hasConcurrency: !!document.querySelector("#concurrency"), hasRestore: !!document.querySelector("#restoreBtn"), quickHead: document.querySelector(".quick-head") ? document.querySelector(".quick-head").textContent : "", pill: document.querySelector("#statusPill").textContent, main: document.querySelector("#mainBtn").textContent, restoreHidden: document.querySelector("#restoreBtn").classList.contains("hidden") }; })()');
    check('popup：不展示并发等性能调优项（在设置页「性能与可靠性」里）', !pop.hasConcurrency, pop.hasConcurrency);
    check('popup：存在还原按钮', pop.hasRestore, pop.hasRestore);
    check('popup：显示当前状态', !!pop.pill, pop.pill + ' / ' + pop.main);
    const popH = await cdp.evalIn(popSession, 'Math.ceil(document.querySelector(".foot").getBoundingClientRect().bottom + window.scrollY)');
    check('popup：内容高度不超过浏览器弹窗上限 600px（不出现滚动条）', popH <= 600, 'height=' + popH);
    const popFile = await shot(cdp, popSession, 'popup.png');
    log('popup 截图：' + popFile + '；状态=' + pop.pill + '，主按钮=' + pop.main);

    const extErrors = pageErrors.filter((e) => e.sessionId === bootSession || e.sessionId === popSession);
    check('扩展页面无运行时异常', extErrors.length === 0, JSON.stringify(extErrors).slice(0, 300));
  } catch (err) {
    check('UI 测试抛出异常', false, err && err.message);
    console.error('[ui] 失败：' + (err && err.stack ? err.stack : err));
    if (browser && browser.stderr.length) console.error('[ui] 浏览器日志：\n' + browser.stderr.join('').slice(-1000));
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
  if (failed) { console.error('[ui] ' + failed + '/' + checks.length + ' 项断言失败'); exitCode = 1; }
  else log('全部通过：' + checks.length + ' 项断言');
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  if (err && err.code === 'NO_BROWSER') { console.error(err.message); process.exit(2); }
  console.error(err);
  process.exit(1);
});
