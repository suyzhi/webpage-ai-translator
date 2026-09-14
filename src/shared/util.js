/*
 * AI 网页翻译 — 通用工具（纯函数 + 少量无副作用类），可在 content / worker / 页面 / Node 中复用。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.util) return;
  const U = (NS.util = {});
  NS.util = U;

  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
  U.clamp = clamp;

  U.sleep = function (ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  function abortError(msg) {
    const e = new Error(msg || 'aborted');
    e.name = 'AbortError';
    e.aborted = true;
    return e;
  }
  U.abortError = abortError;
  U.isAbort = (e) => !!e && (e.name === 'AbortError' || e.aborted === true);

  /* 指数退避 + 抖动，避免惊群 */
  U.backoff = function (attempt, base, cap) {
    const b = base || 600;
    const c = cap || 20000;
    const raw = Math.min(c, b * Math.pow(2, attempt));
    return Math.round(raw * (0.6 + Math.random() * 0.8));
  };

  /* ---------------- 文本规范化 ---------------- */

  /* 折叠空白；
 保留（<br> 转换而来），便于诗歌/歌词保持换行 */
  U.normalizeText = function (text) {
    if (!text) return '';
    let s = String(text).replace(/\r\n?/g, '\n');
    s = s.replace(/[\u00a0\u2007\u202f\u3000]/g, ' ');
    s = s.replace(/[^\S\n]+/g, ' ');          // 折叠水平空白
    s = s.replace(/ ?\n ?/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  };

  /* 视觉长度：CJK 记 2，其余记 1（用于批量打包估算 token 量） */
  U.visualLength = function (text) {
    let n = 0;
    for (const ch of String(text || '')) {
      const c = ch.codePointAt(0);
      n += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xac00 && c <= 0xd7af) ? 2 : 1;
    }
    return n;
  };

  /* FNV-1a 双 32 位拼接：碰撞概率极低，用作缓存键 */
  U.hashText = function (text) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
  };

  /* ---------------- XML 转义（批量协议安全） ---------------- */

  U.escapeXml = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  U.unescapeXml = function (s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  };

  /* ---------------- 占位符保护 ----------------
   * URL / 邮箱 / 模板变量在翻译时极易被模型改写，先替换为 ⟦n⟧ 令牌，翻译后还原。
   */
  const TOKEN_OPEN = '\u27e6';
  const TOKEN_CLOSE = '\u27e7';
  const PROTECT_PATTERNS = [
    /https?:\/\/[^\s<>"'\u27e6\u27e7]+/g,
    /\bwww\.[^\s<>"'\u27e6\u27e7]+/g,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /\$\{[^}]{1,80}\}/g,
    /\{\{[^}]{1,80}\}\}/g,
    /\{[A-Za-z_][A-Za-z0-9_.]{0,40}\}/g,
    /%[sdf@]/g,
    /\b[A-Za-z]:\\[^\s"]+/g
  ];

  U.protectTokens = function (text) {
    const tokens = [];
    let out = String(text);
    const stash = (m) => {
      const i = tokens.length;
      tokens.push(m);
      return TOKEN_OPEN + i + TOKEN_CLOSE;
    };
    for (const re of PROTECT_PATTERNS) out = out.replace(re, stash);
    return { text: out, tokens };
  };

  const TOKEN_RE = new RegExp(TOKEN_OPEN + '\\s*(\\d+)\\s*' + TOKEN_CLOSE, 'g');
  /* 容错：模型偶尔会把 ⟦1⟧ 写成 [1] / 【1】 / （1） */
  const TOKEN_RE_LOOSE = /[\u27e6\u3010\[\uff08(]\s*(\d{1,3})\s*[\u27e7\u3011\]\uff09)]/g;

  U.restoreTokens = function (text, tokens) {
    if (!tokens || !tokens.length) return String(text);
    let out = String(text);
    const put = (full, idx) => {
      const i = Number(idx);
      return tokens[i] !== undefined ? tokens[i] : full;
    };
    out = out.replace(TOKEN_RE, put);
    if (out.search(TOKEN_RE_LOOSE) !== -1) out = out.replace(TOKEN_RE_LOOSE, put);
    return out;
  };

  /* 译文里漏掉的令牌补回末尾，保证不丢链接/变量 */
  U.ensureTokensPreserved = function (sourceProtected, translated, tokens) {
    if (!tokens || !tokens.length) return translated;
    const missing = [];
    TOKEN_RE.lastIndex = 0;
    let m;
    const present = new Set();
    const scan = (re, s) => { re.lastIndex = 0; let x; while ((x = re.exec(s))) present.add(Number(x[1])); };
    scan(TOKEN_RE, translated);
    scan(TOKEN_RE_LOOSE, translated);
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(sourceProtected))) {
      const i = Number(m[1]);
      if (!present.has(i)) missing.push(' ' + tokens[i]);
    }
    return missing.length ? translated + missing.join('') : translated;
  };

  /* ---------------- 语言 / 脚本判定 ---------------- */

  const SCRIPT_RANGES = [
    ['han', /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3007]/g],
    ['kana', /[\u3040-\u30ff\u31f0-\u31ff]/g],
    ['hangul', /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g],
    ['latin', /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/g],
    ['cyrillic', /[\u0400-\u04ff\u0500-\u052f]/g],
    ['greek', /[\u0370-\u03ff\u1f00-\u1fff]/g],
    ['arabic', /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff]/g],
    ['hebrew', /[\u0590-\u05ff]/g],
    ['devanagari', /[\u0900-\u097f]/g],
    ['bengali', /[\u0980-\u09ff]/g],
    ['gurmukhi', /[\u0a00-\u0a7f]/g],
    ['gujarati', /[\u0a80-\u0aff]/g],
    ['tamil', /[\u0b80-\u0bff]/g],
    ['telugu', /[\u0c00-\u0c7f]/g],
    ['kannada', /[\u0c80-\u0cff]/g],
    ['malayalam', /[\u0d00-\u0d7f]/g],
    ['sinhala', /[\u0d80-\u0dff]/g],
    ['thai', /[\u0e00-\u0e7f]/g],
    ['lao', /[\u0e80-\u0eff]/g],
    ['myanmar', /[\u1000-\u109f]/g],
    ['khmer', /[\u1780-\u17ff]/g],
    ['georgian', /[\u10a0-\u10ff]/g],
    ['ethiopic', /[\u1200-\u137f]/g],
    ['armenian', /[\u0530-\u058f]/g]
  ];

  U.scriptCounts = function (text) {
    const counts = Object.create(null);
    const s = String(text || '');
    for (const [name, re] of SCRIPT_RANGES) {
      re.lastIndex = 0;
      const m = s.match(re);
      if (m) counts[name] = m.length;
    }
    return counts;
  };

  /*
   * 判断文本是否"已经是目标语言"（仅对可脚本判定的语言生效）。
   * 对拉丁语系目标（en/fr/de...）无法廉价可靠判定，返回 false（交由模型处理）。
   */
  U.isProbablyTargetLang = function (text, langCode) {
    const lang = NS.LANG_MAP && NS.LANG_MAP[langCode];
    if (!lang) return false;
    const target = lang.script;
    if (!target || target === 'latin') return false;
    const counts = U.scriptCounts(text);
    let total = 0;
    for (const k in counts) total += counts[k];
    if (total < 2) return false;
    const c = counts[target] || 0;

    if (target === 'han') {
      // 含假名 => 日文，不当成中文
      if (counts.kana) return false;
      return c / total >= 0.5;
    }
    if (target === 'kana') {
      // 日语必须含有假名；纯汉字文本（中文）不能被当成日文
      if (!c) return false;
      return (c + (counts.han || 0)) / total >= 0.5;
    }
    if (target === 'hangul') {
      return c / total >= 0.5;
    }
    return c / total >= 0.6;
  };

  const NON_TRANSLATABLE_RE = /^(?:[\d\s\p{P}\p{S}]+|https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+)$/u;

  /* 该段文本是否值得送去翻译 */
  U.isTranslatable = function (text, settings) {
    const s = U.normalizeText(text);
    const minLen = settings && settings.minTextLength != null ? settings.minTextLength : 2;
    if (s.length < Math.max(1, minLen)) return false;
    if (!/\p{L}/u.test(s)) return false;
    if (NON_TRANSLATABLE_RE.test(s)) return false;
    // 纯数字/符号占比过高（如 "1,234.56 +12% ——"）直接跳过
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 2 && s.length > 8) return false;
    if (settings && settings.skipTargetLang && U.isProbablyTargetLang(s, settings.targetLang)) return false;
    return true;
  };

  /* ---------------- 批处理规划 ----------------
   * 贪心装箱：按优先级（视口优先）顺序打包，首批更小以获得更快的首屏。
   */
  U.planBatches = function (items, opts) {
    const o = opts || {};
    const maxChars = o.maxChars || 1200;
    const maxItems = o.maxItems || 16;
    const firstChars = Math.min(maxChars, o.firstBatchChars || maxChars);
    const batches = [];
    let cur = [];
    let chars = 0;
    const limitNow = () => (batches.length === 0 ? firstChars : maxChars);
    for (const it of items) {
      const len = (it.cost != null ? it.cost : String(it.text || '').length) + 22;
      if (cur.length && (chars + len > limitNow() || cur.length >= maxItems)) {
        batches.push(cur); cur = []; chars = 0;
      }
      cur.push(it);
      chars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  };

  /* ---------------- 并发池 ---------------- */
  U.runPool = async function (items, limit, worker, opts) {
    const o = opts || {};
    const arr = items || [];
    if (!arr.length) return;
    const width = Math.max(1, Math.min(Math.round(limit) || 1, arr.length));
    let next = 0;
    let stop = false;
    let failure = null;

    async function runner() {
      while (!stop) {
        if (o.signal && o.signal.aborted) { stop = true; return; }
        const i = next++;
        if (i >= arr.length) return;
        try {
          await worker(arr[i], i);
        } catch (err) {
          if (o.onError) o.onError(err, arr[i], i);
          else { failure = err; stop = true; return; }
        }
      }
    }

    const runners = [];
    for (let i = 0; i < width; i++) runners.push(runner());
    await Promise.all(runners);
    if (failure) throw failure;
  };

  /* ---------------- LRU ---------------- */
  U.LRUCache = class LRUCache {
    constructor(max) {
      this.max = Math.max(1, max || 100);
      this.map = new Map();
    }
    get size() { return this.map.size; }
    has(k) { return this.map.has(k); }
    get(k) {
      if (!this.map.has(k)) return undefined;
      const v = this.map.get(k);
      this.map.delete(k);
      this.map.set(k, v);
      return v;
    }
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    delete(k) { return this.map.delete(k); }
    clear() { this.map.clear(); }
    keys() { return Array.from(this.map.keys()); }
  };

  /* URL 拼接：baseUrl 已含具体路径时直接使用，兼容各类自建网关 */
  U.joinUrl = function (base, suffix) {
    const b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return suffix;
    if (/\/(chat\/completions|messages|completions)$/i.test(b)) return b;
    return b + suffix;
  };

  U.truncate = function (s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  /* 人类可读错误信息 */
  U.describeError = function (err) {
    if (!err) return '未知错误';
    if (U.isAbort(err)) return '已取消';
    const status = err.status;
    if (status === 401 || status === 403) return 'API 密钥无效或无权限 (HTTP ' + status + ')';
    if (status === 404) return '接口地址或模型不存在 (HTTP 404)，请检查 Base URL 与模型名';
    if (status === 429) return '触发速率限制 (HTTP 429)，请降低并发数或稍后重试';
    if (status >= 500) return 'AI 服务端错误 (HTTP ' + status + ')';
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return '请求超时，请检查网络或调大超时时间';
    if (err.name === 'TypeError') return '网络请求失败：无法连接 ' + (err.url || 'API 地址') + '（检查地址/代理/网络）';
    return U.truncate(err.message || String(err), 300);
  };
})();
