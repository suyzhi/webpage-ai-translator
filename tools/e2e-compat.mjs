#!/usr/bin/env node
/*
 * 特殊网页兼容性端到端测试（零依赖，Node 18+）：
 * 覆盖此前最容易出现「无法翻译 / 漏翻 / 误撤译文」的 8 类真实网页形态：
 *   1. Trusted Types CSP（require-trusted-types-for 'script'）
 *   2. XHTML（application/xhtml+xml，小写标签名 + <body> 内 <script>/<pre>）
 *   3. 经典 <frameset> 多框架文档（如 Javadoc）
 *   4. 以 srcdoc / about:blank iframe 为主体的页面（顶层无正文、状态与还原需联动）
 *   5. text/plain 纯文本页面（RFC / .txt 文档，分段翻译且无损还原）
 *   6. 内部滚动容器（overflow-y:auto）：不把视口底边当裁切误撤译文，滚到底部自动懒翻译
 *   7. 全 div 结构 SPA 外壳同时挂着 class="notranslate" 与 lang="zh-CN"（界面语言为中文的英文内容页）
 *   8. 动态显现内容（opacity:0+overflow:hidden 滚动淡入、display:none 标签页、<details> 展开、
 *      原生 <dialog open>、普通元素上的 closed Shadow DOM、嵌套自定义元素、非代码 .highlight / .has-katex）
 *
 * 用法：node tools/e2e-compat.mjs   （CHROME_PATH 可指定浏览器）
 * 退出码：0 全部通过；1 断言失败；2 未找到浏览器。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log('[compat]', ...a);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

const PAGES = {
  '/trusted-types': {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'"
    },
    body: '<!doctype html><html><body><h1>Trusted Types Page Title</h1><p>This page enforces strict Trusted Types CSP and must still translate cleanly.</p></body></html>'
  },
  '/xhtml': {
    headers: { 'Content-Type': 'application/xhtml+xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>XHTML Test</title></head>' +
      '<body><script>const bodyScript = "do not translate inline body script";</script>' +
      '<pre>const bodyPre = "do not translate body pre block";</pre>' +
      '<h1>XHTML Document Heading</h1><p>This is a real XHTML document with lowercase tag names.</p></body></html>'
  },
  '/frameset': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN"><html><head><title>API Docs</title></head>' +
      '<frameset cols="30%,70%"><frame src="/frame-nav" name="nav"><frame src="/frame-main" name="main"></frameset></html>'
  },
  '/frame-nav': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body><h3>Package List</h3><ul><li>Core translation library module</li><li>Network transport handler</li></ul></body></html>'
  },
  '/frame-main': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body><h1>Class Documentation Overview</h1><p>This documentation lives inside a classic HTML frameset main frame.</p></body></html>'
  },
  '/srcdoc-iframe': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body>' +
      '<iframe id="f1" style="width:700px;height:240px" srcdoc="<html><body><h2>Email Subject Line</h2><p>Hello team, this email body is rendered inside an iframe srcdoc container.</p></body></html>"></iframe>' +
      '<iframe id="f2" style="width:700px;height:240px"></iframe>' +
      '<script>const d=document.getElementById("f2").contentDocument;d.open();d.write("<html><body><h2>Blank Frame Article</h2><p>Written dynamically into an about:blank same-origin iframe.</p></body></html>");d.close();</script>' +
      '</body></html>'
  },
  '/text-plain': {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: 'HTTP Semantics Specification\n\nThe Hypertext Transfer Protocol is a stateless application-level protocol for distributed hypertext information systems.\n\nThis document describes the overall architecture and establishes common terminology.'
  },
  '/inner-scroll': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html style="height:100%;overflow:hidden"><body style="margin:0;height:100%;overflow:hidden">' +
      '<main id="scroller" style="height:100vh;overflow-y:auto;padding:20px;box-sizing:border-box"><h1>Inner Scroll App</h1><div id="list"></div></main>' +
      '<script>const list=document.getElementById("list");for(let i=0;i<60;i++){const p=document.createElement("p");p.id="p"+i;p.style.cssText="margin:24px 0;font-size:18px;line-height:1.6";p.textContent="Scrollable application paragraph number "+i+" with enough English text to test inner scrolling.";list.appendChild(p);}</script>' +
      '</body></html>'
  },
  '/div-notranslate-and-lang': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body><div id="app" class="notranslate" lang="zh-CN">' +
      '<div><div>Welcome to our modern single page application built entirely with nested divs.</div></div>' +
      '<div><div>Every article and comment here is rendered inside div elements instead of p tags.</div></div>' +
      '<div><div>The outer shell has both notranslate and lang="zh-CN" because the UI locale is Chinese.</div></div>' +
      '</div></body></html>'
  },
  '/reveal-dialog-shadow': {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body>' +
      '<p>Top visible paragraph.</p>' +
      '<section id="aos" style="opacity:0;overflow:hidden"><p>Section revealed after scroll animation.</p></section>' +
      '<div id="tab" style="display:none"><p>Tab panel revealed after clicking a tab.</p></div>' +
      '<details id="det"><summary>Expand technical notes</summary><p>Hidden content inside a native HTML details element.</p></details>' +
      '<dialog id="dlg" open><p>Important announcement inside an open native HTML dialog.</p></dialog>' +
      '<div class="highlight"><p>Featured editorial callout using the CSS class highlight.</p></div>' +
      '<article class="has-katex"><p>Article container with has-katex class on the wrapper.</p></article>' +
      '<h2 style="display:flex;align-items:center;gap:8px"><span>●</span>Getting Started</h2>' +
      '<div id="closed-host"></div><x-app></x-app>' +
      '<script>' +
      'document.getElementById("closed-host").attachShadow({mode:"closed"}).innerHTML="<p>Paragraph inside a closed shadow root attached to a standard div.</p>";' +
      'const xa=document.querySelector("x-app");xa.attachShadow({mode:"open"}).innerHTML="<x-layout></x-layout>";' +
      'xa.shadowRoot.querySelector("x-layout").attachShadow({mode:"open"}).innerHTML="<div><h2>Nested Custom Element</h2><p>Paragraph inside nested default-inline custom elements.</p></div>";' +
      '</script></body></html>'
  }
};

async function main() {
  const mockPort = await freePort();
  const sitePort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  const SITE = 'http://127.0.0.1:' + sitePort;
  let mock = null, browser = null;

  const srv = http.createServer((req, res) => {
    const p = PAGES[req.url];
    if (!p) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, p.headers);
    res.end(p.body);
  });
  await new Promise((r) => srv.listen(sitePort, '127.0.0.1', r));

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort, pseudoZh: true });
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    browser = await launchBrowser({
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-compat-')),
      args: ['--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials']
    });
    const { cdp } = browser;
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;
    const opt = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options/options.html' });
    const optS = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, optS);
    await waitFor('设置页就绪', async () => (await cdp.evalIn(optS, 'document.readyState')) === 'complete', 15000);
    await cdp.evalIn(optS, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify({
      provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN',
      displayMode: 'bilingual', concurrency: 4, streaming: false, animations: false
    }) + ' }); return true; })()');

    async function openAndTranslate(route) {
      const url = SITE + route;
      const t = await cdp.send('Target.createTarget', { url });
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, s);
      await cdp.send('Page.enable', {}, s);
      await waitFor('页面加载 ' + route, async () => (await cdp.evalIn(s, 'document.readyState')) === 'complete', 15000);
      await delay(300);
      const tabId = await cdp.evalIn(optS, '(async () => (await chrome.tabs.query({ url: ' + JSON.stringify(url) + ' }))[0]?.id)()');
      await cdp.evalIn(optS, '(async () => chrome.runtime.sendMessage({ type: "wpt:inject", tabId: ' + tabId + ', toggle: true }))()');
      const st = await waitFor('翻译完成 ' + route, async () => {
        const x = await cdp.evalIn(optS, '(async () => { try { return await chrome.tabs.sendMessage(' + tabId + ', { type: "wpt:state" }, { frameId: 0 }); } catch (e) { return null; } })()');
        return x && (x.status === 'done' || x.status === 'error') ? x : null;
      }, 20000, 250);
      return { targetId: t.targetId, s, tabId, st };
    }

    // 1. Trusted Types CSP
    {
      const p = await openAndTranslate('/trusted-types');
      const n = await cdp.evalIn(p.s, 'document.querySelectorAll(".wpt-translation").length');
      check('Trusted Types CSP 页面正常翻译且无异常', p.st.status === 'done' && n === 2, 'n=' + n);
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 2. XHTML
    {
      const p = await openAndTranslate('/xhtml');
      const r = await cdp.evalIn(p.s, '({ n: document.querySelectorAll(".wpt-translation").length, scriptTr: document.querySelectorAll("script .wpt-translation").length, preTr: document.querySelectorAll("pre .wpt-translation").length })');
      check('XHTML 页面：小写标签正文正常翻译，body 内 script/pre 被跳过', r.n === 2 && r.scriptTr === 0 && r.preTr === 0, JSON.stringify(r));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 3. <frameset>
    {
      const p = await openAndTranslate('/frameset');
      await waitFor('frameset 子框架完成', async () => {
        const x = await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:state" }, { frameId: 0 }))()');
        return x && x.translated >= 5 ? x : null;
      }, 15000, 250).catch(() => null);
      const st = await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:state" }, { frameId: 0 }))()');
      check('经典 frameset 页面翻译所有子框架并上报总数', st.status === 'done' && st.translated >= 5, JSON.stringify(st));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 4. srcdoc / about:blank iframe 主体页 + toggle 联动还原
    {
      const p = await openAndTranslate('/srcdoc-iframe');
      const before = await waitFor('iframe 译文出现', async () => {
        const r = await cdp.evalIn(p.s, '({ f1: document.getElementById("f1").contentDocument.querySelectorAll(".wpt-translation").length, f2: document.getElementById("f2").contentDocument.querySelectorAll(".wpt-translation").length })');
        return r.f1 >= 2 && r.f2 >= 2 ? r : null;
      }, 15000, 250);
      const st = await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:state" }, { frameId: 0 }))()');
      await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:toggle" }, { frameId: 0 }))()');
      await delay(500);
      const after = await cdp.evalIn(p.s, '({ f1: document.getElementById("f1").contentDocument.querySelectorAll(".wpt-translation").length, f2: document.getElementById("f2").contentDocument.querySelectorAll(".wpt-translation").length })');
      check('srcdoc / about:blank iframe 主体页正常翻译且 toggle 联动还原',
        st.status === 'done' && st.translated >= 4 && before.f1 >= 2 && before.f2 >= 2 && after.f1 === 0 && after.f2 === 0,
        JSON.stringify({ status: st.status, translated: st.translated, before, after }));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 5. text/plain 纯文本页
    {
      const p = await openAndTranslate('/text-plain');
      const before = await cdp.evalIn(p.s, 'document.querySelectorAll(".wpt-translation").length');
      await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:restore" }, { frameId: 0 }))()');
      await delay(400);
      const after = await cdp.evalIn(p.s, '({ n: document.querySelectorAll(".wpt-translation").length, preShown: getComputedStyle(document.querySelector("pre")).display !== "none", wrap: !!document.querySelector(".wpt-plain-wrap") })');
      check('text/plain 纯文本页面分段翻译并无损还原', before === 3 && after.n === 0 && after.preShown && !after.wrap, JSON.stringify({ before, after }));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 6. 内部滚动容器
    {
      const p = await openAndTranslate('/inner-scroll');
      await delay(400);
      const midSt = await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:state" }, { frameId: 0 }))()');
      await cdp.evalIn(p.s, 'document.getElementById("scroller").scrollTop = 99999; true');
      const bottomOk = await waitFor('内部滚动到底部译文出现', async () => cdp.evalIn(p.s, '!!document.querySelector("#p59 .wpt-translation") && !!document.querySelector("#p58 .wpt-translation")'), 15000, 250).catch(() => false);
      const endSt = await cdp.evalIn(optS, '(async () => chrome.tabs.sendMessage(' + p.tabId + ', { type: "wpt:state" }, { frameId: 0 }))()');
      check('内部滚动容器（overflow-y:auto）不误撤译文，滚到底部自动懒翻译', midSt.dropped === 0 && endSt.dropped === 0 && bottomOk, JSON.stringify({ dropped: endSt.dropped, bottomOk }));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 7. 全 div SPA 外壳 notranslate + lang="zh-CN"
    {
      const p = await openAndTranslate('/div-notranslate-and-lang');
      const n = await cdp.evalIn(p.s, 'document.querySelectorAll(".wpt-translation").length');
      check('全 div SPA 外壳挂 notranslate + lang="zh-CN" 仍正常翻译英文内容', n === 3, 'n=' + n);
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }

    // 8. 动态显现 + dialog + 非代码 highlight/katex + flex 标题 + closed shadow div + 嵌套自定义元素
    {
      const p = await openAndTranslate('/reveal-dialog-shadow');
      await cdp.evalIn(p.s, 'document.getElementById("aos").style.opacity = "1"; document.getElementById("tab").style.display = "block"; document.getElementById("det").open = true; true');
      const res = await waitFor('动态显现元素全部翻译', async () => {
        const r = await cdp.evalIn(p.s, `({
          aos: !!document.querySelector('#aos .wpt-translation'),
          tab: !!document.querySelector('#tab .wpt-translation'),
          det: !!document.querySelector('#det p .wpt-translation'),
          dlg: !!document.querySelector('#dlg .wpt-translation'),
          highlight: !!document.querySelector('.highlight .wpt-translation'),
          katex: !!document.querySelector('.has-katex .wpt-translation'),
          flexH2: !!document.querySelector('h2 .wpt-translation, h2 + .wpt-translation'),
          nestedShadow: !!document.querySelector('x-app').shadowRoot.querySelector('x-layout').shadowRoot.querySelector('.wpt-translation')
        })`);
        return Object.values(r).every(Boolean) ? r : null;
      }, 15000, 300).catch(async () => cdp.evalIn(p.s, `({
        aos: !!document.querySelector('#aos .wpt-translation'),
        tab: !!document.querySelector('#tab .wpt-translation'),
        det: !!document.querySelector('#det p .wpt-translation'),
        dlg: !!document.querySelector('#dlg .wpt-translation'),
        highlight: !!document.querySelector('.highlight .wpt-translation'),
        katex: !!document.querySelector('.has-katex .wpt-translation'),
        flexH2: !!document.querySelector('h2 .wpt-translation, h2 + .wpt-translation'),
        nestedShadow: !!document.querySelector('x-app').shadowRoot.querySelector('x-layout').shadowRoot.querySelector('.wpt-translation')
      })`));
      res.closedDivShadow = await cdp.evalIn(optS, `(async () => {
        const r = await chrome.scripting.executeScript({
          target: { tabId: ${p.tabId} },
          func: () => { const sr = chrome.dom && chrome.dom.openOrClosedShadowRoot(document.getElementById('closed-host')); return !!(sr && sr.querySelector('.wpt-translation')); }
        });
        return !!(r && r[0] && r[0].result);
      })()`);
      check('动态显现（淡入 / 标签页 / details）、dialog、非代码 highlight/has-katex、flex 标题、closed 影子 div、嵌套自定义元素全部翻译',
        Object.values(res).every(Boolean), JSON.stringify(res));
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }
  } catch (e) {
    check('兼容性测试抛出异常', false, e && e.message);
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) {}
      killTree(browser.proc);
      try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) {}
    }
    if (mock) killTree(mock);
    srv.close();
  }

  for (const c of checks) console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + (c.detail ? '  -> ' + c.detail : ''));
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.error('[compat] ' + failed + '/' + checks.length + ' 项断言失败'); return 1; }
  log('全部通过：' + checks.length + ' 项断言');
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(e && e.code === 'NO_BROWSER' ? 2 : 1); });
