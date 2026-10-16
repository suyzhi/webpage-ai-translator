/*
 * 内容脚本主编排：抽取 -> 视口优先排序 -> 流式请求 -> 逐帧渲染 -> 动态内容增量翻译。
 *
 * 可靠性设计：
 *   - Service Worker 可能在长任务中被回收：端口断开后自动重连并补发未完成片段；
 *   - 20s 心跳维持后台存活；
 *   - 渲染走 requestAnimationFrame 批处理，避免与抽取阶段的读操作交错导致布局抖动；
 *   - MutationObserver 处理 SPA / 无限滚动的新增内容，自动忽略自己插入的节点。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Content) { return; }          // 重复注入时保留既有状态与监听器
  const U = NS.util;

  const state = {
    status: NS.STATUS.IDLE,
    settings: null,
    overrides: null,
    units: [],
    byId: new Map(),
    nodes: new Map(),           // unitId -> 译文节点
    hiddenSources: new Map(),   // 原文元素 -> 原始 display（仅译文模式）
    pending: new Set(),
    knownEls: new WeakSet(),
    total: 0, done: 0, failed: 0, cached: 0,
    error: null,
    seq: 0,
    port: null,
    heartbeat: null,
    reconnectTries: 0,
    renderQueue: [],
    rafId: 0,
    observer: null,
    dirtyRoots: [],
    dirtyTimer: null,
    originalTitle: null,
    jobId: 0,
    starting: false,            // 正在读取设置、尚未进入扫描
    autoRun: false              // 本次启动由自动翻译触发（找不到内容时不提示）
  };

  /* ---------------- 页面内提示 ---------------- */
  const ui = (function () {
    let host = null, root = null, box = null, textEl = null, barEl = null, hideTimer = null;

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.setAttribute('data-wpt', '1');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:18px;bottom:18px;pointer-events:none;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' +
        ':host{all:initial}' +
        '.box{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;' +
        'background:rgba(17,24,39,.93);color:#f9fafb;padding:10px 14px;border-radius:10px;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.28);min-width:180px;max-width:340px;opacity:0;' +
        'transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}' +
        '.box.show{opacity:1;transform:translateY(0)}' +
        '.row{display:flex;align-items:center;gap:8px}' +
        '.dot{width:7px;height:7px;border-radius:50%;background:#818cf8;flex:0 0 auto}' +
        '.dot.busy{animation:pulse 1s ease-in-out infinite}' +
        '.dot.err{background:#f87171}.dot.ok{background:#34d399}' +
        '@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}' +
        '.bar{height:3px;background:rgba(255,255,255,.18);border-radius:2px;margin-top:8px;overflow:hidden}' +
        '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#818cf8,#34d399);transition:width .25s ease}' +
        '.sub{opacity:.65;font-size:11px;margin-top:4px}' +
        '</style>' +
        '<div class="box"><div class="row"><span class="dot"></span><span class="t"></span></div>' +
        '<div class="bar"><i></i></div><div class="sub"></div></div>';
      box = root.querySelector('.box');
      textEl = root.querySelector('.t');
      barEl = root.querySelector('.bar');
      document.documentElement.appendChild(host);
    }

    function show(msg, opts) {
      const o = opts || {};
      ensure();
      clearTimeout(hideTimer);
      textEl.textContent = msg;
      const dot = root.querySelector('.dot');
      dot.className = 'dot' + (o.kind ? ' ' + o.kind : '');
      if (o.progress != null) {
        barEl.style.display = '';
        barEl.firstChild.style.width = Math.round(o.progress * 100) + '%';
      } else {
        barEl.style.display = 'none';
      }
      root.querySelector('.sub').textContent = o.sub || '';
      box.classList.add('show');
      if (o.duration !== 0) {
        hideTimer = setTimeout(hide, o.duration || (o.kind === 'err' ? 7000 : 2600));
      }
      return { update: show };
    }

    function hide() {
      if (!box) return;
      box.classList.remove('show');
      setTimeout(function () { if (host && host.parentNode && !box.classList.contains('show')) { host.parentNode.removeChild(host); host = null; root = null; } }, 260);
    }

    return { show: show, hide: hide };
  })();

  function setStatus(s) {
    if (state.status === s) return;
    state.status = s;
    // 状态变化时轻触后台（同时可重置 Service Worker 的空闲计时器）
    try {
      const p = chrome.runtime.sendMessage({ type: 'wpt:state-changed', status: s });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  function describe(msg) { return msg; }

  function fail(message, hint) {
    state.error = message;
    setStatus(NS.STATUS.ERROR);
    ui.show(message, { kind: 'err', duration: 0, sub: hint || '' });
    stopHeartbeat();
  }

  /* ---------------- 启动翻译 ---------------- */
  async function start(overrides, opts) {
    const auto = !!(opts && opts.auto);
    // 启动尚未完成又收到启动请求（手动注入时自动翻译与手动翻译会同时触发）：合并为一次，手动优先
    if (state.starting || state.status === NS.STATUS.SCANNING) {
      if (!auto) {
        state.autoRun = false;
        if (state.starting) state.overrides = overrides || null;
      }
      return;
    }
    if (state.status === NS.STATUS.TRANSLATING) return;
    state.starting = true;
    state.autoRun = auto;
    state.error = null;
    state.overrides = overrides || null;

    let settings;
    try {
      settings = await NS.settings.get();
    } catch (e) {
      state.starting = false;
      return fail('扩展上下文已失效，请刷新页面后重试');
    }
    state.starting = false;
    settings = Object.assign({}, settings, state.overrides || {});
    state.settings = settings;
    setStatus(NS.STATUS.SCANNING);
    if (!state.autoRun) ui.show('正在分析页面…', { kind: 'busy', duration: 0, sub: '提取可翻译段落' });

    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });

    let units;
    try {
      units = NS.Extractor.collect(document.body, NS.settings.forContent(settings));
    } catch (e) {
      return fail('页面解析失败：' + ((e && e.message) || e));
    }

    if (settings.translateTitle && document.title && U.isTranslatable(U.normalizeText(document.title), NS.settings.forContent(settings))) {
      state.seq++;
      state.originalTitle = document.title;
      units.unshift({ id: state.seq, seq: state.seq, el: null, isTitle: true, text: U.normalizeText(document.title), kind: 'partial', anchorNode: null });
    }

    if (!units.length) {
      // 自动翻译时静默结束：已是目标语言的网站不应每次打开都弹出错误提示
      if (!state.autoRun) ui.show('未找到可翻译的内容', { kind: 'err', sub: '页面可能是图片、代码或已是目标语言' });
      setStatus(NS.STATUS.IDLE);
      return;
    }

    units = NS.Extractor.byViewportPriority(units);
    // 统一重排单元 id：抽取器内部序号与页面级序号相互独立，必须避免撞号
    for (let i = 0; i < units.length; i++) {
      state.seq++;
      units[i].id = state.seq;
    }
    addUnits(units);
    setStatus(NS.STATUS.TRANSLATING);
    updateProgress(true);
    connectAndSend();
    startObserving();
  }

  function addUnits(units) {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      state.units.push(u);
      state.byId.set(u.id, u);
      state.pending.add(u.id);
      if (u.el) { try { state.knownEls.add(u.el); } catch (e) {} }
    }
    state.total = state.units.length;
  }

  /* ---------------- 端口通信 ---------------- */
  function connectAndSend() {
    disconnectPort();
    let port;
    try {
      port = chrome.runtime.connect({ name: NS.PORT_NAME });
    } catch (e) {
      return fail('无法连接扩展后台，请刷新页面后重试');
    }
    state.port = port;
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    startHeartbeat();
    sendPending();
  }

  function sendPending() {
    if (!state.port) return;
    const items = [];
    state.pending.forEach(function (id) {
      const u = state.byId.get(id);
      if (u && u.text) items.push({ id: id, text: u.text });
    });
    if (!items.length) return;
    try {
      state.port.postMessage({ type: NS.MSG.START, items: items, overrides: state.overrides });
    } catch (e) {
      onPortDisconnect();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeat = setInterval(function () {
      try { if (state.port) state.port.postMessage({ type: 'wpt:ping' }); } catch (e) {}
    }, 20000);
  }

  function stopHeartbeat() {
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
  }

  function disconnectPort() {
    stopHeartbeat();
    if (state.port) {
      try { state.port.onMessage.removeListener(onPortMessage); } catch (e) {}
      try { state.port.onDisconnect.removeListener(onPortDisconnect); } catch (e) {}
      try { state.port.disconnect(); } catch (e) {}
      state.port = null;
    }
  }

  function onPortDisconnect() {
    stopHeartbeat();
    state.port = null;
    if (state.status !== NS.STATUS.TRANSLATING) return;
    if (state.reconnectTries >= 5) return fail('后台连接中断', '可点击"翻译此页面"重试，已完成的译文不会丢失');
    state.reconnectTries++;
    const wait = 400 * state.reconnectTries;
    ui.show('正在恢复连接…', { kind: 'busy', duration: 0, sub: '重试 ' + state.reconnectTries + '/5' });
    setTimeout(function () {
      if (state.status !== NS.STATUS.TRANSLATING) return;
      const remaining = state.pending.size;
      if (!remaining) return;
      connectAndSend();
    }, wait);
  }

  function onPortMessage(msg) {
    if (!msg || !msg.type) return;
    state.reconnectTries = 0;
    if (msg.type === NS.MSG.RESULTS) {
      queueRender(msg.entries);
    } else if (msg.type === NS.MSG.DONE) {
      finishJob(msg);
    } else if (msg.type === NS.MSG.ERROR) {
      if (msg.code === 'NO_KEY') {
        setStatus(NS.STATUS.IDLE);
        ui.show('尚未填写 API 密钥', { kind: 'err', duration: 0, sub: '点击浏览器工具栏中的扩展图标 → 设置' });
        state.error = msg.error;
      } else {
        setStatus(NS.STATUS.ERROR);
        state.error = msg.error;
        ui.show(msg.error || '翻译失败', { kind: 'err', duration: 0, sub: msg.hint || '' });
      }
      stopHeartbeat();
    }
  }

  function finishJob(msg) {
    const stats = msg.stats || {};
    state.cached = stats.cached || 0;
    state.failed = stats.failed || 0;
    const failedTotal = state.failed;
    flushRender();
    setStatus(NS.STATUS.DONE);
    stopHeartbeat();
    if (failedTotal > 0) {
      ui.show('翻译完成（' + failedTotal + ' 段失败）', { kind: 'err', sub: '可再次点击重试失败片段' });
    } else {
      const secs = stats.elapsedMs ? (stats.elapsedMs / 1000).toFixed(1) + 's' : '';
      const cached = stats.cached ? '，命中缓存 ' + stats.cached + ' 段' : '';
      ui.show('翻译完成', { kind: 'ok', sub: ('共 ' + (stats.total || state.total) + ' 段' + cached + ' ' + secs).trim() });
    }
  }

  /* ---------------- 渲染（逐帧批处理） ---------------- */
  function queueRender(entries) {
    for (let i = 0; i < entries.length; i++) state.renderQueue.push(entries[i]);
    if (!state.rafId) state.rafId = requestAnimationFrame(flushRender);
  }

  function flushRender() {
    state.rafId = 0;
    if (!state.renderQueue.length) return;
    const batch = state.renderQueue.splice(0, state.renderQueue.length);
    const animate = state.settings && state.settings.animations && state.total <= 300;
    for (let i = 0; i < batch.length; i++) {
      const id = batch[i][0];
      const text = batch[i][1];
      state.pending.delete(id);
      const u = state.byId.get(id);
      if (!u) continue;
      if (u.isTitle) {
        if (state.settings.translateTitle && text) document.title = text;
        continue;
      }
      const existing = state.nodes.get(u.id);
      if (existing && existing.isConnected) { existing.textContent = text; continue; }
      const el = u.el;
      if (!el || !el.isConnected) continue;
      const onlyTranslation = state.settings.displayMode === 'translation';
      const node = NS.Renderer.create(el, text, state.settings);
      const mode = NS.Renderer.insert(node, u, onlyTranslation);
      if (!mode) continue;
      state.nodes.set(u.id, node);
      if (animate) NS.Renderer.animate(node);
      // 仅当译文位于原文元素之外时才隐藏原文，否则会连同译文一起被隐藏
      if (onlyTranslation && u.kind === 'full' && mode === 'sibling' && el !== document.body) {
        state.hiddenSources.set(el, el.style.display || '');
        el.style.display = 'none';
      }
    }
    updateProgress();
  }

  function updateProgress(force) {
    const now = Date.now();
    if (!force && now - (updateProgress.last || 0) < 200) return;
    updateProgress.last = now;
    const total = state.total || 1;
    const done = state.total - state.pending.size;
    if (state.status === NS.STATUS.TRANSLATING) {
      ui.show('正在翻译 ' + done + '/' + state.total, {
        kind: 'busy', duration: 0, progress: done / total,
        sub: state.cached ? '缓存命中 ' + state.cached + ' 段' : ''
      });
    }
  }

  /* ---------------- 还原 ---------------- */
  function restore() {
    stopObserving();
    disconnectPort();
    let removed = 0;
    state.nodes.forEach(function (node) {
      if (node && node.parentNode) { node.parentNode.removeChild(node); removed++; }
    });
    state.nodes.clear();
    state.hiddenSources.forEach(function (display, el) {
      try { el.style.display = display; } catch (e) {}
    });
    state.hiddenSources.clear();
    if (state.originalTitle != null) { try { document.title = state.originalTitle; } catch (e) {} }
    state.originalTitle = null;
    state.renderQueue.length = 0;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    state.units = [];
    state.byId.clear();
    state.pending.clear();
    state.knownEls = new WeakSet();
    state.seq = 0;
    state.total = 0; state.done = 0; state.failed = 0; state.cached = 0;
    state.error = null;
    state.reconnectTries = 0;
    setStatus(NS.STATUS.IDLE);
    if (removed) ui.show('已还原原文', { kind: 'ok' });
    else ui.hide();
  }

  function stopJob() {
    if (state.port) { try { state.port.postMessage({ type: NS.MSG.STOP }); } catch (e) {} }
    disconnectPort();
    stopObserving();
    setStatus(NS.STATUS.IDLE);
    ui.show('已停止翻译', { kind: 'ok' });
  }

  function toggle() {
    if (state.status === NS.STATUS.TRANSLATING || state.status === NS.STATUS.SCANNING) return stopJob();
    if (state.nodes.size || state.status === NS.STATUS.DONE) return restore();
    return start(null);
  }

  /* ---------------- 动态内容（SPA / 滚动加载） ---------------- */
  function startObserving() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(onMutations);
    try {
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  function stopObserving() {
    if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
    if (state.dirtyTimer) { clearTimeout(state.dirtyTimer); state.dirtyTimer = null; }
    state.dirtyRoots = [];
  }

  function isOurs(node) {
    return node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-wpt');
  }

  function onMutations(mutations) {
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (isOurs(m.target)) continue;
      const added = m.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (isOurs(n)) continue;
        if (n.nodeType === 3) {
          const p = n.parentNode;
          if (p && p.nodeType === 1) { state.dirtyRoots.push(p); relevant = true; }
        } else if (n.nodeType === 1) {
          state.dirtyRoots.push(n); relevant = true;
        }
      }
    }
    if (!relevant) return;
    if (state.dirtyRoots.length > 400) state.dirtyRoots = [document.body];
    if (state.dirtyTimer) return;
    state.dirtyTimer = setTimeout(function () {
      state.dirtyTimer = null;
      const roots = state.dirtyRoots;
      state.dirtyRoots = [];
      scanDelta(roots);
    }, 900);
  }

  function scanDelta(roots) {
    if (state.status === NS.STATUS.SCANNING) return;
    const settings = state.settings;
    if (!settings) return;
    const found = [];
    const seen = new Set();
    for (let i = 0; i < roots.length && found.length < 800; i++) {
      let node = roots[i];
      if (!node || !node.isConnected) continue;
      if (node.nodeType === 3) node = node.parentElement;
      if (!node || node.nodeType !== 1) continue;
      if (isOurs(node) || NS.Extractor.isHardSkip(node)) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      let units;
      try { units = NS.Extractor.collect(node, NS.settings.forContent(settings)); } catch (e) { continue; }
      for (let j = 0; j < units.length; j++) {
        const u = units[j];
        if (u.el && state.knownEls.has(u.el)) continue;
        state.seq++;
        u.id = state.seq;
        found.push(u);
      }
    }
    if (!found.length) return;
    const ordered = NS.Extractor.byViewportPriority(found);
    addUnits(ordered);
    if (state.status !== NS.STATUS.TRANSLATING) {
      setStatus(NS.STATUS.TRANSLATING);
      connectAndSend();
    } else if (state.port) {
      sendPending();
    }
    updateProgress(true);
  }

  /* ---------------- 消息接口 ---------------- */
  function report() {
    return {
      ok: true,
      version: NS.VERSION,
      status: state.status,
      total: state.total,
      done: state.total - state.pending.size,
      failed: state.failed,
      cached: state.cached,
      translated: state.nodes.size,
      targetLang: state.settings ? state.settings.targetLang : null,
      displayMode: state.settings ? state.settings.displayMode : null,
      error: state.error
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case NS.MSG.PING:
      case 'wpt:state':
        sendResponse(report());
        return false;
      case NS.MSG.TOGGLE:
        toggle();
        sendResponse(report());
        return false;
      case NS.MSG.START:
        start(msg.overrides || null).catch(function (e) { fail(String((e && e.message) || e)); });
        sendResponse({ ok: true, status: state.status });
        return false;
      case NS.MSG.RESTORE:
        restore();
        sendResponse(report());
        return false;
      case NS.MSG.STOP:
        stopJob();
        sendResponse(report());
        return false;
      default:
        return false;
    }
  });

  state.settings = null;
  NS.Content = {
    start: start,
    restore: restore,
    toggle: toggle,
    stop: stopJob,
    report: report,
    state: state
  };

  /*
   * 自动翻译：动态注册的内容脚本与手动注入都会执行到这里，
   * 因此按全局开关与网站规则判定（「从不翻译」的网站不自动启动，手动翻译不受影响）。
   */
  NS.settings.get().then(function (s) {
    if (U.autoStartFor(s, location.hostname)) start(null, { auto: true });
  }).catch(function () {});
})();
