#!/usr/bin/env node
/*
 * token / 速度评测：把 tools/eval-coverage.mjs 落盘的真实网页单元（.cache/eval/texts/*.json）
 * 送进真实的后台 Engine（去重、占位符保护、批量打包、视口优先首批全部照常运行）。
 *
 * 默认离线模式：provider 打桩，只统计请求构成，不花钱；token 按字符近似估算（中日韩 0.6 / 西文 1/3.6 字符），
 *   「放大系数」是同一估算口径下的比值，估算偏差基本相互抵消。
 * 真实模式：--real，并设置环境变量 DEEPSEEK_API_KEY；用服务端返回的 usage 和实测耗时。
 *
 * 用法：node tools/eval-cost.mjs [--only a,b] [--real] [--model deepseek-flash] [--set batchItems=48,batchChars=3000]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const ONLY = arg('only', '') ? new Set(arg('only').split(',')) : null;
const REAL = argv.includes('--real');
const MODEL = arg('model', 'deepseek-flash');
const OVERRIDES = Object.fromEntries((arg('set', '') || '').split(',').filter(Boolean)
  .map((kv) => { const [k, v] = kv.split('='); return [k, isNaN(Number(v)) ? v : Number(v)]; }));
const TEXT_DIR = path.join(ROOT, '.cache', 'eval', 'texts');
const MAX_REAL_SEGMENTS = 400;          // 真实模式每站最多翻这么多段，控制花费

globalThis.importScripts = function () {};
for (const f of ['src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js', 'src/shared/prompt.js',
  'src/background/providers.js', 'src/background/engine.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const NS = globalThis.WPT;
const U = NS.util;

function estTokens(s) {
  let t = 0, ascii = 0;
  for (const ch of String(s)) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) t += 0.6;
    else if (ch.charCodeAt(0) < 128) ascii++;
    else t += 0.5;
  }
  return t + ascii / 3.6;
}

const nullCache = {
  key: (sys, t) => U.hashText(sys + '\u0000' + t),
  getMany: async () => new Map(),
  setMany: () => {},
  scheduleFlush: () => {}
};

async function runSite(id, texts) {
  const settings = NS.settings.normalize(Object.assign({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: MODEL,
    apiKey: process.env.DEEPSEEK_API_KEY || '', targetLang: 'zh-CN', useCache: false
  }, OVERRIDES));
  const list = (REAL ? texts.slice(0, MAX_REAL_SEGMENTS) : texts).map((t, i) => ({ id: i + 1, text: t }));
  const rec = { requests: 0, sysTok: 0, userTok: 0, items: [], firstAt: null };
  const realCall = NS.providers.call;
  if (!REAL) {
    NS.providers.call = async (s, msg, signal, meta) => {
      rec.requests++;
      rec.sysTok += estTokens(msg.system);
      rec.userTok += estTokens(msg.user);
      const segs = msg.user.split('\n');
      rec.items.push(segs.length);
      const out = msg.user;
      meta.usage = { input: Math.round(estTokens(msg.system) + estTokens(msg.user)), output: Math.round(estTokens(out)), cached: 0 };
      return out;
    };
  } else {
    NS.providers.call = async (s, msg, signal, meta) => {
      rec.requests++;
      rec.items.push(msg.user.split('\n').length);
      return realCall(s, msg, signal, meta);
    };
  }
  const t0 = Date.now();
  const engine = new NS.Engine({
    settings, cache: nullCache, limiter: new U.Limiter(settings.concurrency),
    onResults: () => { if (rec.firstAt == null) rec.firstAt = Date.now() - t0; }
  });
  await engine.run(list);
  NS.providers.call = realCall;
  const wallMs = Date.now() - t0;
  const unique = new Set(list.map((x) => U.normalizeText(x.text))).size;
  const rawTok = list.reduce((s, x) => s + estTokens(x.text), 0);
  const uniqTok = [...new Set(list.map((x) => U.normalizeText(x.text)))].reduce((s, t) => s + estTokens(t), 0);
  const u = engine.stats.usage;
  const inputTok = REAL ? u.input : rec.sysTok + rec.userTok;
  const r1 = (x) => Math.round(x * 100) / 100;
  return {
    id, segments: list.length, unique, requests: rec.requests,
    avgItems: r1(rec.items.reduce((a, b) => a + b, 0) / Math.max(1, rec.items.length)),
    rawTok: Math.round(rawTok), uniqTok: Math.round(uniqTok), inputTok: Math.round(inputTok), outputTok: Math.round(u.output),
    cachedTok: Math.round(u.cached),
    amplification: r1(inputTok / Math.max(1, uniqTok)),      // 输入 token ÷ 去重后原文 token
    sysShare: REAL ? null : r1(rec.sysTok / Math.max(1, inputTok)),
    failed: engine.stats.failed,
    firstMs: rec.firstAt, wallMs
  };
}

async function main() {
  if (REAL && !process.env.DEEPSEEK_API_KEY) { console.error('真实模式需要环境变量 DEEPSEEK_API_KEY'); process.exit(2); }
  if (!fs.existsSync(TEXT_DIR)) { console.error('缺少 ' + TEXT_DIR + '：先运行 node tools/eval-coverage.mjs'); process.exit(2); }
  const files = fs.readdirSync(TEXT_DIR).filter((f) => f.endsWith('.json')).sort()
    .filter((f) => !ONLY || ONLY.has(f.replace(/\.json$/, '')));
  const rows = [];
  for (const f of files) {
    const { texts } = JSON.parse(fs.readFileSync(path.join(TEXT_DIR, f), 'utf8'));
    if (!texts || texts.length < 5) continue;
    rows.push(await runSite(f.replace(/\.json$/, ''), texts));
  }
  console.log('站点            段数  去重   请求  段/请求  原文tok  输入tok  放大  系统提示占比' + (REAL ? '  缓存tok  首条ms  总ms  失败' : ''));
  for (const r of rows) {
    console.log(r.id.padEnd(15) + String(r.segments).padStart(5) + String(r.unique).padStart(6) + String(r.requests).padStart(6) +
      String(r.avgItems).padStart(8) + String(r.rawTok).padStart(9) + String(r.inputTok).padStart(9) + String(r.amplification).padStart(6) +
      (REAL ? '' : String(r.sysShare).padStart(10)) +
      (REAL ? String(r.cachedTok).padStart(9) + String(r.firstMs).padStart(8) + String(r.wallMs).padStart(7) + String(r.failed).padStart(5) : ''));
  }
  const med = (k) => { const a = rows.map((r) => r[k]).filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
  const tot = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const summary = {
    mode: REAL ? 'real' : 'offline', model: MODEL, overrides: OVERRIDES, sites: rows.length,
    medianAmplification: med('amplification'),
    pooledAmplification: Math.round(100 * tot('inputTok') / Math.max(1, tot('uniqTok'))) / 100,
    medianSysShare: med('sysShare'), medianAvgItems: med('avgItems'), totalRequests: tot('requests')
  };
  console.log('\n汇总：' + JSON.stringify(summary));
  const outDir = path.join(ROOT, '.cache', 'eval');
  fs.writeFileSync(path.join(outDir, 'cost-' + (REAL ? 'real' : 'offline') + '-latest.json'), JSON.stringify({ summary, rows }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
