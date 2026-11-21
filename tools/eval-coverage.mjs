#!/usr/bin/env node
/*
 * 真实网站抽取覆盖率评测（零依赖）：逐个打开 tools/eval/sites.json 里的网站，
 * 在每个 frame 的隔离世界里注入 extract.js + tools/eval/measure.js，
 * 对比「用户可见的应翻文本」与「抽取器产出的翻译单元」，给出召回率与漏抽原因。
 *
 * 用法：node tools/eval-coverage.mjs [--only a,b] [--concurrency 4] [--label 名称]
 * 结果：.cache/eval/coverage-<label|时间>.json 与 coverage-latest.json；终端打印汇总表。
 * 真实网站会变化：比较两次结果时以「同一批站点的中位数」为准，单站波动仅作参考。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, killTree } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ONLY = arg('only', '') ? new Set(arg('only').split(',')) : null;
const CONCURRENCY = Number(arg('concurrency', 4));
const LABEL = arg('label', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const SITE_TIMEOUT = 60000;
const GLOBAL_DEADLINE = Date.now() + 12 * 60000;
const OUT_DIR = path.join(ROOT, '.cache', 'eval');

const SOURCES = [
  'src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js',
  'src/content/extract.js', 'tools/eval/measure.js'
].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');

// 扩展当前是否注入子 frame：以 service worker 的 executeScript 参数为准，修复后评测自动跟随
const EXT_ALL_FRAMES = /allFrames:\s*true/.test(fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8'));

const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/eval/sites.json'), 'utf8'))
  .filter((s) => !ONLY || ONLY.has(s.id));
const log = (...a) => console.log('[coverage]', ...a);

async function evalCtx(cdp, session, contextId, expression) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  if (contextId) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params, session);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').slice(0, 300));
  return r.result ? r.result.value : undefined;
}

function flattenFrames(tree, out, depth) {
  out.push({ id: tree.frame.id, url: tree.frame.url, depth });
  for (const c of tree.childFrames || []) flattenFrames(c, out, depth + 1);
  return out;
}

const SCROLL = '(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<10;i++){scrollBy(0,innerHeight*0.9);await s(300);}scrollTo(0,0);await s(1500);return document.documentElement.scrollHeight;})()';

async function measureSite(cdp, ua, site) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  try {
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9' }, session);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false }, session);
    let loaded;
    const loadP = new Promise((r) => { loaded = r; });
    cdp.on('Page.loadEventFired', (p, sid) => { if (sid === session) loaded(); });
    const nav = await cdp.send('Page.navigate', { url: site.url }, session);
    if (nav.errorText) throw new Error('导航失败：' + nav.errorText);
    await Promise.race([loadP, delay(20000)]);
    await delay(2500);
    try { await Promise.race([evalCtx(cdp, session, null, SCROLL), delay(8000)]); } catch (e) { /* 页面跳转中，忽略 */ }

    const frames = flattenFrames((await cdp.send('Page.getFrameTree', {}, session)).frameTree, [], 0);
    const results = [];
    for (const f of frames.slice(0, 25)) {
      if (!/^https?:/.test(f.url)) continue;
      try {
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'wpt-eval' }, session);
        const small = await evalCtx(cdp, session, executionContextId, 'innerWidth * innerHeight < 120 * 60 || !document.body');
        if (small) continue;
        // 子框架与扩展的 frameWorthTranslating() 同一口径：太小或几乎没字的不翻
        const worth = f.depth === 0 || await evalCtx(cdp, session, executionContextId,
          'innerWidth >= 200 && innerHeight >= 60 && (document.body.innerText || "").trim().length >= 20');
        const frameCovered = f.depth === 0 || (EXT_ALL_FRAMES && worth);
        await evalCtx(cdp, session, executionContextId, SOURCES + '\n;0');
        const r = await evalCtx(cdp, session, executionContextId,
          'WPT_EVAL.measure({ frameCovered: ' + frameCovered + ', runExtractor: ' + frameCovered + ', dumpTexts: ' + (f.depth === 0) + ' })');
        r.depth = f.depth;
        if (r.texts) {
          fs.mkdirSync(path.join(OUT_DIR, 'texts'), { recursive: true });
          fs.writeFileSync(path.join(OUT_DIR, 'texts', site.id + '.json'), JSON.stringify({ url: site.url, texts: r.texts }));
          delete r.texts;
        }
        results.push(r);
      } catch (e) {
        results.push({ url: f.url, depth: f.depth, error: String(e.message || e) });
      }
    }
    return results;
  } finally {
    try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* 已关闭 */ }
  }
}

