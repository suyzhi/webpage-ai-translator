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
  const jobs = new Map();          // port -> { engine, sig, cancelled, lastProgressAt }
  let keepAlive = null;

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

  async function toggleInTab(tab) {
    if (!tab || tab.id == null) return;
    const res = await ensureContent(tab.id);
    if (!res.ok) return;
    try { await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.TOGGLE }); } catch (e) {}
  }

  /* ---------------- 任务 ----------------
   * 每个端口（= 一个标签页的一次翻译会话）至多一个运行中的引擎：
   *   - 同一端口上的消息串行处理，避免两次 START 交错 await 后并行跑出两个引擎；
   *   - 运行中收到新的 START（动态内容增量）直接 add() 追加，不再中止在途请求重来；
   *   - 被 STOP / 断开 / 设置变更取代的任务标记 cancelled，绝不再发送 DONE。
   */

  function jobSignature(s) {
    return [s.provider, s.baseUrl, s.model, s.targetLang, s.sourceLang, s.customPrompt, s.temperature, s.useCache, U.hashText(s.apiKey || '')].join('|');
  }

  function cancelJob(port) {
    const job = jobs.get(port);
    if (!job) return;
    job.cancelled = true;
    job.engine.stop();
    jobs.delete(port);
  }

  async function startJob(port, tabId, msg) {
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

    const sig = jobSignature(settings);
    const cur = jobs.get(port);
    if (cur && cur.sig === sig && cur.engine.add(items)) return;     // 增量追加到运行中的任务
    if (cur && cur.sig !== sig) cancelJob(port);                       // 设置已变：旧任务作废
    if (!items.length) {
      if (!jobs.has(port)) safePost(port, { type: NS.MSG.DONE, stats: { total: 0, done: 0, failed: 0, cached: 0 }, failedIds: [] });
      return;
    }

    await cache.load(settings.cacheMaxEntries);
    startKeepAlive();
    setBadge(tabId, '…', '#4f46e5');

    const job = { engine: null, sig: sig, cancelled: false, lastProgressAt: 0 };
    const engine = new NS.Engine({
      settings: settings,
      cache: cache,
      quickStart: !msg.incremental,
      onResults: function (entries) {
        if (!job.cancelled) safePost(port, { type: NS.MSG.RESULTS, entries: entries });
      },
      onProgress: function (stats) {
        if (job.cancelled) return;
        const now = Date.now();
        if (now - job.lastProgressAt < 180 && stats.done < stats.total) return;
        job.lastProgressAt = now;
        safePost(port, { type: NS.MSG.PROGRESS, stats: publicStats(stats) });
        if (tabId != null && stats.total) {
          const pct = Math.min(99, Math.round((stats.done / stats.total) * 100));
          setBadge(tabId, String(pct), stats.failed ? '#d97706' : '#4f46e5');
        }
      },
      onFatal: function (err) {
        if (!job.cancelled) safePost(port, { type: NS.MSG.ERROR, error: U.describeError(err), code: 'FATAL' });
      },
      log: function (text) { if (!job.cancelled) safePost(port, { type: NS.MSG.PROGRESS, log: text }); }
    });
    job.engine = engine;
    jobs.set(port, job);
    engine.add(items);

    engine.whenIdle().then(function (stats) {
      if (jobs.get(port) === job) jobs.delete(port);
      stopKeepAliveIfIdle();
      if (job.cancelled) return;
      if (engine.fatalError) {
        setBadge(tabId, '!', '#dc2626');
        return;
      }
      setBadge(tabId, '');
      safePost(port, {
        type: NS.MSG.DONE,
        stats: publicStats(stats),
        failedIds: engine.failedIds.slice(),
        error: stats.failed ? '部分内容翻译失败（' + stats.failed + ' 段），可稍后重试' : null
      });
    }).catch(function (err) {
      if (jobs.get(port) === job) jobs.delete(port);
      stopKeepAliveIfIdle();
      setBadge(tabId, '');
      if (!job.cancelled && !U.isAbort(err)) safePost(port, { type: NS.MSG.ERROR, error: U.describeError(err), code: 'ENGINE' });
    });
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
    let chain = Promise.resolve();

    port.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === NS.MSG.START) {
        chain = chain.then(function () { return startJob(port, tabId, msg); }).catch(function (e) {
          safePost(port, { type: NS.MSG.ERROR, error: U.describeError(e) });
        });
      } else if (msg.type === NS.MSG.STOP) {
        chain = chain.then(function () {
          cancelJob(port);
          setBadge(tabId, '');
          stopKeepAliveIfIdle();
        });
      }
    });

    port.onDisconnect.addListener(function () {
      cancelJob(port);
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
              try { await chrome.tabs.sendMessage(tabId, { type: NS.MSG.TOGGLE }); } catch (e) {}
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

  /* ---------------- 自动翻译：动态注册内容脚本 ---------------- */
  async function applyAutoRegistration() {
    const s = await NS.settings.get();
    try { await chrome.scripting.unregisterContentScripts({ ids: ['wpt-auto'] }); } catch (e) {}
    if (!s.autoTranslate) return;
    try {
      await chrome.scripting.registerContentScripts([{
        id: 'wpt-auto',
        js: NS.CONTENT_FILES.slice(),
        matches: ['http://*/*', 'https://*/*'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true
      }]);
    } catch (e) { /* 已注册或权限不足 */ }
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
    if (!!next.autoTranslate !== !!prev.autoTranslate || (next.autoTranslate && next.targetLang !== prev.targetLang)) {
      applyAutoRegistration();
    }
  });

  NS.settings.get().then(function (s) { cache.load(s.cacheMaxEntries); }).catch(function () {});
})();
