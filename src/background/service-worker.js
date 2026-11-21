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

  async function ensureContent(tabId, tabUrl) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: NS.MSG.PING }, { frameId: 0 });
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
      let url = tabUrl || '';
      if (!url && chrome.tabs && typeof chrome.tabs.get === 'function') {
        try { const t = await chrome.tabs.get(tabId); url = (t && t.url) || ''; } catch (e2) {}
      }
      return { ok: false, error: friendlyInjectError(e, url) };
    }
  }

  function friendlyInjectError(e, url) {
    const m = String((e && e.message) || e || '');
    const u = String(url || '');
    if (/^file:\/\//i.test(u) || /file:\/\//i.test(m)) {
      return '无法访问本地文件：请在扩展管理页开启「允许访问文件网址」后刷新重试';
    }
    if (/\.pdf([?#]|$)/i.test(u) || /mhjfbmdgcfjbbpaeojofohoefgiehjai/i.test(u)) {
      return '暂不支持直接翻译浏览器内置 PDF 预览页';
    }
    if (/gallery|chrome\.google\.com|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons/i.test(m + ' ' + u)) {
      return '无法在扩展商店页面上运行';
    }
    if (/^(?:chrome|edge|about|view-source|devtools|chrome-extension|edge-extension):/i.test(u) || /chrome:\/\/|edge:\/\//i.test(m)) {
      return '无法在浏览器内部页面上运行';
    }
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
    const res = await ensureContent(tab.id, tab.url);
    if (!res.ok) {
      // 快捷键 / 右键触发失败时用红色角标提示，避免完全无反应
      setBadge(tab.id, '!', '#dc2626');
      setTimeout(function () { setBadge(tab.id, ''); }, 3500);
      return;
    }
    try { await chrome.tabs.sendMessage(tab.id, manualMessage(res), { frameId: 0 }); } catch (e) {}
  }

  /* ---------------- 累计用量（持久化，串行读改写，避免并发请求互相覆盖） ---------------- */
  let usageChain = Promise.resolve();
  function recordUsage(u) {
    if (!u) return;
    usageChain = usageChain.then(async function () {
      const got = await chrome.storage.local.get(NS.USAGE_KEY);
      const cur = got[NS.USAGE_KEY] || { input: 0, output: 0, cached: 0, requests: 0, since: Date.now() };
      cur.input += u.input || 0;
      cur.output += u.output || 0;
      cur.cached += u.cached || 0;
      cur.requests += 1;
      const payload = {};
      payload[NS.USAGE_KEY] = cur;
      await chrome.storage.local.set(payload);
    }).catch(function () {});
    return usageChain;
  }

  function resetUsage() {
    usageChain = usageChain.then(function () {
      const payload = {};
      payload[NS.USAGE_KEY] = { input: 0, output: 0, cached: 0, requests: 0, since: Date.now() };
      return chrome.storage.local.set(payload);
    }).catch(function () {});
    return usageChain;
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
      terms: Array.isArray(msg.terms) ? msg.terms.slice(0, 16) : null,
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
      onUsage: function (u) {
        recordUsage(u);                                  // token 已花出去：无论任务是否被取消都计入累计
        if (!job.cancelled) safePost(port, { type: NS.MSG.USAGE, usage: u });
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
      requests: s.requests, batches: s.batches, usage: s.usage,
      elapsedMs: (s.finishedAt || Date.now()) - s.startedAt
    };
  }

  chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== NS.PORT_NAME) return;
    // 徽标只反映顶层页面的进度：子框架（iframe）的任务不改徽标
    const tabId = port.sender && port.sender.tab && !port.sender.frameId ? port.sender.tab.id : null;
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
            const res = await ensureContent(tabId, msg.url || (sender.tab && sender.tab.url));
            if (res.ok && msg.toggle) {
              try { await chrome.tabs.sendMessage(tabId, manualMessage(res), { frameId: 0 }); } catch (e) {}
            }
            return sendResponse(res);
          }
          case 'wpt:frames': {
            // 顶层页面开始 / 还原 / 停止：转发给同一标签页的子框架（开始时先把脚本注入进去）
            const tabId = sender.tab && sender.tab.id;
            if (tabId == null || sender.frameId) return sendResponse({ ok: false });
            let injected = null;
            if (msg.action === 'start') {
              try {
                const res = await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: NS.CONTENT_FILES.slice(), injectImmediately: true });
                injected = res.length;
              } catch (e) { injected = String(e && e.message || e); /* 个别框架不可注入（浏览器内部页、已销毁）不影响其余 */ }
            }
            try { await chrome.tabs.sendMessage(tabId, { type: 'wpt:frame-cmd', action: msg.action, overrides: msg.overrides || null }); } catch (e) {}
            return sendResponse({ ok: true, injected: injected });
          }
          case 'wpt:frame-status': {
            // 子框架上报翻译状态给顶层页面（用于 frameset / iframe 为主体的页面）
            const tabId = sender.tab && sender.tab.id;
            if (tabId == null || !sender.frameId) return sendResponse({ ok: false });
            try {
              await chrome.tabs.sendMessage(tabId, {
                type: 'wpt:frame-status',
                frameId: sender.frameId,
                active: !!msg.active,
                translated: msg.translated || 0
              }, { frameId: 0 });
            } catch (e) {}
            return sendResponse({ ok: true });
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
              recordUsage(out.usage);
              return sendResponse({ ok: true, text: out.text, ms: out.ms, model: s.model });
            } catch (e) {
              return sendResponse({ ok: false, error: U.describeError(e) });
            } finally {
              clearTimeout(timer);
            }
          }
          case 'wpt:open-options':
            try { await chrome.runtime.openOptionsPage(); } catch (e) {}
            return sendResponse({ ok: true });
          case NS.MSG.USAGE_RESET:
            await resetUsage();
            return sendResponse({ ok: true });
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

  /*
   * 一次性迁移（设置修订号低于当前值时）：把迁移后的设置写回存储，
   * 并清空旧缓存 —— 系统提示词已更新，旧缓存键再也不会命中，只会白占配额。
   */
  async function migrateStored() {
    const got = await chrome.storage.local.get(NS.SETTINGS_KEY);
    const raw = got[NS.SETTINGS_KEY];
    if (!raw || raw.settingsRev >= NS.SETTINGS_REV) return;
    await NS.settings.set({});
    await cache.load();
    await cache.clear();
  }

  chrome.runtime.onInstalled.addListener(function (details) {
    migrateStored().catch(function () {}).then(applyAutoRegistration);
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
