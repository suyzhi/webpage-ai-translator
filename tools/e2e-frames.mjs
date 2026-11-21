#!/usr/bin/env node
/*
 * 子框架（iframe）端到端测试：顶层页面翻译时，同源与跨源 iframe 里的内容（Cookie 同意框、嵌入内容）一并翻译；
 * 太小的框架（广告位）不翻；提示只在顶层出现一次；还原时所有框架一起还原。
 * 关闭站点隔离，使跨源框架与顶层同进程，便于用 CDP 在每个框架的隔离世界里检查 DOM。
 *
 * 用法：node tools/e2e-frames.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log('[frames]', ...a);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

function flatten(tree, out) {
  out.push(tree.frame);
  for (const c of tree.childFrames || []) flatten(c, out);
  return out;
}

async function main() {
  const port = await freePort();
  const MOCK = 'http://127.0.0.1:' + port;
  let mock = null, browser = null;
  try {
    mock = spawnMockServer({ root: ROOT, port, pseudoZh: true });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-frames-')),
      args: ['--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials'] });
    const { cdp } = browser;
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;
    const opt = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options/options.html' });
    const optS = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, optS);
    await waitFor('设置页就绪', async () => (await cdp.evalIn(optS, 'document.readyState')) === 'complete', 15000);
    const settings = { provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN',
      displayMode: 'bilingual', concurrency: 4, streaming: false, animations: false };
    await cdp.evalIn(optS, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(settings) + ' }); return true; })()');

    const page = await cdp.send('Target.createTarget', { url: MOCK + '/demo/frames.html' });
    const ps = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, ps);
    await cdp.send('Page.enable', {}, ps);
    await waitFor('页面与框架加载', async () => {
      const frames = flatten((await cdp.send('Page.getFrameTree', {}, ps)).frameTree, []);
      return frames.length >= 4 && frames.every((f) => f.url && f.url !== 'about:blank');
    }, 15000, 200);

    const tabExpr = '(async () => { const t = (await chrome.tabs.query({ url: "' + MOCK + '/demo/frames.html" }))[0]; return t ? t.id : null; })()';
    const tabId = await cdp.evalIn(optS, tabExpr);
    const send = (type) => cdp.evalIn(optS, '(async () => { try { return await chrome.tabs.sendMessage(' + tabId + ', { type: "' + type + '" }); } catch (e) { return { error: String(e) }; } })()');
    const r = await cdp.evalIn(optS, '(async () => chrome.runtime.sendMessage({ type: "wpt:inject", tabId: ' + tabId + ', toggle: true }))()');
    check('注入并开始翻译', r && r.ok, JSON.stringify(r));
    const st = await waitFor('顶层翻译完成', async () => { const x = await send('wpt:state'); return x && x.status === 'done' ? x : null; }, 30000, 300);
    check('状态查询由顶层应答', st.status === 'done' && st.translated > 0, JSON.stringify({ status: st.status, translated: st.translated }));

    // 在每个框架的隔离世界里数译文
    const countIn = async () => {
      const frames = flatten((await cdp.send('Page.getFrameTree', {}, ps)).frameTree, []);
      const out = {};
      for (const f of frames) {
        const key = f.parentId ? (/[?&]?(same|cross|tiny|late)$/.exec(f.url) || [null, f.url])[1] : 'top';
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'wpt-check' }, ps);
        const res = await cdp.send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
          expression: '({ n: document.querySelectorAll(".wpt-translation").length, ui: !!document.querySelector("wpt-ui") })' }, ps);
        out[key] = res.result.value;
      }
      return out;
    };
    const frames = await waitFor('框架内译文出现', async () => {
      const c = await countIn();
      return c.same && c.same.n > 0 && c.cross && c.cross.n > 0 ? c : null;
    }, 20000, 400).catch(async () => countIn());
    check('同源 iframe 内容被翻译', frames.same && frames.same.n >= 2, JSON.stringify(frames.same));
    check('跨源 iframe 内容被翻译（Cookie 同意框式）', frames.cross && frames.cross.n >= 2, JSON.stringify(frames.cross));
    check('太小的框架（广告位）不翻译', frames.tiny && frames.tiny.n === 0, JSON.stringify(frames.tiny));
    check('提示只在顶层出现', !frames.same.ui && !frames.cross.ui, JSON.stringify(frames));

    // 晚到的框架（Cookie 同意框常在页面加载完后才插入）：翻译完成后再插入，也应被翻译
    await cdp.evalIn(ps, '(function(){ const f = document.createElement("iframe"); f.src = "http://localhost:' + port + '/demo/frame-content.html?late"; f.style.cssText = "width:640px;height:220px"; document.body.appendChild(f); return true; })()');
    const late = await waitFor('晚到框架被翻译', async () => {
      const c = await countIn();
      return c.late && c.late.n > 0 ? c.late : null;
    }, 15000, 400).catch(async () => (await countIn()).late);
    const childStates = await cdp.evalIn(optS, '(async () => { const r = await chrome.scripting.executeScript({ target: { tabId: ' + tabId + ', allFrames: true }, func: () => location.search }); const out = []; for (const x of r) { if (!x.frameId) continue; try { const st = await chrome.tabs.sendMessage(' + tabId + ', { type: "wpt:state", debug: true, child: true }, { frameId: x.frameId }); out.push(x.result + " " + JSON.stringify({ status: st.status, total: st.total, translated: st.translated, error: st.error })); } catch (e) { out.push(x.result + " ERR " + e); } } return out; })()');
    log('子框架状态：' + JSON.stringify(childStates));
    check('页面加载完后才插入的 iframe 也被翻译', late && late.n >= 2, JSON.stringify(late));

    await send('wpt:restore');
    const after = await waitFor('全部还原', async () => {
      const c = await countIn();
      return Object.values(c).every((x) => x.n === 0) ? c : null;
    }, 10000, 300).catch(async () => countIn());
    check('还原时所有框架一起还原', Object.values(after).every((x) => x.n === 0), JSON.stringify(after));
  } catch (e) {
    check('框架测试抛出异常', false, e && e.message);
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) { /* 忽略 */ }
      killTree(browser.proc);
      try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    if (mock) killTree(mock);
  }
  for (const c of checks) console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + (c.detail ? '  -> ' + c.detail : ''));
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.error('[frames] ' + failed + '/' + checks.length + ' 项断言失败'); return 1; }
  log('全部通过：' + checks.length + ' 项断言');
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
