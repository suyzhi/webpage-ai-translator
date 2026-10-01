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
    s.autoSites = normalizeSites(s.autoSites);
    s.neverSites = normalizeSites(s.neverSites);
    // 一次性迁移：旧版默认的批次大小（1200 / 16）升级为新默认值；用户自己改过的值不动
    if (raw && !(raw.settingsRev >= 2)) {
      if (s.batchChars === 1200) s.batchChars = d.batchChars;
      if (s.batchItems === 16) s.batchItems = d.batchItems;
      s.firstBatchChars = Math.min(s.firstBatchChars, s.batchChars);
    }
    s.settingsRev = NS.SETTINGS_REV;
    const flags = ['skipTargetLang', 'translateTitle', 'useCache', 'autoTranslate', 'animations', 'lazyTranslate'];
    for (let i = 0; i < flags.length; i++) s[flags[i]] = !!s[flags[i]];
    return s;
  }

  /* 网站名单：接受数组或「换行 / 逗号 / 空格」分隔的文本；只保留主机名（去协议、路径、端口、*. 与 www.） */
  const HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
  function normalizeHost(v) {
    let h = String(v || '').trim().toLowerCase();
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
    h = h.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    return HOST_RE.test(h) ? h : '';
  }

  function normalizeSites(v) {
    const list = Array.isArray(v) ? v : String(v || '').split(/[\s,，、]+/);
    const out = [];
    for (let i = 0; i < list.length && out.length < 500; i++) {
      const h = normalizeHost(list[i]);
      if (h && out.indexOf(h) < 0) out.push(h);
    }
    return out;
  }

  /* host 是否属于名单中的某个网站（含子域名） */
  function siteMatches(list, host) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    for (let i = 0; i < list.length; i++) {
      if (h === list[i] || h.slice(-(list[i].length + 1)) === '.' + list[i]) return true;
    }
    return false;
  }

  /* 该网站是否应自动翻译 */
  function autoAllowed(s, host) {
    if (!s.autoTranslate) return false;
    if (siteMatches(s.neverSites, host)) return false;
    return !s.autoSites.length || siteMatches(s.autoSites, host);
  }

  /*
   * 弹出面板「自动翻译此网站」开关 -> 设置补丁：
   *   开：总开关关闭时只为此站开启（不会顺带开启所有网站）；名单模式下加入名单；全站模式下移出排除名单。
   *   关：名单模式下移出名单（名单清空则关闭总开关，避免变成「所有网站」）；全站模式下加入排除名单。
   */
  function siteAutoPatch(s, host, on) {
    const h = normalizeHost(host);
    if (!h) return {};
    const without = function (list) { return list.filter(function (x) { return x !== h && !siteMatches([x], h); }); };
    if (on) {
      const never = without(s.neverSites);
      if (!s.autoTranslate) return { autoTranslate: true, autoSites: [h], neverSites: never };
      if (s.autoSites.length) return { autoSites: siteMatches(s.autoSites, h) ? s.autoSites : s.autoSites.concat([h]), neverSites: never };
      return { neverSites: never };
    }
    if (s.autoSites.length) {
      const rest = without(s.autoSites);
      return rest.length ? { autoSites: rest } : { autoSites: [], autoTranslate: false };
    }
    return { neverSites: s.neverSites.concat([h]) };
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

  NS.settings = {
    get: get, set: set, reset: reset, normalize: normalize, onChange: onChange, forContent: forContent,
    normalizeHost: normalizeHost, siteMatches: siteMatches, autoAllowed: autoAllowed, siteAutoPatch: siteAutoPatch
  };
})();
