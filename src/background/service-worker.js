/*
 * 后台 Service Worker：消息路由、任务生命周期、注入控制、缓存管理、角标进度。
 */
importScripts(
  '../shared/constants.js',
  '../shared/util.js',
  '../shared/settings.js',
  '../shared/prompt.js',
  './providers.js',
  './cache.js',
  './engine.js'
);

(function () {
  'use strict';
  const NS = globalThis.WPT;
  const U = NS.util;
  const cache = new NS.TranslationCache();
  const jobs = new Map();          // port -> engine
  let keepAlive = null;
  let lastProgressAt = 0;

  /* ---------------- 工具 ---------------- */

  function isLocalUrl(url) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(String(url || ''));
  }

  function safePost(port, msg) {
    try { port.postMessage(msg); return true; } catch (e) { return false; }
  }

  function setBadge(tabId, text, color) {
    if (tabId == null) return;
    try { chrome.action.setBadgeText({ tabId: tabId, text: text || '' }); } catch (e) {}
    if (color) { try { chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color }); } catch (e) {} }
  }

  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(function () {
      try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) {}
    }, 20000);
  }

  function stopKeepAliveIfIdle() {
    if (jobs.size === 0 && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }

  async function ensureContent(tabId) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: NS.MSG.PING });
      if (r && r.ok) return { ok: true, injected: false };
    } catch (e) { /* 未注入 */ }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: NS.CONTENT_FILES.slice(),
        injectImmediately: true
      });
      return { ok: true, injected: true };
    } catch (e) {
      return { ok: false, error: friendlyInjectError(e) };
    }
  }

  function friendlyInjectError(e) {
    const m = String((e && e.message) || e || '');
    if (/gallery|chrome\.google\.com/i.test(m)) return '无法在扩展商店页面上运行';
    if (/chrome:\/\/|edge:\/\//i.test(m)) return '无法在浏览器内部页面上运行';
    if (/Cannot access|not allowed|Missing host permission/i.test(m)) return '无权访问此页面，请刷新页面后重试';
    return '注入失败：' + U.truncate(m, 120);
  }

  /*
   * 手动「翻译 / 还原」：刚注入的内容脚本没有可还原的译文，发 START 而不是 TOGGLE。
   * 注入时内容脚本会按网站规则判定是否自动翻译，若已自动启动，START 会与之合并，TOGGLE 则会把它停掉。
   */
  function manualMessage(res) {
    return { type: res.injected ? NS.MSG.START : NS.MSG.TOGGLE };
  }

  async function toggleInTab(tab) {
    if (!tab || tab.id == null) return;
    const res = await ensureContent(tab.id);
    if (!res.ok) return;
    try { await chrome.tabs.sendMessage(tab.id, manualMessage(res)); } catch (e) {}
  }

  /* ---------------- 任务 ---------------- */

  async function startJob(port, tabId, msg) {
    const prev = jobs.get(port);
    if (prev) { prev.stop(); jobs.delete(port); }

    const base = await NS.settings.get();
    const settings = Object.assign({}, base, msg.overrides || {});
    const items = Array.isArray(msg.items) ? msg.items : [];

    if (!settings.apiKey && !isLocalUrl(settings.baseUrl)) {
      safePost(port, {
        type: NS.MSG.ERROR,
        error: '尚未填写 API 密钥',
        hint: '请点击扩展图标 → 设置，填写你自己的 AI API 密钥后再试。',
        code: 'NO_KEY'
      });
      return;
    }
    if (!items.length) {
      safePost(port, { type: NS.MSG.DONE, stats: { total: 0, done: 0, failed: 0, cached: 0 } });
      return;
    }

    await cache.load(settings.cacheMaxEntries);
    startKeepAlive();
    setBadge(tabId, '…', '#4f46e5');

    const engine = new NS.Engine({
      settings: settings,
      cache: cache,
      onResults: function (entries) {
        safePost(port, { type: NS.MSG.RESULTS, entries: entries });
      },
      onProgress: function (stats) {
        const now = Date.now();
        if (now - lastProgressAt < 180 && stats.done < stats.total) return;
        lastProgressAt = now;
        safePost(port, { type: NS.MSG.PROGRESS, stats: publicStats(stats) });
        if (tabId != null && stats.total) {
          const pct = Math.min(99, Math.round((stats.done / stats.total) * 100));
          setBadge(tabId, String(pct), stats.failed ? '#d97706' : '#4f46e5');
        }
      },
      onFatal: function (err) {
        safePost(port, { type: NS.MSG.ERROR, error: U.describeError(err), code: 'FATAL' });
      },
      log: function (text) { safePost(port, { type: NS.MSG.PROGRESS, log: text }); }
    });
    jobs.set(port, engine);

    try {
      const stats = await engine.run(items);
      engine.stats = stats;
      if (engine.fatalError) {
        setBadge(tabId, '!', '#dc2626');
      } else {
        setBadge(tabId, '');
        safePost(port, {
          type: NS.MSG.DONE,
          stats: publicStats(stats),
          error: stats.failed ? '部分内容翻译失败（' + stats.failed + ' 段），可稍后重试' : null
        });
      }
    } catch (err) {
      if (!U.isAbort(err)) {
        safePost(port, { type: NS.MSG.ERROR, error: U.describeError(err), code: 'ENGINE' });
      }
      setBadge(tabId, '');
    } finally {
      try { await cache.flush(); } catch (e) {}
      if (jobs.get(port) === engine) jobs.delete(port);
      stopKeepAliveIfIdle();
    }
  }

  function publicStats(s) {
    return {
      total: s.total, done: s.done, failed: s.failed, cached: s.cached,
      requests: s.requests, batches: s.batches,
      elapsedMs: (s.finishedAt || Date.now()) - s.startedAt
    };
  }

  chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== NS.PORT_NAME) return;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;

    port.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === NS.MSG.START) {
        startJob(port, tabId, msg).catch(function (e) {
          safePost(port, { type: NS.MSG.ERROR, error: U.describeError(e) });
        });
      } else if (msg.type === NS.MSG.STOP) {
        const eng = jobs.get(port);
        if (eng) { eng.stop(); jobs.delete(port); }
        setBadge(tabId, '');
        stopKeepAliveIfIdle();
      }
    });

    port.onDisconnect.addListener(function () {
      const eng = jobs.get(port);
      if (eng) { eng.stop(); jobs.delete(port); }
      setBadge(tabId, '');
      stopKeepAliveIfIdle();
    });
  });

  /* ---------------- 一次性消息 ---------------- */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    (async function () {
      try {
        switch (msg.type) {
          case NS.MSG.INJECT: {
            const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
            if (tabId == null) return sendResponse({ ok: false, error: '没有可用的标签页' });
            const res = await ensureContent(tabId);
            if (res.ok && msg.toggle) {
              try { await chrome.tabs.sendMessage(tabId, manualMessage(res)); } catch (e) {}
            }
            return sendResponse(res);
          }
          case NS.MSG.CACHE_CLEAR:
            await cache.load();
            await cache.clear();
            return sendResponse({ ok: true, stats: cache.stats() });
          case NS.MSG.CACHE_STATS:
            await cache.load();
            return sendResponse({ ok: true, stats: cache.stats() });
          case NS.MSG.TEST_CONNECTION: {
            const cur = await NS.settings.get();
            const s = Object.assign({}, cur, msg.settings || {});
            if (!s.apiKey && !isLocalUrl(s.baseUrl)) {
              return sendResponse({ ok: false, error: '尚未填写 API 密钥' });
            }
            const ctrl = new AbortController();
            const timer = setTimeout(function () { ctrl.abort(); }, Math.min(s.timeoutMs, 60000));
            try {
              const out = await NS.providers.probe(s, ctrl.signal);
              return sendResponse({ ok: true, text: out.text, ms: out.ms, model: s.model });
            } catch (e) {
              return sendResponse({ ok: false, error: U.describeError(e) });
            } finally {
              clearTimeout(timer);
            }
          }
          case NS.MSG.PING:
            return sendResponse({ ok: true, version: NS.VERSION });
          default:
            return sendResponse({ ok: false, error: 'unknown message: ' + msg.type });
        }
      } catch (e) {
        try { sendResponse({ ok: false, error: U.describeError(e) }); } catch (e2) {}
      }
    })();
    return true;   // 异步响应
  });

  /* ---------------- 自动翻译：动态注册内容脚本 ----------------
   * 注册范围由全局开关与网站规则决定（见 util.autoRegistrationFor）；
   * 注册只是粗筛，内容脚本启动前还会按网站规则再判定一次。
   */
  let registering = Promise.resolve();

  /* 串行执行：连续修改设置时，避免注销 / 注册交错导致 id 冲突或留下旧的注册 */
  function applyAutoRegistration() {
    registering = registering.then(doApplyAutoRegistration).catch(function () {});
    return registering;
  }

  async function doApplyAutoRegistration() {
    const s = await NS.settings.get();
    try { await chrome.scripting.unregisterContentScripts({ ids: ['wpt-auto'] }); } catch (e) {}
    const reg = U.autoRegistrationFor(s);
    if (!reg) return;
    const script = {
      id: 'wpt-auto',
      js: NS.CONTENT_FILES.slice(),
      matches: reg.matches,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    };
    if (reg.excludeMatches) script.excludeMatches = reg.excludeMatches;
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (e) {
      // 已注册或权限不足；若带排除规则，退回到不排除，由内容脚本按网站规则自行跳过
      if (!script.excludeMatches) return;
      delete script.excludeMatches;
      try { await chrome.scripting.registerContentScripts([script]); } catch (e2) {}
    }
  }

  chrome.runtime.onInstalled.addListener(function (details) {
    applyAutoRegistration();
    try {
      chrome.contextMenus.removeAll(function () {
        chrome.contextMenus.create({ id: 'wpt-toggle', title: 'AI 翻译此页面 / 还原原文', contexts: ['page'] });
      });
    } catch (e) {}
    if (details && details.reason === 'install') {
      try { chrome.runtime.openOptionsPage(); } catch (e) {}
    }
  });

  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === 'wpt-toggle') toggleInTab(tab);
  });

  chrome.commands.onCommand.addListener(function (cmd) {
    if (cmd !== 'toggle-translate') return;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
      if (tabs && tabs[0]) toggleInTab(tabs[0]);
    });
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes[NS.SETTINGS_KEY]) return;
    const next = changes[NS.SETTINGS_KEY].newValue || {};
    const prev = changes[NS.SETTINGS_KEY].oldValue || {};
    const regKey = function (v) { return JSON.stringify(U.autoRegistrationFor(v)); };
    if (regKey(next) !== regKey(prev) || (next.autoTranslate && next.targetLang !== prev.targetLang)) {
      applyAutoRegistration();
    }
  });

  NS.settings.get().then(function (s) { cache.load(s.cacheMaxEntries); }).catch(function () {});
})();
