#!/usr/bin/env node
/*
 * 翻译质量评测：从 tools/eval-coverage.mjs 落盘的真实网页单元（.cache/eval/texts/*.json）里按固定步长抽样，
 * 经真实后台 Engine（占位符保护、批量、流式）翻译，然后：
 *   1. 自动检查（全部样本）：
 *      - 未翻译：可翻译的外文句子原样返回
 *      - 数字丢失：原文里的数字（含小数、版本号）在译文里找不到
 *      - 链接 / 邮箱丢失
 *      - 协议残留：译文里出现 "N|" 行首、<br>、<t id=、⟦n⟧ 等
 *      - 错位嫌疑：长度比异常（译文对应的可能是别的段）
 *      - 非目标语言：译文里中文占比过低
 *   2. 强模型打分（抽 --judge 段，默认 100）：deepseek-v4-pro 对「忠实 + 通顺」给 1–5 分，并标出错位 / 漏译。
 *
 * 用法：DEEPSEEK_API_KEY=… node tools/eval-quality.mjs [--per 20] [--judge 100] [--only a,b] [--model deepseek-flash]
 * 结果：.cache/eval/quality-latest.json（含每段原文、译文与问题，便于人工复核）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const PER_SITE = Number(arg('per', 20));
const JUDGE_N = Number(arg('judge', 100));
const MODEL = arg('model', 'deepseek-flash');
const JUDGE_MODEL = arg('judge-model', 'deepseek-v4-pro');
const SITES = (arg('only', '') || 'wikipedia,mdn,guardian,reddit,github-readme,hn,stackoverflow,spiegel,arxiv,amazon,steam,python-docs').split(',');
const KEY = process.env.DEEPSEEK_API_KEY || '';
const TEXT_DIR = path.join(ROOT, '.cache', 'eval', 'texts');
const OUT = path.join(ROOT, '.cache', 'eval', 'quality-latest.json');

globalThis.importScripts = function () {};
for (const f of ['src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js', 'src/shared/prompt.js',
  'src/background/providers.js', 'src/background/engine.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const NS = globalThis.WPT;
const U = NS.util;

const nullCache = {
  key: (sys, t) => U.hashText(sys + '\u0000' + t),
  getMany: async () => new Map(),
  setMany: () => {},
  scheduleFlush: () => {}
};

/* 固定步长抽样：可复现，且覆盖页面前后各处（导航、正文、页脚） */
function sample(texts, n) {
  const pool = [...new Set(texts.map((t) => U.normalizeText(t)))].filter((t) => U.isTranslatable(t, { minTextLength: 2 }, true));
  if (pool.length <= n) return pool;
  const step = pool.length / n;
  return Array.from({ length: n }, (_, i) => pool[Math.floor(i * step)]);
}

