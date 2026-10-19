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
    const s = String(text || '');
    if (!/[^\x00-\x7f]/.test(s)) return s.length;   // 纯 ASCII 快速路径
    let n = 0;
    for (const ch of s) {
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

  /* 预编译的非全局正则：统计前先快速排除「完全不含目标脚本」的文本 */
  const SCRIPT_TEST = Object.create(null);
  for (const [name, re] of SCRIPT_RANGES) SCRIPT_TEST[name] = new RegExp(re.source);

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
    const s = String(text || '');
    // 快速排除：源语言页面通常完全不含目标脚本，省去 20+ 次全量正则扫描
    const quick = SCRIPT_TEST[target];
    if (quick && !quick.test(s)) return false;
    const counts = U.scriptCounts(s);
    let total = 0;
    for (const k in counts) total += counts[k];
    // 中日韩目标：夹在句中的英文按「词」计（一个英文词≈一个汉字词），
    // 否则「OpenAI 发布 GPT 模型」这类中文句子会因为字母多而被误判成外文
    if ((target === 'han' || target === 'kana' || target === 'hangul') && counts.latin) {
      const words = (s.match(/[A-Za-z\u00c0-\u024f\u1e00-\u1eff]+/g) || []).length;
      total = total - counts.latin + words * 1.5;
    }
    if (total < 1) return false;
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
  /* 社交媒体里的标识而非语句：@用户名 / #话题 / $股票代码，可多个并列 */
  /* 「显示名 @用户名」组合（X / Mastodon / Bluesky 的作者行） */
  const NAME_HANDLE_RE = /^(?:\S+\s){1,6}@[\p{L}\p{N}_.]+(?:@[\p{L}\p{N}_.-]+)?$/u;
  const TAG_ONLY_RE = /^(?:[@#\uff03$][\p{L}\p{N}_.]+(?:@[\p{L}\p{N}_.-]+)?(?:[\s\u00b7\u2022,\uff0c\u3001|/]+|$))+$/u;

  /*
   * 翻了反而添乱的极短标签：日历刻度（Jan / Mon / Oct 18, 2026 / Mon 10:30 AM）与人人认得的界面词（More / Less / Sign in）。
   * 贡献图、日期列、图例里成排出现，「Jan 1月」「More 较多」只会把版面挤乱、白花 token。整段恰好是这些词才算。
   */
  const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const WEEKDAY = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
  const CAL_TOKEN = '(?:' + MONTH + '|' + WEEKDAY + '|\\d{1,4}(?:st|nd|rd|th)?|\\d{1,2}:\\d{2}(?::\\d{2})?|[ap]\\.?m\\.?)\\.?';
  const CALENDAR_RE = new RegExp('^(?=.*\\b(?:' + MONTH + '|' + WEEKDAY + ')\\b)' + CAL_TOKEN + '(?:[\\s,/\\-\u2013]+' + CAL_TOKEN + ')*$', 'i');
  const UI_WORD_RE = new RegExp('^(?:more|less|next|prev(?:ious)?|back|home|menu|search|share|reply|edit|delete|save|cancel|ok|yes|no|close|copy|' +
    'like|follow|log ?in|log ?out|sign ?in|sign ?up|sign ?out|subscribe|top|new|hot|best|all|' +
    '(?:show|see|read|load|view) (?:more|less|all))[\\s.:\u2026\u203a\u00bb>\u2192\u25be\u25b8]*$', 'i');
  U.isTrivialLabel = function (s) {
    return s.length <= 40 && (CALENDAR_RE.test(s) || UI_WORD_RE.test(s));
  };

  /*
   * 本页术语候选：在 ≥ minUnits（默认 3）段里出现的 1–3 词短语（去掉首尾停用词、月份星期），按「出现段数 × 词数」排序，
   * 被已选更长短语包含的、或包含已选短语的去掉。返回 [{ term: 首次出现时的原样大小写, sample: 所在句子片段 }]。
   * 送给模型先定译法（见 engine 的本页术语表），也供术语一致性评测选题。
   */
  const TERM_STOP = new Set(('a an the and or but of to in on at by for with from as is are was were be been being it its this that these those ' +
    'you your we our they their he she his her i me my not no can will would should could may might must do does did done has have had ' +
    'if then than so such also more most other some any each all one two use used using how what when where which who why new see ' +
    'about into over after before between through out up down only just like here there get set make way first last many much very ' +
    'retrieved archived original').split(' '));
  U.pickTerms = function (texts, n, minUnits) {
    const need = minUnits || 3;
    const seen = new Map();
    for (let idx = 0; idx < texts.length; idx++) {
      const t = String(texts[idx] || '');
      const words = t.match(/[A-Za-z][A-Za-z0-9-]*(?:'[a-z]+)?/g) || [];
      const lower = words.map((w) => w.toLowerCase());
      const local = new Set();
      for (let k = 1; k <= 3; k++) {
        for (let i = 0; i + k <= words.length; i++) {
          const g = lower.slice(i, i + k);
          if (TERM_STOP.has(g[0]) || TERM_STOP.has(g[k - 1])) continue;
          if (k === 1 && g[0].length < 5) continue;
          if (g.some((w) => U.isTrivialLabel(w))) continue;
          const key = g.join(' ');
          if (local.has(key)) continue;
          local.add(key);
          let c = seen.get(key);
          if (!c) {
            const orig = words.slice(i, i + k).join(' ');
            const at = t.indexOf(orig);
            c = { term: orig, sample: t.slice(Math.max(0, at - 30), at + orig.length + 40).replace(/\s+/g, ' ').trim(), units: 0 };
            seen.set(key, c);
          }
          c.units++;
        }
      }
    }
    const cands = [];
    seen.forEach((c, key) => { if (c.units >= need) cands.push({ key: key, c: c, score: c.units * key.split(' ').length }); });
    cands.sort((a, b) => b.score - a.score);
    const out = [];
    for (let i = 0; i < cands.length && out.length < n; i++) {
      const k = cands[i].key;
      const sing = k.replace(/s$/, '');
      if (out.some((o) => (' ' + o.key + ' ').indexOf(' ' + k + ' ') >= 0 || (' ' + k + ' ').indexOf(' ' + o.key + ' ') >= 0 ||
        o.key.replace(/s$/, '') === sing)) continue;                       // component / components 只留一个
      out.push(cands[i]);
    }
    return out.map((o) => ({ term: o.c.term, sample: o.c.sample, units: o.c.units }));
  };

  /* 该段文本是否值得送去翻译 */
  U.isTranslatable = function (text, settings, preNormalized) {
    const s = preNormalized ? String(text == null ? '' : text) : U.normalizeText(text);
    const minLen = settings && settings.minTextLength != null ? settings.minTextLength : 2;
    if (s.length < Math.max(1, minLen)) return false;
    if (!/\p{L}/u.test(s)) return false;
    if (NON_TRANSLATABLE_RE.test(s)) return false;
    // 纯数字/符号占比过高（如 "1,234.56 +12% ——"）直接跳过
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 2 && s.length > 8) return false;
    if (TAG_ONLY_RE.test(s) || NAME_HANDLE_RE.test(s)) return false;
    // 数字 + 极少字母：计数、时间、比分之类（3h / 1.2K / 27万 / v2 / 2-1 W）
    if (letters <= 2 && /\d/.test(s)) return false;
    if (U.isTrivialLabel(s)) return false;
    if (settings && settings.skipTargetLang && U.isProbablyTargetLang(s, settings.targetLang)) return false;
    return true;
  };

  /* 译文与原文实质相同（模型原样返回的人名、品牌、代码等）：忽略大小写、空白与标点比较 */
  U.sameText = function (a, b) {
    const key = (x) => String(x == null ? '' : x).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const ka = key(a);
    return !!ka && ka === key(b);
  };

  /* 语言代码归一到主语言（兼容 CLD 的旧代码） */
  const LANG_ALIAS = { iw: 'he', in: 'id', tl: 'fil', nb: 'no', nn: 'no', jw: 'jv' };
  U.baseLang = function (code) {
    const c = String(code || '').toLowerCase().split(/[-_]/)[0];
    return LANG_ALIAS[c] || c;
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

  /* ---------------- 共享限流器 ----------------
   * 同一 API 端点 + 密钥的所有任务（多个标签页、同页多次增量）共用一个限流器：
   *   - 并发上限 = 用户设置的并发数，而不是「每个标签页各自一份」；
   *   - AIMD 自适应：遇到 429 并发减半并进入全局冷却（尊重 Retry-After），
   *     之后每连续成功 limit 次再 +1，逐步恢复到上限，避免 429 风暴；
   *   - FIFO 排队，保证先提交（视口优先）的批次先发出。
   */
  U.Limiter = class Limiter {
    constructor(max) {
      this.max = Math.max(1, Math.round(max) || 1);
      this.limit = this.max;
      this.active = 0;
      this.queue = [];
      this.cooldownUntil = 0;
      this.okStreak = 0;
    }
    setMax(n) {
      const m = Math.max(1, Math.round(n) || 1);
      if (m === this.max) return;
      // 调低立即生效；调高时若当前处于降速状态则保留降速，由成功次数逐步恢复
      this.limit = this.limit >= this.max ? m : Math.min(this.limit, m);
      this.max = m;
      this._drain();
    }
    async acquire(signal) {
      if (signal && signal.aborted) throw abortError();
      if (this.active < this.limit && !this.queue.length) this.active++;
      else {
        await new Promise((resolve, reject) => {
          const w = { resolve: resolve, reject: reject, onAbort: null, signal: signal };
          if (signal) {
            w.onAbort = () => {
              const i = this.queue.indexOf(w);
              if (i >= 0) this.queue.splice(i, 1);
              reject(abortError());
            };
            signal.addEventListener('abort', w.onAbort, { once: true });
          }
          this.queue.push(w);
        });
      }
      // 已占到名额；若处于 429 冷却期则持有名额等待，防止冷却结束瞬间的突发
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) {
        try { await U.sleep(wait, signal); } catch (e) { this.release(); throw e; }
      }
    }
    release() {
      this.active = Math.max(0, this.active - 1);
      this._drain();
    }
    _drain() {
      while (this.active < this.limit && this.queue.length) {
        const w = this.queue.shift();
        this.active++;
        if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
        w.resolve();
      }
    }
    onSuccess() {
      if (this.limit >= this.max) { this.okStreak = 0; return; }
      if (++this.okStreak >= this.limit) {
        this.limit++;
        this.okStreak = 0;
        this._drain();
      }
    }
    onRateLimit(retryAfterMs) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.okStreak = 0;
      const until = Date.now() + (retryAfterMs != null ? retryAfterMs : 1000);
      if (until > this.cooldownUntil) this.cooldownUntil = until;
    }
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
    if (status === 401 || status === 403) return 'API 密钥无效或无权限（HTTP ' + status + '）：请在设置页检查密钥是否填对、是否已作废';
    if (status === 402) return '账户余额不足（HTTP 402）：请到 AI 服务商控制台充值后重试';
    if (err.badModel) {
      // DeepSeek 会列出支持的模型名，直接转告
      const m = /supported (?:api )?model names are ([^.(]+)/i.exec(err.detail || '');
      return '模型名有误（HTTP ' + status + '）：' + (m ? '可用的模型是 ' + m[1].trim() : '请在设置页检查模型名');
    }
    if (status === 404) return '接口地址或模型不存在（HTTP 404）：请检查 Base URL 与模型名';
    if (status === 422) return '请求参数不被接受（HTTP 422）：' + U.truncate(err.detail || '', 120);
    if (status === 429) return '触发速率限制（HTTP 429）：请降低并发数或稍后重试';
    if (status === 503) return 'AI 服务繁忙（HTTP 503）：请稍后重试';
    if (status >= 500) return 'AI 服务端错误（HTTP ' + status + '）：请稍后重试';
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return '请求超时，请检查网络或调大超时时间';
    if (err.name === 'TypeError') return '网络请求失败：无法连接 ' + (err.url || 'API 地址') + '（检查地址/代理/网络）';
    return U.truncate(err.message || String(err), 300);
  };
})();
