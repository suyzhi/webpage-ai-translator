#!/usr/bin/env node
/*
 * 术语一致性评测：同一页里反复出现的术语，译法是否前后一致（例如 shadow root 前面译「影子根」、后面译「阴影根」）。
 * 从 tools/eval-coverage.mjs 落盘的真实网页单元（.cache/eval/texts/*.json）里：
 *   1. 找出在 ≥ 3 个单元里出现的术语候选（1–3 词的 n-gram，去掉停用词），每站取前 --terms 个；
 *   2. 按页面顺序取含这些术语的单元（每站至多 --units 段），经真实后台 Engine 翻译（与插件相同的分批、并发）；
 *   3. 让模型逐处指出该术语在译文里被译成了什么，统计每个术语的不同译法数：
 *      一致率 = 与多数译法相同的出现次数 / 总出现次数（保留英文原样也算一种译法）。
 *
 * 用法：DEEPSEEK_API_KEY=… node tools/eval-terms.mjs [--only mdn,python-docs] [--terms 6] [--units 40] [--glossary]
 *   --dry：只列出每站选中的术语与单元数，不花钱
 *   --glossary：开启插件的「本页术语表」再测一次（用于对比）
 * 结果：.cache/eval/terms-latest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const SITES = (arg('only', '') || 'mdn,python-docs,react-dev,wikipedia,nextjs-docs,discord-docs').split(',');
const TERMS = Number(arg('terms', 6));
const UNITS = Number(arg('units', 40));
const MODEL = arg('model', 'deepseek-flash');
const JUDGE = arg('judge-model', 'deepseek-flash');
const GLOSSARY = argv.includes('--glossary');
const DRY = argv.includes('--dry');                 // 只列出选中的术语，不调用 API
const KEY = process.env.DEEPSEEK_API_KEY || '';
const TEXT_DIR = path.join(ROOT, '.cache', 'eval', 'texts');
const OUT = path.join(ROOT, '.cache', 'eval', 'terms-latest.json');

globalThis.importScripts = function () {};
for (const f of ['src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js', 'src/shared/prompt.js',
  'src/background/providers.js', 'src/background/engine.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const NS = globalThis.WPT;
const U = NS.util;
const nullCache = { key: (sys, t) => U.hashText(sys + '\u0000' + t), getMany: async () => new Map(), setMany: () => {}, scheduleFlush: () => {} };

const STOP = new Set(('a an the and or but of to in on at by for with from as is are was were be been being it its this that these those ' +
  'you your we our they their he she his her i me my not no can will would should could may might must do does did done has have had ' +
  'if then than so such also more most other some any each all one two use used using how what when where which who why new see ' +
  'about into over after before between through out up down only just like here there get set make way first last many much very retrieved archived original').split(' '));

/* 测量用的术语（固定口径，便于和基线对比）：在 ≥ 3 个单元里出现的 1–3 词短语，按「出现单元数 × 词数」排序 */
function pickTerms(texts, n) {
  const seen = new Map();
  texts.forEach((t, idx) => {
    const words = (t.toLowerCase().match(/[a-z][a-z0-9-]*(?:'[a-z]+)?/g) || []);
    const local = new Set();
    for (let k = 1; k <= 3; k++) {
      for (let i = 0; i + k <= words.length; i++) {
        const g = words.slice(i, i + k);
        if (STOP.has(g[0]) || STOP.has(g[k - 1])) continue;
        if (k === 1 && g[0].length < 5) continue;
        if (g.some((w) => U.isTrivialLabel(w))) continue;          // 月份、星期（参考文献里的 Retrieved March …）
        local.add(g.join(' '));
      }
    }
    for (const g of local) { if (!seen.has(g)) seen.set(g, new Set()); seen.get(g).add(idx); }
  });
  const cands = [...seen].filter(([, s]) => s.size >= 3).map(([g, s]) => ({ term: g, units: s, score: s.size * g.split(' ').length }));
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) {
    if (out.some((o) => (' ' + o.term + ' ').includes(' ' + c.term + ' '))) continue;
    if (out.some((o) => c.term.includes(o.term))) continue;
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

async function chat(model, system, user) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, temperature: 0, thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(120000)
  });
  const j = await res.json();
  if (!res.ok) throw new Error('judge HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 200));
  return { text: j.choices[0].message.content, usage: j.usage };
}

const JUDGE_SYS = [
  'You check how an English term was rendered in Chinese translations.',
  'Each item: term index, occurrence index, the English source (S) and its Chinese translation (T).',
  'For each item output exactly one line: termIndex|occurrenceIndex|rendering',
  'rendering = the exact words in T that translate the term (copy them verbatim; if T keeps the English term, copy the English).',
  'If the term is not translated at all in T (omitted), write -. No other text.'
].join('\n');

const norm = (r) => r.toLowerCase().replace(/[\s「」“”"'()（）]/g, '');

async function main() {
  if (!KEY && !DRY) { console.error('需要环境变量 DEEPSEEK_API_KEY'); process.exit(2); }
  const settings = NS.settings.normalize({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: MODEL,
    apiKey: KEY, targetLang: 'zh-CN', useCache: false, pageGlossary: GLOSSARY });
  const report = [];
  const usage = { input: 0, output: 0 }, judgeUsage = { input: 0, output: 0 };
  for (const site of SITES) {
    const f = path.join(TEXT_DIR, site + '.json');
    if (!fs.existsSync(f)) { console.log('[terms] 跳过 ' + site + '（没有落盘文本）'); continue; }
    const texts = [...new Set((JSON.parse(fs.readFileSync(f, 'utf8')).texts || []).map((t) => U.normalizeText(t)))]
      .filter((t) => U.isTranslatable(t, { minTextLength: 2 }, true));
    const terms = pickTerms(texts, TERMS);
    const idxs = [...new Set(terms.flatMap((t) => [...t.units]))].sort((a, b) => a - b).slice(0, UNITS);
    if (DRY) { console.log('[terms] ' + site + ' 单元 ' + idxs.length + '：' + terms.map((t) => t.term + '×' + t.units.size).join('，')); continue; }
    const items = idxs.map((i, k) => ({ id: k + 1, text: texts[i], dst: '' }));
    const byId = new Map(items.map((x) => [x.id, x]));
    // 术语表与插件一致：从整页文本里挑候选（内容脚本 pageTerms 的口径）
    const engine = new NS.Engine({ settings, cache: nullCache, limiter: new U.Limiter(settings.concurrency),
      terms: GLOSSARY ? U.pickTerms(texts, 8, 4) : null, log: (t) => { if (/术语表/.test(t)) console.log('[terms] ' + site + ' ' + t); },
      onResults: (pairs) => { for (const [id, t] of pairs) byId.get(id).dst = t; } });
    await engine.run(items.map((x) => ({ id: x.id, text: x.text })));
    usage.input += engine.stats.usage.input; usage.output += engine.stats.usage.output;

    const occ = [];
    terms.forEach((t, ti) => {
      const re = new RegExp('\\b' + t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + '\\b', 'i');
      for (const x of items) if (x.dst && re.test(x.text)) occ.push({ ti, oi: occ.filter((o) => o.ti === ti).length, x });
    });
    const user = occ.map((o) => o.ti + '|' + o.oi + ' term: ' + terms[o.ti].term + '\nS: ' + o.x.text.replace(/\n/g, ' ').slice(0, 400) +
      '\nT: ' + o.x.dst.replace(/\n/g, ' ').slice(0, 400)).join('\n\n');
    const r = await chat(JUDGE, JUDGE_SYS, user);
    judgeUsage.input += r.usage.prompt_tokens; judgeUsage.output += r.usage.completion_tokens;
    const rend = new Map();
    for (const line of r.text.split('\n')) {
      const m = /^\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line);
      if (m) rend.set(m[1] + '|' + m[2], m[3]);
    }
    const siteTerms = terms.map((t, ti) => {
      const list = occ.filter((o) => o.ti === ti).map((o) => rend.get(ti + '|' + o.oi)).filter((v) => v && v !== '-');
      const groups = new Map();
      for (const v of list) groups.set(norm(v), (groups.get(norm(v)) || []).concat(v));
      const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
      return { term: t.term, n: list.length, variants: sorted.map((g) => g[0] + '×' + g.length),
        consistency: list.length ? sorted[0].length / list.length : 1,
        samples: occ.filter((o) => o.ti === ti).map((o) => '#' + o.x.id + ' ' + (rend.get(ti + '|' + o.oi) || '?') + ' ← ' + o.x.text.slice(0, 90)) };
    }).filter((t) => t.n >= 2);
    report.push({ site, units: items.length, terms: siteTerms });
    for (const t of siteTerms) console.log('[terms] ' + site.padEnd(12) + ' ' + (t.consistency < 1 ? '✗ ' : '  ') + t.term.padEnd(22) + ' ' + t.variants.join('  '));
  }
  const all = report.flatMap((r) => r.terms);
  const occTotal = all.reduce((s, t) => s + t.n, 0);
  const occMajor = all.reduce((s, t) => s + Math.round(t.consistency * t.n), 0);
  const summary = {
    model: MODEL, glossary: GLOSSARY, sites: report.length, terms: all.length,
    inconsistentTerms: all.filter((t) => t.consistency < 1).length,
    occurrenceConsistency: Math.round(1000 * occMajor / Math.max(1, occTotal)) / 10,
    usage, judgeUsage
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, report }, null, 1));
  console.log('\n汇总：' + JSON.stringify(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
