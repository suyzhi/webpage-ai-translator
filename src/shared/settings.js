/*
 * 设置读写：统一存放于 chrome.storage.local（密钥不参与云同步）。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
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
    s.markStyle = ['none', 'underline', 'border', 'background'].indexOf(s.markStyle) >= 0 ? s.markStyle : 'none';
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
    const flags = ['skipTargetLang', 'translateTitle', 'useCache', 'autoTranslate', 'animations'];
    for (let i = 0; i < flags.length; i++) s[flags[i]] = !!s[flags[i]];
    s.siteRules = NS.util.normalizeSiteRules(s.siteRules);
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
      animations: s.animations
    };
  }

  NS.settings = { get: get, set: set, setSiteRule: setSiteRule, reset: reset, normalize: normalize, onChange: onChange, forContent: forContent };
})();
