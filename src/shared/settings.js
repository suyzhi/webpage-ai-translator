/*
 * 设置读写：统一存放于 chrome.storage.local（密钥不参与云同步）。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.settings) return;

  const L = NS.LIMITS;

  function clampNum(v, range, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.round(Math.min(range[1], Math.max(range[0], n)) * 100) / 100;
  }

  function normalize(raw) {
    const d = NS.DEFAULT_SETTINGS;
    const s = Object.assign({}, d, raw || {});
    s.provider = s.provider === 'anthropic' ? 'anthropic' : 'openai';
    s.baseUrl = String(s.baseUrl || '').trim();
    s.apiKey = String(s.apiKey || '').trim();
    s.model = String(s.model || '').trim();
    s.targetLang = NS.LANG_MAP[s.targetLang] ? s.targetLang : d.targetLang;
    s.sourceLang = (s.sourceLang && s.sourceLang !== 'auto' && !NS.LANG_MAP[s.sourceLang]) ? 'auto' : (s.sourceLang || 'auto');
    s.displayMode = s.displayMode === 'translation' ? 'translation' : 'bilingual';
    s.markStyle = ['none', 'underline', 'border', 'background', 'dim'].indexOf(s.markStyle) >= 0 ? s.markStyle : 'none';
    s.concurrency = clampNum(s.concurrency, L.concurrency, d.concurrency);
    s.batchChars = clampNum(s.batchChars, L.batchChars, d.batchChars);
    s.batchItems = clampNum(s.batchItems, L.batchItems, d.batchItems);
    s.firstBatchChars = Math.min(clampNum(s.firstBatchChars, L.firstBatchChars, d.firstBatchChars), s.batchChars);
    s.maxRetries = clampNum(s.maxRetries, L.maxRetries, d.maxRetries);
    s.timeoutMs = clampNum(s.timeoutMs, L.timeoutMs, d.timeoutMs);
    s.minTextLength = clampNum(s.minTextLength, L.minTextLength, d.minTextLength);
    s.cacheMaxEntries = clampNum(s.cacheMaxEntries, L.cacheMaxEntries, d.cacheMaxEntries);
    s.temperature = clampNum(s.temperature, L.temperature, d.temperature);
    s.customPrompt = String(s.customPrompt || '').slice(0, 2000);
    // 一次性迁移：旧版默认的批次大小（1200 / 16）升级为新默认值；用户自己改过的值不动
    if (raw && !(raw.settingsRev >= 2)) {
      if (s.batchChars === 1200) s.batchChars = d.batchChars;
      if (s.batchItems === 16) s.batchItems = d.batchItems;
      s.firstBatchChars = Math.min(s.firstBatchChars, s.batchChars);
    }
    // 第二次批次升级：上一版默认值（2000 / 24）升级为新默认值；用户自己改过的值不动
    if (raw && !(raw.settingsRev >= 4)) {
      if (s.batchChars === 2000) s.batchChars = d.batchChars;
      if (s.batchItems === 24) s.batchItems = d.batchItems;
    }
    // 本页术语表在 0.x 预发版里曾默认开启，拖慢首屏之后的段落：已存的设置一律改回关闭，需要时用户自己再开
    if (raw && !(raw.settingsRev >= 5)) s.pageGlossary = false;
    // DeepSeek 官方已把 deepseek-chat 并入 deepseek-flash（服务端只剩别名），迁移到正式名称，免得别名下线后报错
    if (raw && !(raw.settingsRev >= 3) && s.model === 'deepseek-chat' && /(^|\.)deepseek\.com(\/|:|$)/i.test(s.baseUrl.replace(/^https?:\/\//i, ''))) {
      s.model = 'deepseek-flash';
    }
    const flags = ['skipTargetLang', 'translateTitle', 'useCache', 'autoTranslate', 'animations', 'lazyTranslate', 'pageGlossary'];
    for (let i = 0; i < flags.length; i++) s[flags[i]] = !!s[flags[i]];
    s.siteRules = NS.util.normalizeSiteRules(s.siteRules);
    // 兼容迁移：旧版预发分支的 autoSites / neverSites 名单并入 siteRules
    if (raw && !(raw.settingsRev >= 6) && (raw.autoSites != null || raw.neverSites != null)) {
      const toList = function (v) { return Array.isArray(v) ? v : String(v || '').split(/[\s,，、]+/); };
      const rules = Object.assign({}, s.siteRules);
      const autoList = toList(raw.autoSites).map(NS.util.normalizeHost).filter(Boolean);
      const neverList = toList(raw.neverSites).map(NS.util.normalizeHost).filter(Boolean);
      if (autoList.length && s.autoTranslate) {
        for (let i = 0; i < autoList.length; i++) if (!rules[autoList[i]]) rules[autoList[i]] = 'always';
        // 旧版 autoSites 非空表示「仅对这些网站自动翻译」，对应关闭全局开关 + 规则「总是翻译」
        s.autoTranslate = false;
      }
      for (let i = 0; i < neverList.length; i++) rules[neverList[i]] = 'never';
      s.siteRules = NS.util.normalizeSiteRules(rules);
    }
    delete s.autoSites;
    delete s.neverSites;
    s.settingsRev = NS.SETTINGS_REV;
    return s;
  }

  async function get() {
    try {
      const got = await chrome.storage.local.get(NS.SETTINGS_KEY);
      return normalize(got[NS.SETTINGS_KEY]);
    } catch (e) {
      return normalize(null);
    }
  }

  async function set(patch) {
    const cur = await get();
    const next = normalize(Object.assign({}, cur, patch || {}));
    const payload = {};
    payload[NS.SETTINGS_KEY] = next;
    await chrome.storage.local.set(payload);
    return next;
  }

  /* 设置单个网站的规则：rule 为 'always' | 'never'，其他值表示删除（恢复默认） */
  async function setSiteRule(host, rule) {
    const cur = await get();
    const h = NS.util.normalizeHost(host);
    if (!h) return cur;
    const rules = Object.assign({}, cur.siteRules);
    if (rule === 'always' || rule === 'never') rules[h] = rule;
    else delete rules[h];
    return set({ siteRules: rules });
  }

  async function reset() {
    const next = normalize(null);
    const payload = {};
    payload[NS.SETTINGS_KEY] = next;
    await chrome.storage.local.set(payload);
    return next;
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[NS.SETTINGS_KEY]) return;
      cb(normalize(changes[NS.SETTINGS_KEY].newValue));
    });
  }

  /* 传给内容脚本的运行时设置（不含密钥） */
  function forContent(s) {
    return {
      targetLang: s.targetLang,
      sourceLang: s.sourceLang,
      minTextLength: s.minTextLength,
      displayMode: s.displayMode,
      markStyle: s.markStyle,
      skipTargetLang: s.skipTargetLang,
      translateTitle: s.translateTitle,
      pageGlossary: s.pageGlossary,
      animations: s.animations
    };
  }

  NS.settings = { get: get, set: set, setSiteRule: setSiteRule, reset: reset, normalize: normalize, onChange: onChange, forContent: forContent };
})();
