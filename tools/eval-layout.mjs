#!/usr/bin/env node
/*
 * 版面与打扰评测（零依赖）：真实加载扩展，在 tools/eval/sites.json 的真实网站上翻译首屏，
 * 译文来自 mock 服务的「伪中文」（长度接近真实英译中、可复现、无需密钥），然后检查：
 *   - 被裁切：译文落在 overflow 非 visible 的祖先之外（看不全）
 *   - 被遮挡：译文中心点被别的元素盖住
 *   - 自身溢出：译文横向超出自己的盒子
 *   - 新增横向滚动条：翻译后整页出现横向滚动
 *   - 提示停留：翻译完成后右下角提示还停留多久
 * 每站保存一张翻译后的首屏截图到 .cache/eval/shots/，供人工过目。
 *
 * 用法：node tools/eval-layout.mjs [--only a,b] [--label 名称]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ONLY = arg('only', '') ? new Set(arg('only').split(',')) : null;
const LABEL = arg('label', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const OUT_DIR = path.join(ROOT, '.cache', 'eval');
const SHOTS = path.join(OUT_DIR, 'shots');
const SITE_TIMEOUT = 75000;
const GLOBAL_DEADLINE = Date.now() + 14 * 60000;
const log = (...a) => console.log('[layout]', ...a);

const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/eval/sites.json'), 'utf8'))
  .filter((s) => !ONLY || ONLY.has(s.id));

/* 在页面主世界运行：沿组合树找出全部译文节点并逐个检查 */
const PROBE = `(function () {
  const nodes = [];
  (function find(root) {
    const list = root.querySelectorAll('.wpt-translation, *');
    for (const el of list) {
      if (el.classList && el.classList.contains('wpt-translation')) nodes.push(el);
      if (el.shadowRoot) find(el.shadowRoot);
    }
  })(document);
  const W = innerWidth, H = innerHeight;
  const res = { nodes: nodes.length, inView: 0, clipped: 0, occluded: 0, overflow: 0, empty: 0, samples: [],
    hScroll: document.documentElement.scrollWidth > W + 1 };
  const parentOf = (n) => n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentElement;
  const deepest = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el; };
  const desc = (el) => { if (!el) return ''; let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.'); return s.slice(0, 80); };
  // 不算「被译文问题遮挡」的情况：透明的点击层（如维基百科下拉菜单的隐形复选框），
  // 以及不包含该译文的固定 / 粘性浮层（Cookie 弹窗、吸顶导航）——它们同样盖住原文，与翻译无关
  const overlay = (hit, n) => {
    for (let x = hit; x && x !== document.documentElement; x = parentOf(x)) {
      const cs = getComputedStyle(x);
      if (cs.opacity === '0') return true;
      if ((cs.position === 'fixed' || cs.position === 'sticky') && !x.contains(n)) return true;
    }
    return false;
  };
  // 同一个元素也盖着原文（整行可点的透明链接层，如 GitHub 文件列表）：页面本来的设计，与译文无关
  const coversSource = (hit, src) => {
    if (!src) return false;
    const w = document.createTreeWalker(src, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (!t.nodeValue.trim() || (t.parentElement && t.parentElement.closest('.wpt-translation'))) continue;
      const rg = document.createRange(); rg.selectNodeContents(t);
      const q = rg.getClientRects()[0];
      if (!q) continue;
      const h = deepest(q.left + Math.min(q.width, 20) / 2, q.top + q.height / 2);
      return h === hit || (h && hit.contains(h));
    }
    return false;
  };
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { res.empty++; continue; }
    if (r.bottom < 0 || r.top > H) continue;              // 只评首屏（按需翻译也只翻这里）
    res.inView++;
    let why = '';
    // 原文（译文前面的兄弟或父元素）在容器可见范围内、译文却超出容器底边 = 被截；body / html 是页面滚动容器，不算
    const src = n.previousElementSibling || parentOf(n);
    const sr = src ? src.getBoundingClientRect() : r;
    // 定高祖先：overflow 非 visible 时译文被截（clipped），visible 时译文溢出压住后面的内容（spill）
    for (let a = parentOf(n); a && a !== document.documentElement && a !== document.body; a = parentOf(a)) {
      const cs = getComputedStyle(a);
      if (cs.display === 'contents' || /^inline/.test(cs.display)) continue;
      const ar = a.getBoundingClientRect();
      if (sr.top >= ar.bottom - 2 || sr.left >= ar.right - 2) break;     // 原文本身就在可见范围外：需要滚动，不算截
      const vis = cs.overflowX === 'visible' && cs.overflowY === 'visible';
      if (r.bottom > ar.bottom + 2 || (!vis && r.left >= ar.right - 2)) { why = (vis ? 'spills out of ' : 'clipped by ') + desc(a); break; }
    }
    if (why) res.clipped++;
    else {
      const cx = Math.min(W - 1, Math.max(0, r.left + Math.min(r.width, 40) / 2)), cy = r.top + Math.min(r.height, 20) / 2;
      if (cy >= 0 && cy < H) {
        const hit = deepest(cx, cy);
        if (hit && hit !== n && !n.contains(hit) && !hit.contains(n) && !overlay(hit, n) && !coversSource(hit, src)) { res.occluded++; why = 'covered by ' + desc(hit); }
      }
    }
    if (!why && n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).display !== 'inline') { res.overflow++; why = 'overflow'; }
    if (why && res.samples.length < 5) {
      const chain = [];
      for (let a = parentOf(n), i = 0; a && i < 4; a = parentOf(a), i++) chain.push(desc(a) + '{' + getComputedStyle(a).display + '}');
      const nav = n.closest && n.closest('nav,[role="navigation"],[role="menubar"],[role="tablist"]');
      res.samples.push({ why, where: desc(parentOf(n)), text: n.textContent.slice(0, 40), display: n.style.display,
        chain: chain.join(' < '), nav: nav ? desc(nav) + ' h=' + Math.round(nav.getBoundingClientRect().height) : null });
    }
  }
  return res;
})()`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  const mock = spawnMockServer({ root: ROOT, port: mockPort, pseudoZh: true, delay: 150 });
  let browser = null;
  const out = [];
  try {
    await waitFor('mock 服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);
    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-layout-')),
      args: ['--disable-blink-features=AutomationControlled', '--lang=en-US', '--mute-audio', '--window-size=1366,900'] });
    const { cdp } = browser;
    const ua = (await cdp.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: ROOT })).id;
    const opt = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options/options.html' });
    const optS = (await cdp.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, optS);
    await waitFor('设置页就绪', async () => (await cdp.evalIn(optS, 'document.readyState')) === 'complete', 15000);
    const settings = { provider: 'openai', baseUrl: MOCK + '/v1', apiKey: '', model: 'mock', targetLang: 'zh-CN',
      displayMode: 'bilingual', concurrency: 4, streaming: false };
    await cdp.evalIn(optS, '(async () => { await chrome.storage.local.set({ "wpt.settings.v1": ' + JSON.stringify(settings) + ' }); return true; })()');
    log('扩展 ' + extId + '；站点 ' + sites.length + ' 个');

    for (const site of sites) {
      if (Date.now() > GLOBAL_DEADLINE) break;
      const t0 = Date.now();
      let targetId = null;
      try {
        const r = await Promise.race([(async () => {
          ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
          const s = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
          await cdp.send('Runtime.enable', {}, s);
          await cdp.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9' }, s);
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, s);
          await cdp.send('Page.navigate', { url: site.url }, s);
          await waitFor('页面加载', async () => (await cdp.evalIn(s, 'document.readyState')) === 'complete', 25000, 300).catch(() => {});
          await delay(2500);
          const before = await cdp.evalIn(s, '({ hScroll: document.documentElement.scrollWidth > innerWidth + 1, href: location.href })');
          const tab = await cdp.evalIn(optS, '(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => x.url === ' + JSON.stringify(before.href) + '); if (!t) return null; const r = await chrome.runtime.sendMessage({ type: "wpt:inject", tabId: t.id, toggle: true }); return { id: t.id, ok: r && r.ok }; })()');
          if (!tab || !tab.ok) throw new Error('注入失败');
          const stateExpr = '(async () => { try { return await chrome.tabs.sendMessage(' + tab.id + ', { type: "wpt:state" }); } catch (e) { return null; } })()';
          const st = await waitFor('翻译完成', async () => {
            const x = await cdp.evalIn(optS, stateExpr);
            return x && (x.status === 'done' || x.status === 'error' || x.status === 'idle') ? x : null;
          }, 40000, 300);
          const doneAt = Date.now();
          await delay(1300);                                 // 等入场动画（380ms + 错峰最多 360ms）与随后的裁切兜底
          const probe = await cdp.evalIn(s, PROBE);
          const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, s);
          fs.writeFileSync(path.join(SHOTS, site.id + '.jpg'), Buffer.from(shot.data, 'base64'));
          let toastMs = null;                                // 完成提示停留：从状态变为 done 到提示消失
          for (let i = 0; i < 40; i++) {
            const shown = await cdp.evalIn(s, '!!document.querySelector("wpt-ui")');
            if (!shown) { toastMs = Date.now() - doneAt; break; }
            await delay(200);
          }
          return { status: st.status, total: st.total, translated: st.translated, failed: st.failed, newHScroll: !before.hScroll && probe.hScroll, toastMs, ...probe };
        })(), delay(SITE_TIMEOUT).then(() => { throw new Error('站点超时'); })]);
        const bad = r.clipped + r.occluded + r.overflow;
        out.push({ id: site.id, cat: site.cat, ...r, badRate: r.inView ? Math.round(1000 * bad / r.inView) / 10 : null });
        log(site.id.padEnd(14) + ' 首屏译文 ' + String(r.inView).padStart(3) + '  裁切 ' + r.clipped + '  遮挡 ' + r.occluded + '  溢出 ' + r.overflow +
          (r.newHScroll ? '  新增横向滚动!' : '') + '  提示停留 ' + (r.toastMs == null ? '>8s' : r.toastMs + 'ms') + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      } catch (e) {
        out.push({ id: site.id, cat: site.cat, error: String(e.message || e) });
        log(site.id.padEnd(14) + ' 失败：' + (e.message || e));
      } finally {
        if (targetId) { try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* 已关闭 */ } }
      }
    }
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) { /* 忽略 */ }
      killTree(browser.proc);
      try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
    killTree(mock);
  }

  const ok = out.filter((r) => !r.error && r.inView >= 3);
  const sum = (k) => ok.reduce((s, r) => s + (r[k] || 0), 0);
  const toasts = ok.map((r) => r.toastMs).filter((x) => x != null).sort((a, b) => a - b);
  const summary = {
    label: LABEL, sites: out.length, valid: ok.length,
    inView: sum('inView'), clipped: sum('clipped'), occluded: sum('occluded'), overflow: sum('overflow'),
    badRate: Math.round(1000 * (sum('clipped') + sum('occluded') + sum('overflow')) / Math.max(1, sum('inView'))) / 10,
    sitesWithIssues: ok.filter((r) => r.clipped + r.occluded + r.overflow > 0).map((r) => r.id + '(' + (r.clipped + r.occluded + r.overflow) + ')'),
    newHScroll: ok.filter((r) => r.newHScroll).map((r) => r.id),
    toastMedianMs: toasts.length ? toasts[toasts.length >> 1] : null
  };
  fs.writeFileSync(path.join(OUT_DIR, 'layout-' + LABEL + '.json'), JSON.stringify({ summary, sites: out }, null, 1));
  console.log('\n汇总：' + JSON.stringify(summary, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
