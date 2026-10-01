#!/usr/bin/env node
/*
 * 社交媒体场景端到端测试（零依赖）。
 *
 * 默认使用 demo/social.html（仿 X 深色时间线，计数 / 计时每秒跳动、侧栏整块重渲染、无限滚动、虚拟列表回收）：
 *   1. 人名、@用户名、#话题、$代码、比分、计数、时间、已是中文 / lang="zh" 的推文 —— 都不出现译文；
 *   2. 英文 / 日文推文正常翻译，导航等界面词正常翻译；
 *   3. 「翻译完成」只提示一次；页面持续跳动的 10 秒内不再弹出任何提示、不产生新请求；
 *   4. 无限滚动新增推文静默增量翻译；虚拟列表回收再挂载不发请求（页面级备忘）；推文被编辑后重译。
 *
 * 也可以对真实网站做稳定性冒烟（不登录的公开页面）：
 *   node tools/e2e-social.mjs --url https://mastodon.social/explore [--lang en-US]
 * 此模式在观察期内像读者一样持续向下滚动（触发虚拟列表回收与无限加载），只断言：
 * 能完成翻译并渲染译文、完成提示只出现一次、滚动加载新内容时不反复弹窗、无扩展异常。
 *
 * 退出码：0 通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log('[social]', ...args);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
const urlArg = process.argv.indexOf('--url');
const REAL_URL = urlArg >= 0 ? process.argv[urlArg + 1] : null;
const IDLE_MS = REAL_URL ? 20000 : 10000;
const langArg = process.argv.indexOf('--lang');
const LANG = langArg >= 0 ? process.argv[langArg + 1] : null;

/* 注入页面主世界：记录每一次提示框出现（文本变化即计一次） */
const TOAST_WATCH = '(function(){ if (window.__toasts) return true; window.__toasts = []; let last = ""; setInterval(function(){' +
  ' const h = document.querySelector("wpt-ui"); const box = h && h.shadowRoot && h.shadowRoot.querySelector(".box.show");' +
  ' const t = box ? box.querySelector(".t").textContent : "";' +
  ' if (t && t !== last && !/^正在翻译/.test(t)) window.__toasts.push({ at: Date.now(), text: t }); last = t; }, 40); return true; })()';