const letters = (s) => (s.match(/\p{L}/gu) || []).length;
const han = (s) => (s.match(/\p{Script=Han}/gu) || []).length;
const latinWords = (s) => (s.match(/[A-Za-zÀ-ɏ]{2,}/g) || []).length;
const NUM_RE = /\d+(?:[.,:]\d+)*/g;
const LINK_RE = /https?:\/\/[^\s<>"')\]]+|[\w.+-]+@[\w-]+\.[\w.]+/g;

function autoCheck(src, dst) {
  const issues = [];
  if (!dst) return ['empty'];
  // 句子级外文（≥ 4 个词）原样返回 = 未翻译；短标签、人名、品牌原样返回是允许的
  if (U.sameText(src, dst) && latinWords(src) >= 4) issues.push('untranslated');
  const digits = (s) => (s.match(NUM_RE) || []).map((x) => x.replace(/,/g, ''));
  const dn = new Set(digits(dst).flatMap((x) => [x, x.replace(/\./g, '')]));
  const lost = digits(src).filter((x) => !dn.has(x) && !dn.has(x.replace(/\./g, '')) && !dst.includes(x));
  if (lost.length) issues.push('number-lost:' + lost.slice(0, 3).join(','));
  const links = src.match(LINK_RE) || [];
  if (links.some((l) => !dst.includes(l))) issues.push('link-lost');
  if (/^\s*\d+\s*\|/m.test(dst) || /<br\s*\/?>|<t id=|[⟦⟧]/.test(dst)) issues.push('protocol-residue');
  const sl = letters(src), dl = han(dst) * 1.8 + latinWords(dst) * 4;
  if (sl >= 40 && (dl / sl < 0.25 || dl / sl > 3)) issues.push('length-anomaly');
  if (latinWords(src) >= 6 && han(dst) < letters(dst) * 0.3) issues.push('not-target-lang');
  return issues;
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
  'You review machine translations of web-page text into Simplified Chinese.',
  'For each item you get the source (S) and the translation (T). Score 1-5:',
  '5 = accurate and natural; 4 = accurate, slightly stiff; 3 = understandable but with a meaning error or awkward;',
  '2 = significant meaning error or omission; 1 = wrong / unrelated / untranslated.',
  'Names, brands, code, UI labels and numbers may legitimately stay unchanged.',
  'Flag MISALIGNED if T translates a different text than S, OMISSION if part of S is missing, ADDITION if T adds content.',
  'Output exactly one line per item: id|score|flags|short note in Chinese (≤ 20 chars). No other text.'
].join('\n');

async function main() {
  if (!KEY) { console.error('需要环境变量 DEEPSEEK_API_KEY'); process.exit(2); }
  const items = [];
  for (const id of SITES) {
    const f = path.join(TEXT_DIR, id + '.json');
    if (!fs.existsSync(f)) continue;
    for (const t of sample(JSON.parse(fs.readFileSync(f, 'utf8')).texts || [], PER_SITE)) items.push({ site: id, src: t });
  }
  items.forEach((x, i) => { x.id = i + 1; });
  console.log('[quality] 样本 ' + items.length + ' 段，' + SITES.length + ' 站；翻译模型 ' + MODEL);

  const settings = NS.settings.normalize({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: MODEL,
    apiKey: KEY, targetLang: 'zh-CN', useCache: false });
  const byId = new Map(items.map((x) => [x.id, x]));
  const engine = new NS.Engine({ settings, cache: nullCache, limiter: new U.Limiter(settings.concurrency),
    onResults: (pairs) => { for (const [id, t] of pairs) byId.get(id).dst = t; } });
  const t0 = Date.now();
  await engine.run(items.map((x) => ({ id: x.id, text: x.src })));
  const usage = engine.stats.usage;
  console.log('[quality] 翻译完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，失败 ' + engine.stats.failed + '，token 入 ' + usage.input + ' / 出 ' + usage.output);

  for (const x of items) x.issues = autoCheck(x.src, x.dst || '');
  const flagged = items.filter((x) => x.issues.length);
  const byIssue = {};
  for (const x of flagged) for (const k of x.issues) { const key = k.split(':')[0]; byIssue[key] = (byIssue[key] || 0) + 1; }

  // 强模型打分：只评有实质内容的段（≥ 3 个词），步长抽样
  const judgeable = items.filter((x) => x.dst && latinWords(x.src) >= 3);
  const step = Math.max(1, judgeable.length / JUDGE_N);
  const jset = Array.from({ length: Math.min(JUDGE_N, judgeable.length) }, (_, i) => judgeable[Math.floor(i * step)]);
  const judgeUsage = { input: 0, output: 0 };
  for (let i = 0; i < jset.length; i += 25) {
    const chunk = jset.slice(i, i + 25);
    const user = chunk.map((x) => x.id + '\nS: ' + x.src.replace(/\n/g, ' ') + '\nT: ' + x.dst.replace(/\n/g, ' ')).join('\n\n');
    const r = await chat(JUDGE_MODEL, JUDGE_SYS, user);
    judgeUsage.input += r.usage.prompt_tokens; judgeUsage.output += r.usage.completion_tokens;
    for (const line of r.text.split('\n')) {
      const m = /^\s*(\d+)\s*\|\s*([1-5])\s*\|([^|]*)\|?(.*)$/.exec(line);
      if (!m || !byId.has(Number(m[1]))) continue;
      const x = byId.get(Number(m[1]));
      x.score = Number(m[2]); x.flags = m[3].trim(); x.note = m[4].trim();
    }
  }
  const scored = jset.filter((x) => x.score);
  const mean = scored.reduce((s, x) => s + x.score, 0) / Math.max(1, scored.length);
  const dist = [1, 2, 3, 4, 5].map((k) => scored.filter((x) => x.score === k).length);
  const misaligned = scored.filter((x) => /MISALIGNED/i.test(x.flags || ''));
  const summary = {
    model: MODEL, judge: JUDGE_MODEL, samples: items.length, failed: engine.stats.failed,
    autoIssueRate: Math.round(1000 * flagged.length / Math.max(1, items.length)) / 10, byIssue,
    judged: scored.length, meanScore: Math.round(mean * 100) / 100, scoreDist: dist, misaligned: misaligned.length,
    usage, judgeUsage
  };
  fs.writeFileSync(OUT, JSON.stringify({ summary, items }, null, 1));
  console.log('\n汇总：' + JSON.stringify(summary));
  const low = scored.filter((x) => x.score <= 3).slice(0, 12);
  if (low.length) console.log('\n低分样本：');
  for (const x of low) console.log('  [' + x.score + ' ' + (x.flags || '') + '] ' + x.site + ' | ' + x.src.slice(0, 70) + ' → ' + (x.dst || '').slice(0, 50) + ' | ' + (x.note || ''));
  if (flagged.length) console.log('\n自动检查命中（前 12）：');
  for (const x of flagged.slice(0, 12)) console.log('  ' + x.issues.join(',') + ' | ' + x.site + ' | ' + x.src.slice(0, 70) + ' → ' + (x.dst || '').slice(0, 50));
}

main().catch((e) => { console.error(e); process.exit(1); });