function summarize(site, frames) {
  const ok = frames.filter((f) => !f.error && f.oracle);
  const top = ok.find((f) => f.depth === 0);
  const sum = { all: 0, allC: 0, body: 0, bodyC: 0 };
  const reasons = {};
  for (const f of ok) {
    for (const k in sum) sum[k] += f.oracle[k];
    for (const k in f.reasons) {
      const r = reasons[k] || (reasons[k] = { w: 0, bodyW: 0, samples: [] });
      r.w += f.reasons[k].w; r.bodyW += f.reasons[k].bodyW;
      r.samples.push(...f.reasons[k].samples);
    }
  }
  for (const k in reasons) reasons[k].samples = reasons[k].samples.sort((a, b) => b.w - a.w).slice(0, 4);
  const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
  return {
    id: site.id, cat: site.cat, url: site.url,
    title: top && top.title,
    blocked: !top || sum.all < 300,          // 疑似被反爬 / 登录墙 / 空页面，不计入汇总
    bodyRecall: pct(sum.bodyC, sum.body),
    allRecall: pct(sum.allC, sum.all),
    oracle: sum,
    units: top ? top.units : 0,
    collectMs: top ? top.collectMs : null,
    frames: ok.length,
    iframeW: ok.filter((f) => f.depth > 0).reduce((s, f) => s + f.oracle.all, 0),
    shadowRoots: ok.reduce((s, f) => s + f.shadowRoots, 0),
    attrs: ok.reduce((s, f) => s + f.attrs, 0),
    quality: top ? top.quality : null,
    reasons,
    errors: frames.filter((f) => f.error).map((f) => f.url.slice(0, 80) + ': ' + f.error).slice(0, 3)
  };
}

function median(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) * 5) / 10;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchBrowser({
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-cov-')),
    extensionDebug: false,
    args: ['--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials',
      '--disable-blink-features=AutomationControlled', '--lang=en-US', '--mute-audio', '--window-size=1366,900']
  });
  const { cdp } = browser;
  const ua = (await cdp.send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
  log('浏览器：' + browser.browserPath + '；站点 ' + sites.length + ' 个；并发 ' + CONCURRENCY + '；扩展注入子 frame=' + EXT_ALL_FRAMES);

  const out = [];
  let next = 0;
  async function worker() {
    while (next < sites.length && Date.now() < GLOBAL_DEADLINE) {
      const site = sites[next++];
      const t0 = Date.now();
      try {
        const frames = await Promise.race([
          measureSite(cdp, ua, site),
          delay(SITE_TIMEOUT).then(() => { throw new Error('站点超时 ' + SITE_TIMEOUT + 'ms'); })
        ]);
        const s = summarize(site, frames);
        out.push(s);
        log(site.id.padEnd(14) + ' 正文召回 ' + String(s.bodyRecall).padStart(5) + '%  全文 ' + String(s.allRecall).padStart(5) + '%  ' +
          (s.blocked ? '[疑似被拦截] ' : '') + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      } catch (e) {
        out.push({ id: site.id, cat: site.cat, url: site.url, blocked: true, error: String(e.message || e) });
        log(site.id.padEnd(14) + ' 失败：' + (e.message || e));
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    try { cdp.proc.stdio[3].end(); } catch (e) { /* 忽略 */ }
    killTree(browser.proc);
    try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  out.sort((a, b) => sites.findIndex((s) => s.id === a.id) - sites.findIndex((s) => s.id === b.id));
  const valid = out.filter((s) => !s.blocked);
  const reasonTotals = {};
  let allW = 0;
  for (const s of valid) {
    allW += s.oracle.all;
    for (const k in s.reasons) reasonTotals[k] = (reasonTotals[k] || 0) + s.reasons[k].w;
  }
  const summary = {
    label: LABEL, at: new Date().toISOString(), extAllFrames: EXT_ALL_FRAMES,
    sites: out.length, valid: valid.length,
    medianBodyRecall: median(valid.map((s) => s.bodyRecall)),
    medianAllRecall: median(valid.map((s) => s.allRecall)),
    sitesBodyBelow90: valid.filter((s) => s.bodyRecall < 90).map((s) => s.id),
    lossByReason: Object.fromEntries(Object.entries(reasonTotals).sort((a, b) => b[1] - a[1])
      .map(([k, w]) => [k, Math.round(1000 * w / allW) / 10])),
    medianCollectMs: median(valid.map((s) => s.collectMs)),
    maxCollectMs: Math.max(0, ...valid.map((s) => s.collectMs || 0))
  };
  const file = path.join(OUT_DIR, 'coverage-' + LABEL + '.json');
  fs.writeFileSync(file, JSON.stringify({ summary, sites: out }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'coverage-latest.json'), JSON.stringify({ summary, sites: out }, null, 1));

  console.log('\n站点           分类           正文召回  全文召回  单元  抽取ms  主要漏抽原因');
  for (const s of out) {
    const top = s.reasons ? Object.entries(s.reasons).sort((a, b) => b[1].w - a[1].w).slice(0, 2)
      .map(([k, r]) => k + ' ' + Math.round(100 * r.w / Math.max(1, s.oracle.all)) + '%').join(', ') : (s.error || '');
    console.log(s.id.padEnd(15) + String(s.cat).padEnd(14) + (s.blocked ? '   —   ' : String(s.bodyRecall).padStart(7) + '%') +
      (s.blocked ? '    —   ' : String(s.allRecall).padStart(8) + '%') + String(s.units || 0).padStart(6) +
      String(s.collectMs == null ? '-' : s.collectMs).padStart(8) + '  ' + (s.blocked && !s.error ? '[疑似被拦截/空页] ' : '') + top);
  }
  console.log('\n汇总：' + JSON.stringify(summary, null, 1));
  console.log('结果：' + path.relative(ROOT, file));
}

main().catch((e) => { console.error(e); process.exit(1); });
