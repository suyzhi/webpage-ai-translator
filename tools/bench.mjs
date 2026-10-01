#!/usr/bin/env node
/*
 * 微基准：验证缓存持久化索引为 O(1)（容量翻倍时耗时近似线性）。
 * 用法：node tools/bench.mjs [N]        # 默认 20000
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 20000);

const store = new Map();
function keysOf(keys) {
  if (keys == null) return Array.from(store.keys());
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}
globalThis.chrome = { storage: { local: {
  get: async (keys) => { const out = {}; for (const k of keysOf(keys)) if (store.has(k)) out[k] = store.get(k); return out; },
  set: async (obj) => { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
  remove: async (keys) => { for (const k of keysOf(keys)) store.delete(k); }
} } };

for (const f of ['src/shared/constants.js', 'src/shared/util.js', 'src/background/cache.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const U = globalThis.WPT.util;
const Cache = globalThis.WPT.TranslationCache;

const round = (n) => Math.round(n * 10) / 10;
function time(fn) { const t = performance.now(); fn(); return round(performance.now() - t); }

const cache = new Cache();
await cache.load(N + 5000);
const setMs = time(() => { for (let i = 0; i < N; i++) cache.setMany([['wpt.c.k' + i, 'value-' + i]]); });
await cache.flush();
cache.mem.clear();
const keys = [];
for (let i = 0; i < N; i++) keys.push('wpt.c.k' + i);
const t0 = performance.now();
const got = await cache.getMany(keys);
const getMs = round(performance.now() - t0);

const ascii = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
const cjk = '快速翻译网页并保留原有排版。'.repeat(20);
const loops = 100000;
const visAscii = time(() => { for (let i = 0; i < loops; i++) U.visualLength(ascii); });
const visCjk = time(() => { for (let i = 0; i < loops; i++) U.visualLength(cjk); });
const langEn = time(() => { for (let i = 0; i < loops; i++) U.isProbablyTargetLang('A normal English sentence for detection.', 'zh-CN'); });
const langCjk = time(() => { for (let i = 0; i < loops; i++) U.isProbablyTargetLang('这是一段已经是中文的文本内容', 'zh-CN'); });

console.log('缓存条目 N=' + N + '，命中 ' + got.size + ' 条');
console.log('  cache.setMany x' + N + '   ' + setMs + ' ms');
console.log('  cache.getMany x' + N + '   ' + getMs + ' ms');
console.log('热点函数（' + loops + ' 次）');
console.log('  visualLength(ascii)     ' + visAscii + ' ms');
console.log('  visualLength(cjk)       ' + visCjk + ' ms');
console.log('  isProbablyTargetLang(en->zh)  ' + langEn + ' ms');
console.log('  isProbablyTargetLang(zh->zh)  ' + langCjk + ' ms');