async function main() {
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  let mock = null, browser = null;
  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, delay: 250, copyProper: true });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    browser = await launchBrowser({
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-social-')),
      args: LANG ? ['--lang=' + LANG, '--accept-lang=' + LANG] : []
    });
    const cdp = browser.cdp;
    const pageErrors = [];
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;

    const attach = async (url) => {
      const t = await cdp.send('Target.createTarget', { url });
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, s);
      await waitFor('页面加载 ' + url, async () => (await cdp.evalIn(s, 'document.readyState')) === 'complete', 45000, 300);
      return s;
    };
    const ext = await attach('chrome-extension://' + extId + '/src/options/options.html');
    await cdp.evalIn(ext, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify({
      provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN', displayMode: 'bilingual', concurrency: 6
    }) + ' }); return true; })()');

    const PAGE = REAL_URL || (MOCK + '/demo/social.html');
    const page = await attach(PAGE);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== page) return;
      const d = p.exceptionDetails || {};
      const text = (d.exception && d.exception.description) || d.text || '';
      // 真实网站自身的脚本错误与扩展无关；只统计扩展脚本抛出的异常
      if (!REAL_URL || /chrome-extension:|wpt/i.test(text + (d.url || ''))) pageErrors.push(text.slice(0, 200));
    });
    if (REAL_URL) {
      // 等 SPA 渲染出首屏内容；网站本身没加载出来时如实报告，而不是误报为扩展问题
      const ok = await waitFor('页面渲染内容', async () => (await cdp.evalIn(page, 'document.body ? document.body.innerText.length : 0')) > 300 || null, 45000, 500).catch(() => false);
      if (!ok) throw new Error('真实网站未能加载出内容（网络或站点问题），本次不作判断');
      await delay(2500);
    }
    await cdp.evalIn(page, TOAST_WATCH);

    const host = new URL(PAGE).host;
    const tabExpr = (body) => '(async () => { const tabs = await chrome.tabs.query({}); const tab = tabs.filter(function(t){ return t.url && t.url.indexOf("' + host + '") >= 0; })[0]; const id = tab.id; ' + body + ' })()';
    const stateOf = () => cdp.evalIn(ext, tabExpr('try { return await chrome.tabs.sendMessage(id, { type: "wpt:state" }); } catch (e) { return null; }'));
    await cdp.evalIn(ext, tabExpr('return await chrome.runtime.sendMessage({ type: "wpt:inject", tabId: id, toggle: true });'));
    const st = await waitFor('翻译完成', async () => { const s = await stateOf(); return s && s.status === 'done' ? s : null; }, 120000, 400);
    check('翻译完成且无失败', st.failed === 0, 'total=' + st.total + ' translated=' + st.translated + ' failed=' + st.failed);
    await delay(800);

    const has = (sel) => '(function(){ const e = document.querySelector(' + JSON.stringify(sel) + '); return e ? !!e.querySelector(".wpt-translation") : null; })()';
    const anyIn = (sel) => '[].filter.call(document.querySelectorAll(' + JSON.stringify(sel) + '), function(e){ return e.querySelector(".wpt-translation"); }).length';

    if (!REAL_URL) {
      /* ---- 1/2. 该翻的翻、不该翻的不翻 ---- */
      const not = {
        '人名（模型原样返回）': await cdp.evalIn(page, anyIn('article .name')),
        '@用户名': await cdp.evalIn(page, anyIn('.handle')),
        '相对时间（已是中文）': await cdp.evalIn(page, anyIn('.time')),
        '计数 / 浏览量': await cdp.evalIn(page, anyIn('.actions span')),
        '视频计时': await cdp.evalIn(page, anyIn('.timer')),
        '#话题 / $代码': await cdp.evalIn(page, '[].filter.call(document.querySelectorAll(".trend"), function(e){ return /^[#$]/.test(e.textContent) && e.querySelector(".wpt-translation"); }).length'),
        '球队名与比分': await cdp.evalIn(page, anyIn('#scores .team')),
        '已是中文的推文': await cdp.evalIn(page, anyIn('article[data-idx="4"] .text')),
        'lang="zh" 的推文': await cdp.evalIn(page, anyIn('article[data-idx="3"] .text')),
        '中文界面文字': await cdp.evalIn(page, anyIn('.when, .more, #trends h2')),
        '短按钮（Follow）': await cdp.evalIn(page, anyIn('button.follow')),
        '具体元素上的 notranslate 声明': await cdp.evalIn(page, anyIn('.pinned')),
        '虚拟列表离屏占位（aria-hidden + 透明）': await cdp.evalIn(page, anyIn('article.placeholder'))
      };
      for (const k of Object.keys(not)) check('不翻译：' + k, not[k] === 0, '出现译文 ' + not[k] + ' 处');
      check('翻译：英文推文（lang="en"）', await cdp.evalIn(page, has('article[data-idx="0"] .text')), '');
      check('翻译：英文推文（无 lang）', await cdp.evalIn(page, has('article[data-idx="6"] .text')), '');
      check('翻译：日文推文（lang="ja"）', await cdp.evalIn(page, has('article[data-idx="5"] .text')), '');
      check('翻译：导航界面词', await cdp.evalIn(page, anyIn('nav.side a')) >= 5, '');
      const dupNames = await cdp.evalIn(page, '[].filter.call(document.querySelectorAll(".wpt-translation"), function(n){ const p = n.parentElement; return p && p.firstChild && p.firstChild.nodeValue && p.firstChild.nodeValue.trim() === n.textContent.trim(); }).length');
      check('没有「Phyrex Phyrex」式重复', dupNames === 0, 'dup=' + dupNames);
    } else {
      check('真实页面：渲染出译文', st.translated > 0, 'translated=' + st.translated);
    }

    /* ---- 3. 页面持续变化时不反复弹窗、不产生请求 ---- */
    const toasts1 = await cdp.evalIn(page, 'window.__toasts.slice()');
    const doneShows = toasts1.filter((t) => /翻译完成/.test(t.text)).length;
    check('「翻译完成」只提示一次', doneShows === 1, JSON.stringify(toasts1.map((t) => t.text)));
    const reqBefore = (await httpJson(MOCK + '/__stats')).requests;
    const t0 = Date.now();
    log('空闲观察 ' + IDLE_MS / 1000 + ' 秒（页面持续跳动 / 重渲染）…');
    if (REAL_URL) {
      // 像读者一样滚动：触发虚拟列表回收、懒加载与无限滚动
      for (let waited = 0; waited < IDLE_MS; waited += 2000) {
        await cdp.evalIn(page, 'window.scrollBy(0, Math.round(innerHeight * 0.8)); true');
        await delay(2000);
      }
    } else {
      await delay(IDLE_MS);
    }
    const toastsIdle = (await cdp.evalIn(page, 'window.__toasts.slice()')).filter((t) => t.at >= t0);
    const reqIdle = (await httpJson(MOCK + '/__stats')).requests - reqBefore;
    check(REAL_URL ? '滚动加载期间不再弹出提示' : '空闲期不弹出任何提示', toastsIdle.length === 0, JSON.stringify(toastsIdle.map((t) => t.text)));
    if (!REAL_URL) check('空闲期不产生新请求（计数跳动 / 侧栏重渲染不触发翻译）', reqIdle === 0, 'requests=' + reqIdle);
    else {
      const after = await stateOf();
      log('滚动期间增量请求 ' + reqIdle + ' 次；段落 ' + st.total + ' -> ' + (after && after.total) + '，译文 ' + (after && after.translated));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
      const out = path.join(os.tmpdir(), 'wpt-social-real.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      log('截图：' + out);
    }

    if (!REAL_URL) {
      /* ---- 4. 无限滚动 / 虚拟列表 / 编辑 ---- */
      const r0 = (await httpJson(MOCK + '/__stats')).requests;
      await cdp.evalIn(page, 'window.social.loadMore()');
      const loaded = await waitFor('新推文翻译', async () => {
        const n = await cdp.evalIn(page, '[].filter.call(document.querySelectorAll("article"), function(a){ return Number(a.dataset.idx) >= 8 && a.querySelector(".text .wpt-translation"); }).length');
        return n === 5 ? n : null;
      }, 20000, 250).catch(() => 0);
      check('无限滚动：新推文增量翻译', loaded === 5, 'translated=' + loaded + '/5');
      check('无限滚动：静默完成（不弹提示）', (await cdp.evalIn(page, 'window.__toasts.length')) === toasts1.length, '');
      const r1 = (await httpJson(MOCK + '/__stats')).requests;
      check('无限滚动：确实发起了请求', r1 > r0, 'requests=' + (r1 - r0));

      await cdp.evalIn(page, 'window.social.recycle()');
      const back = await waitFor('回收推文复用译文', async () => {
        const ok = await cdp.evalIn(page, has('article[data-idx="0"] .text'));
        return ok ? true : null;
      }, 8000, 150).catch(() => false);
      await delay(1500);
      const r2 = (await httpJson(MOCK + '/__stats')).requests;
      check('虚拟列表回收：重新挂载的推文立即显示译文', back, '');
      check('虚拟列表回收：不发请求（页面级备忘）', r2 === r1, 'requests=' + (r2 - r1));

      await cdp.evalIn(page, 'window.social.edit()');
      const edited = await waitFor('编辑后重译', async () => {
        const t = await cdp.evalIn(page, '(function(){ const n = document.querySelector("article[data-idx=\\"6\\"] .text .wpt-translation"); return n ? n.textContent : ""; })()');
        return /Edited/.test(t) ? t : null;
      }, 15000, 250).catch(() => null);
      check('推文被编辑后重译', !!edited, edited || 'timeout');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
      const out = path.join(os.tmpdir(), 'wpt-social.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      log('截图：' + out);
    }

    const dups = await cdp.evalIn(page, '(function(){ let n = 0; const seen = new Map(); document.querySelectorAll(".wpt-translation").forEach(function(t){ const k = t.parentNode; const list = seen.get(k) || []; if (list.indexOf(t.textContent) >= 0) n++; list.push(t.textContent); seen.set(k, list); }); return n; })()');
    check('没有重复插入的译文', dups === 0, 'duplicates=' + dups);
    check('无扩展运行时异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } catch (err) {
    check('社交测试抛出异常', false, err && err.message);
    console.error('[social] 失败：' + (err && err.stack ? err.stack : err));
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
  if (failed) { console.error('[social] ' + failed + '/' + checks.length + ' 项断言失败'); return 1; }
  log('全部通过：' + checks.length + ' 项断言');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  if (err && err.code === 'NO_BROWSER') { console.error(err.message); process.exit(2); }
  console.error(err);
  process.exit(1);
});
