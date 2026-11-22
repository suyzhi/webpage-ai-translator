/*
 * 内容脚本主编排：抽取 -> 视口优先排序 -> 流式请求 -> 分帧渲染 -> 动态内容增量翻译。
 *
 * 子职责已拆分到同目录模块：
 *   - extract.js      DOM / Shadow DOM 文本抽取与视口排序
 *   - render.js       单节点排版规划、节点创建与裁切计算
 *   - render-queue.js 分帧读写分离渲染队列、裁切复查与重排兜底
 *   - observer.js     MutationObserver 动态监听、流式改写节流与隐藏显现补翻
 *   - toast.js        页面内 Shadow DOM 进度 / 提示浮层
 *   - frames.js       主文档与 iframe / frameset 跨框架协同
 *   - plaintext.js    text/plain 纯文本页分段落与无损恢复
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.Content) return;          // 重复注入时保留既有状态与监听器
  const U = NS.util;
  const nextFrame = NS.RenderQueue.nextFrame;

  /*
   * 子框架（iframe：Cookie 同意框、嵌入内容）：只听顶层页面经后台转发的「开始 / 还原 / 停止」，
   * 不弹提示、不改徽标、不响应弹出面板的状态查询 —— 整个标签页对用户来说仍是「一次翻译」。
   */
  let IS_CHILD = false;
  try { IS_CHILD = typeof window !== 'undefined' && window.top !== window; } catch (e) { IS_CHILD = true; }

  const MEMO_MAX = 6000;
  /* 按需翻译：进入「上 1 屏 / 下 1.5 屏」时触发，一次激活「上 2 屏 ~ 下 2.5 屏」内的全部段落 */
  const NEAR_MARGIN = '100% 0px 150% 0px';
  const ARM_BEHIND = 2;
  const ARM_AHEAD = 2.5;
  /* 短页面一两批就翻完，前后不一致的机会很少，不值得多一次请求：全文 ≥ 8000 字才挑 */
  const GLOSSARY_MIN_CHARS = 8000;

  /** @type {WptContentState} */
  const state = {
    status: NS.STATUS.IDLE,
    settings: null,
    overrides: null,
    byId: new Map(),            // unitId -> unit
    elUnit: new WeakMap(),      // 原文元素 -> unit
    nodeUnit: new WeakMap(),    // 译文节点 -> unit
    nodes: new Map(),           // unitId -> 译文节点
    pending: new Set(),         // 尚未收到结果的片段
    lazy: new Set(),            // 已登记、等待进入视口附近才发送的片段（按需翻译）
    sent: new Set(),            // 已通过当前端口发出的片段
    failedIds: new Set(),
    knownEls: new WeakSet(),
    total: 0,
    cached: 0,
    error: null,
    seq: 0,
    port: null,
    heartbeat: null,
    reconnectTries: 0,
    io: null,
    nearIO: null,
    armTimer: 0,
    starting: false,            // 正在读取设置、尚未进入扫描
    autoRun: false,             // 本次启动由自动翻译触发（找不到内容时不提示）
    announce: false,            // 本轮是否由用户发起（决定是否显示进度 / 完成提示）
    memo: new Map(),            // 原文 -> 译文（null 表示模型原样返回，无需显示）
    memoSig: '',
    usage: { input: 0, output: 0, cached: 0 },   // 本页累计 token 用量（还原后保留：已花出去的就是花了）
    originalTitle: null,
    lastStats: null
  };

  /* 主线程耗时记录（评测用，随 debug 状态上报） */
  const perf = { renderMax: 0, clipMax: 0, collectMax: 0, longTasks: 0 };

  /**
   * @template {(...args: any[]) => any} F
   * @param {'renderMax' | 'clipMax' | 'collectMax'} key
   * @param {F} fn
   * @returns {F}
   */
  function timed(key, fn) {
    return /** @type {any} */ (function () {
      const t = performance.now();
      try { return fn.apply(this, arguments); } finally {
        const d = performance.now() - t;
        if (d > perf[key]) perf[key] = Math.round(d * 10) / 10;
        if (d > 50) perf.longTasks++;
      }
    });
  }

  /**
   * @param {Element} root
   * @param {WptContentConfig} cfg
   */
  function collectTimed(root, cfg) {
    return timed('collectMax', NS.Extractor.collect)(root, cfg);
  }

  const ui = NS.Toast.create(IS_CHILD);
  const plain = NS.PlainText.create(IS_CHILD);

  /** @type {WptObserverApi} */
  const observer = NS.Observer.create({
    getStatus: function () { return state.status; },
    getSettings: function () { return state.settings; },
    hasUnitElement: function (el) { return state.elUnit.has(el); },
    getUnitByElement: function (el) { return state.elUnit.get(el) || null; },
    isKnownElement: function (el) { return state.knownEls.has(el); },
    markKnownElement: function (el) { try { state.knownEls.add(el); } catch (e) {} },
    removeUnit: removeUnit,
    onNodeRemoved: function (n) {
      const u = state.nodeUnit.get(n);
      if (u && !u.dead && state.nodes.get(u.id) === n && (u.reinserts || 0) < 3) {
        u.reinserts = (u.reinserts || 0) + 1;
        state.nodes.delete(u.id);
        u.plan = null;
        renderQueue.push([u.id, n.textContent || '', n]);   // 附带旧节点：若只是被移动而非删除，直接认领
        renderQueue.schedule();
      }
    },
    onNewFrameRoot: function (root) { frames.watch(root); },
    onLazyScroll: function () { if (state.lazy.size) dispatchNear(); },
    collect: collectTimed,
    filterLanguage: filterLanguage,
    onDeltaUnits: function (fresh) {
      const ordered = NS.Extractor.byViewportPriority(fresh);
      addUnits(ordered);
      routeFromMemo(ordered);                                // 备忘命中直接渲染，无需请求
      armNear();                                             // 按需翻译：只激活视口附近的新段落
      dispatch();
    }
  });

  /** @type {WptFramesApi} */
  const frames = NS.Frames.create({
    isChild: IS_CHILD,
    getStatus: function () { return state.status; },
    getOverrides: function () { return state.overrides; },
    getTranslatedCount: function () { return state.nodes.size; },
    getShadowRoots: function () { return observer.getShadowRoots(); },
    waitBodyReady: waitBodyReady,
    onStart: function (overrides) { start(overrides).catch(function () {}); },
    onRestore: function () { if (state.nodes.size || state.status !== NS.STATUS.IDLE) restore(); },
    onStop: function () { if (state.status === NS.STATUS.TRANSLATING || state.status === NS.STATUS.SCANNING) stopJob(); }
  });

  /** @type {WptRenderQueueApi} */
  const renderQueue = NS.RenderQueue.create({
    isChild: IS_CHILD,
    getSettings: function () { return state.settings; },
    getStatus: function () { return state.status; },
    onlyTranslation: onlyTranslation,
    getUnit: function (id) { return state.byId.get(id); },
    getNode: function (id) { return state.nodes.get(id); },
    setNode: function (id, node, u) { state.nodes.set(id, node); state.nodeUnit.set(node, u); },
    deleteNode: function (id) { state.nodes.delete(id); },
    getUnitByNode: function (node) { return state.nodeUnit.get(node) || null; },
    nodeCount: function () { return state.nodes.size; },
    removeLoader: removeLoader,
    unobserveIO: function (el) { if (state.io) { try { state.io.unobserve(el); } catch (e) {} } },
    discardOwnMutations: function () { observer.discardOwn(); },
    onChildRendered: function () { frames.reportStatus(true); },
    onProgress: function () { updateProgress(); },
    timed: timed
  });

  /* ---------------- 状态与基础辅助 ---------------- */

  /** @param {WptStatus} s */
  function setStatus(s) {
    if (state.status === s) return;
    state.status = s;
    if (IS_CHILD) return;
    // 状态变化时轻触后台（同时可重置 Service Worker 的空闲计时器）
    try {
      const p = chrome.runtime.sendMessage({ type: NS.MSG.STATE_CHANGED, status: s });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  /**
   * @param {string} message
   * @param {string} [hint]
   */
  function fail(message, hint) {
    state.error = message;
    setStatus(NS.STATUS.ERROR);
    removeAllLoaders();
    ui.show(message, { kind: 'err', duration: 0, sub: hint || '' });
    stopHeartbeat();
  }

  function onlyTranslation() {
    return !!(state.settings && state.settings.displayMode === 'translation');
  }

  /** @returns {Promise<void>} */
  function waitBodyReady() {
    if (document.body || document.readyState !== 'loading' || typeof document.addEventListener !== 'function') return Promise.resolve();
    return new Promise(function (resolve) {
      let done = false;
      function go() { if (done) return; done = true; clearTimeout(t); document.removeEventListener('DOMContentLoaded', go); resolve(); }
      const t = setTimeout(go, 3000);
      document.addEventListener('DOMContentLoaded', go, { once: true });
    });
  }

  function stopAllObservers() {
    observer.stop();
    if (state.io) { try { state.io.disconnect(); } catch (e) {} state.io = null; }
    if (state.nearIO) { try { state.nearIO.disconnect(); } catch (e) {} state.nearIO = null; }
    if (state.armTimer) { clearTimeout(state.armTimer); state.armTimer = 0; }
  }

  function openSettings() {
    try {
      const p = chrome.runtime.sendMessage({ type: NS.MSG.OPEN_OPTIONS });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 启动 / 续翻 ---------------- */

  /**
   * @param {Partial<WptSettings> | null} [overrides]
   * @param {{ auto?: boolean }} [opts]
   */
  async function start(overrides, opts) {
    const auto = !!(opts && opts.auto);
    // 启动尚未完成又收到启动请求（手动注入时自动翻译与手动翻译会同时触发）：合并为一次，手动优先
    if (state.starting || state.status === NS.STATUS.SCANNING) {
      if (!auto) {
        state.autoRun = false;
        if (state.starting && overrides) state.overrides = overrides;
      }
      return;
    }
    if (state.status === NS.STATUS.TRANSLATING) return;
    state.starting = true;
    state.autoRun = auto;
    state.error = null;
    if (overrides) state.overrides = overrides;

    let settings;
    try {
      settings = await NS.settings.get();
    } catch (e) {
      state.starting = false;
      return fail('扩展上下文已失效，请刷新页面后重试');
    }
    await waitBodyReady();
    state.starting = false;
    settings = Object.assign({}, settings, state.overrides || {});
    state.settings = settings;
    const frameTask = frames.notify('start');
    frames.watch(document);
    if (!state.nodes.size) renderQueue.captureHScroll();
    setStatus(NS.STATUS.SCANNING);
    if (!state.autoRun) ui.show('正在分析页面…', { kind: 'busy', duration: 0, sub: '提取可翻译段落' });

    // 让提示先绘制出来（拿不到帧时由 nextFrame 的定时器兜底，否则会卡在「分析中」）
    await new Promise(function (r) { nextFrame(r, 0); });

    plain.prepare();
    let units;
    try {
      units = collectTimed(plain.root() || document.body, NS.settings.forContent(settings));
    } catch (e) {
      plain.teardown();
      return fail('页面解析失败：' + ((e && e.message) || e));
    }
    observer.observeShadows(units.shadowRoots);
    observer.trackHidden(units.hiddenEls);
    // 续翻（停止后再次开始 / 重试失败段落）：已登记的元素不重复翻译
    units = units.filter(function (u) { return !(u.el && state.knownEls.has(u.el)); });
    units = await filterLanguage(units, settings);
    if (state.status !== NS.STATUS.SCANNING) return;      // 分析期间被停止 / 还原
    resetMemoIfNeeded(settings);

    if (!IS_CHILD && settings.translateTitle && state.originalTitle == null && document.title &&
        U.isTranslatable(U.normalizeText(document.title), NS.settings.forContent(settings), true)) {
      state.originalTitle = document.title;
      units.unshift({ id: 0, el: null, isTitle: true, text: U.normalizeText(document.title), kind: 'partial', anchorNode: null });
    }

    // 失败片段重新排队
    state.failedIds.forEach(function (id) {
      const u = state.byId.get(id);
      if (u && (u.isTitle || (u.el && u.el.isConnected))) state.pending.add(id);
    });
    state.failedIds.clear();

    if (!units.length && !state.pending.size && !state.lazy.size) {
      plain.teardown();
      // 主文档无正文但存在子框架（<frameset> / 嵌入文档 / 邮件正文 iframe）：等子框架上报后再决定状态，不误报「未找到可翻译的内容」
      if (!IS_CHILD && frames.hasCandidates()) {
        await frames.waitForActive(frameTask);
        if (state.status !== NS.STATUS.SCANNING) return;
        if (frames.isActive()) {
          setStatus(NS.STATUS.DONE);
          observer.start();
          if (!state.autoRun) ui.show('翻译完成', { kind: 'ok', sub: '已翻译嵌入框架中的内容', actions: [{ label: '还原', run: restore }] });
          return;
        }
      }
      setStatus(state.nodes.size ? NS.STATUS.DONE : NS.STATUS.IDLE);
      if (state.nodes.size) {
        if (!state.autoRun) ui.show('译文已是最新', { kind: 'ok' });
      } else {
        // 自动翻译时静默结束：已是目标语言的网站不应每次打开都弹出错误提示
        if (!state.autoRun) ui.show('未找到可翻译的内容', { kind: 'err', sub: '页面可能是图片、代码或已是目标语言' });
      }
      return;
    }

    units = NS.Extractor.byViewportPriority(units);
    addUnits(units);
    routeFromMemo(units);
    // 续翻时 IO 可能已随停止而断开：重新观察遗留的待翻译段落，以便显示加载指示
    if (state.io) state.pending.forEach(function (id) {
      const u = state.byId.get(id);
      if (u && u.el) { try { state.io.observe(u.el); } catch (e) {} }
    });
    observeLazy();
    state.announce = true;
    setStatus(NS.STATUS.TRANSLATING);
    frames.reportStatus(true);
    armNear();
    updateProgress(true);
    connectAndSend();
    observer.start();
    if (!state.pending.size) maybeFinish();                // 全部来自备忘，无需请求
  }

  /* ---------------- 跳过已是目标语言的内容 ---------------- */

  /** @param {Element | null} el */
  function explicitLang(el) {
    if (!el || !el.closest) return null;
    const host = el.closest('[lang]');
    // <html>/<body> 以及应用外壳上的 lang 往往反映界面语言而非正文语言，不可信；只采信具体内容块上的标注（如推文正文）
    if (!host || host === document.documentElement || host === document.body) return null;
    if (NS.Extractor && NS.Extractor.isAppShell && NS.Extractor.isAppShell(host)) return null;
    return host.getAttribute('lang') || null;
  }

  /**
   * @param {string} text
   * @param {string} target
   * @returns {Promise<boolean>}
   */
  function detectIsTarget(text, target) {
    return new Promise(function (resolve) {
      try {
        chrome.i18n.detectLanguage(text.slice(0, 800), function (r) {
          if (chrome.runtime.lastError || !r || !r.languages) return resolve(false);
          const top = r.languages[0];
          resolve(!!(r.isReliable && top && top.percentage >= 80 && U.baseLang(top.language) === target));
        });
      } catch (e) { resolve(false); }
    });
  }

  /**
   * @param {WptUnit[]} units
   * @param {WptSettings} settings
   * @returns {Promise<WptUnit[]>}
   */
  async function filterLanguage(units, settings) {
    if (!settings.skipTargetLang || !units.length) return units;
    const target = U.baseLang(settings.targetLang);
    const canDetect = !!(chrome.i18n && typeof chrome.i18n.detectLanguage === 'function');
    const keep = units.map(function () { return true; });
    /** @type {Promise<void>[]} */
    const jobs = [];
    units.forEach(function (u, i) {
      if (u.isTitle || !u.el) return;
      const lang = explicitLang(u.el);
      if (lang) {
        // 仅当文本书写系统与目标语言不矛盾时才采信 lang，防止 <div lang="zh-CN"> 误杀整页英文
        if (U.baseLang(lang) === target && (!U.hasTargetScript || U.hasTargetScript(u.text, settings.targetLang))) keep[i] = false;
        return;
      }
      // 太短的文本识别不可靠（人名、按钮），交给「原样返回不显示」兜底
      if (!canDetect || (u.text.match(/\p{L}/gu) || []).length < 16) return;
      jobs.push(detectIsTarget(u.text, target).then(function (hit) { if (hit) keep[i] = false; }));
    });
    if (jobs.length) await Promise.all(jobs);
    return units.filter(function (u, i) { return keep[i]; });
  }

  /* ---------------- 页面级译文备忘 ---------------- */

  /** @param {WptSettings} settings */
  function resetMemoIfNeeded(settings) {
    const sig = [settings.targetLang, settings.model, settings.baseUrl, settings.customPrompt].join('|');
    if (state.memoSig !== sig) { state.memo.clear(); state.memoSig = sig; }
  }

  /**
   * @param {string} text
   * @param {string | null} translation
   */
  function memoSet(text, translation) {
    if (state.memo.has(text)) state.memo.delete(text);
    state.memo.set(text, translation);
    if (state.memo.size > MEMO_MAX) state.memo.delete(state.memo.keys().next().value);
  }

  /* 备忘命中的单元直接进入渲染队列，不再请求；返回仍需请求的数量 */
  /** @param {WptUnit[]} units */
  function routeFromMemo(units) {
    let hit = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.isTitle || !state.memo.has(u.text)) continue;
      state.pending.delete(u.id);
      unlazy(u);
      const t = state.memo.get(u.text);
      renderQueue.push([u.id, t == null ? u.text : t]);
      hit++;
    }
    if (hit) { renderQueue.schedule(); recount(); }
    return units.length - hit;
  }

  /** @param {WptUnit[]} units */
  function addUnits(units) {
    ensureIO();
    const lazy = !!(state.settings && state.settings.lazyTranslate);
    if (lazy) ensureNearIO();
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      u.id = ++state.seq;               // 页面级统一编号，避免与抽取器内部序号撞号
      state.byId.set(u.id, u);
      if (lazy && u.el) state.lazy.add(u.id);
      else state.pending.add(u.id);
      if (u.el) {
        try { state.knownEls.add(u.el); } catch (e) {}
        state.elUnit.set(u.el, u);
        if (state.io) { try { state.io.observe(u.el); } catch (e) {} }
        if (lazy && state.nearIO) { try { state.nearIO.observe(u.el); } catch (e) {} }
      }
    }
    recount();
  }

  /* 进度与「共 N 段」只统计已激活（已发送或已完成）的段落 */
  function recount() {
    state.total = state.byId.size - state.lazy.size;
  }

  /** @param {WptUnit} u */
  function unlazy(u) {
    if (!state.lazy.delete(u.id)) return;
    if (state.nearIO && u.el) { try { state.nearIO.unobserve(u.el); } catch (e) {} }
  }

  /* ---------------- 按需翻译：视口附近的段落才发送 ---------------- */

  function ensureNearIO() {
    if (state.nearIO || typeof IntersectionObserver !== 'function') return;
    state.nearIO = new IntersectionObserver(onNear, { rootMargin: NEAR_MARGIN });
  }

  function observeLazy() {
    if (!state.lazy.size) return;
    ensureNearIO();
    if (!state.nearIO) return;
    state.lazy.forEach(function (id) {
      const u = state.byId.get(id);
      if (u && u.el) { try { state.nearIO.observe(u.el); } catch (e) {} }
    });
  }

  /** @param {IntersectionObserverEntry[]} entries */
  function onNear(entries) {
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      if (!state.armTimer) state.armTimer = setTimeout(dispatchNear, 120);
      return;
    }
  }

  function dispatchNear() {
    state.armTimer = 0;
    if (state.status !== NS.STATUS.TRANSLATING && state.status !== NS.STATUS.DONE) return;
    armNear();
    dispatch();
  }

  /** @param {Element} el */
  function rectOf(el) {
    let r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      // display:contents 等没有自身盒子的元素：改量其内容
      try { const range = document.createRange(); range.selectNodeContents(el); r = range.getBoundingClientRect(); } catch (e) {}
    }
    return r;
  }

  /* 把视口附近的 lazy 段落转入 pending（只读布局，不写 DOM）；返回激活数量 */
  function armNear() {
    if (!state.lazy.size) return 0;
    if (state.status !== NS.STATUS.TRANSLATING && state.status !== NS.STATUS.DONE) return 0;
    const vh = window.innerHeight || 800;
    const lo = -vh * ARM_BEHIND;
    const hi = vh * ARM_AHEAD;
    /** @type {WptUnit[]} */
    const armed = [];
    state.lazy.forEach(function (id) {
      const u = state.byId.get(id);
      if (!u || u.dead) { state.lazy.delete(id); return; }
      if (!u.el || !u.el.isConnected) return;
      let r;
      try { r = rectOf(u.el); } catch (e) { return; }
      if (!r.width && !r.height) return;                 // 当前未渲染（折叠区域等）
      if (r.bottom >= lo && r.top <= hi) armed.push(u);
    });
    for (let i = 0; i < armed.length; i++) {
      unlazy(armed[i]);
      state.pending.add(armed[i].id);
    }
    if (armed.length) recount();
    return armed.length;
  }

  /* 有未发送的 pending 片段时发出（必要时重新进入「翻译中」并建立连接） */
  function dispatch() {
    let unsent = false;
    state.pending.forEach(function (id) { if (!state.sent.has(id)) unsent = true; });
    if (!unsent) return;
    if (state.status !== NS.STATUS.TRANSLATING) setStatus(NS.STATUS.TRANSLATING);
    if (state.port) sendPending();
    else connectAndSend();
    updateProgress(true);
  }

  /* 让一个单元彻底失效（原文被页面改写 / 重译前） */
  /** @param {WptUnit} u */
  function removeUnit(u) {
    if (!u || u.dead) return;
    u.dead = true;
    const node = state.nodes.get(u.id);
    state.nodes.delete(u.id);
    unlazy(u);
    state.byId.delete(u.id);
    state.pending.delete(u.id);
    state.sent.delete(u.id);
    state.failedIds.delete(u.id);
    removeLoader(u);
    if (u.hidden && NS.Renderer) { NS.Renderer.showOriginal(u.hidden); u.hidden = null; }
    if (node && node.parentNode) node.parentNode.removeChild(node);
    if (u.el) {
      if (state.elUnit.get(u.el) === u) { state.elUnit.delete(u.el); state.knownEls.delete(u.el); }
      if (state.io) { try { state.io.unobserve(u.el); } catch (e) {} }
    }
    recount();
  }

  /* 重试失败段落 */
  function retryFailed() {
    if (!state.failedIds.size) return;
    start(null);
  }

  function pageTerms() {
    if (!state.settings || !state.settings.pageGlossary || state.byId.size < 20) return null;
    /** @type {string[]} */
    const texts = [];
    let chars = 0;
    state.byId.forEach(function (u) { if (u && u.text) { texts.push(u.text); chars += u.text.length; } });
    if (chars < GLOSSARY_MIN_CHARS) return null;
    const t = U.pickTerms(texts, 8, 4);
    return t.length >= 2 ? t.map(function (x) { return { term: x.term, sample: x.sample }; }) : null;
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
    state.sent.clear();                 // 新端口 = 新任务，全部未完成片段都要重新发送
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    startHeartbeat();
    sendPending();
  }

  function sendPending() {
    if (!state.port) return;
    /** @type {Array<{ id: number, text: string }>} */
    const items = [];
    /** @type {number[]} */
    const ids = [];
    // 按视口优先顺序（即 id 顺序）发送
    state.pending.forEach(function (id) {
      if (state.sent.has(id)) return;
      const u = state.byId.get(id);
      if (u && u.text) { items.push({ id: id, text: u.text }); ids.push(id); }
    });
    if (!items.length) return;
    try {
      // 本任务的第一条消息带上整页（含尚未进入视口的段落）的术语候选，后台据此先定译法
      const terms = state.sent.size ? null : pageTerms();
      // incremental：滚动 / 动态内容的后续请求，后台不必再切「小首批」（每个小批都要重复携带系统提示词）
      state.port.postMessage({ type: NS.MSG.START, items: items, overrides: state.overrides, incremental: !state.announce, terms: terms });
      for (let i = 0; i < ids.length; i++) state.sent.add(ids[i]);
    } catch (e) {
      onPortDisconnect();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeat = setInterval(function () {
      try { if (state.port) state.port.postMessage({ type: NS.MSG.PING }); } catch (e) {}
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
    if (state.reconnectTries >= 5) return fail('后台连接中断', '可再次点击「翻译此页面」继续，已完成的译文不会丢失');
    state.reconnectTries++;
    const wait = 400 * state.reconnectTries;
    ui.show('正在恢复连接…', { kind: 'busy', duration: 0, sub: '重试 ' + state.reconnectTries + '/5' });
    setTimeout(function () {
      if (state.status !== NS.STATUS.TRANSLATING || state.port) return;
      if (!state.pending.size) return maybeFinish();
      connectAndSend();
    }, wait);
  }

  /** @param {any} msg */
  function onPortMessage(msg) {
    if (!msg || !msg.type) return;
    state.reconnectTries = 0;
    if (msg.type === NS.MSG.RESULTS) {
      queueRender(msg.entries);
    } else if (msg.type === NS.MSG.USAGE) {
      const u = msg.usage || {};
      state.usage.input += u.input || 0;
      state.usage.output += u.output || 0;
      state.usage.cached += u.cached || 0;
    } else if (msg.type === NS.MSG.DONE) {
      onJobDone(msg);
    } else if (msg.type === NS.MSG.ERROR) {
      state.error = msg.error;
      removeAllLoaders();
      stopHeartbeat();
      // 密钥 / 余额 / 模型名这类要去设置页改的错误：提示里直接给「去设置」，不用自己找入口
      const toSettings = [{ label: '去设置', run: openSettings }];
      if (msg.code === 'NO_KEY') {
        setStatus(NS.STATUS.IDLE);
        ui.show('尚未填写 API 密钥', { kind: 'err', duration: 0, sub: '填入你的 AI 服务密钥后再翻译', actions: toSettings });
      } else {
        setStatus(NS.STATUS.ERROR);
        ui.show(msg.error || '翻译失败', { kind: 'err', duration: 0, sub: msg.hint || '', actions: msg.code === 'FATAL' ? toSettings : [] });
      }
    }
  }

  /** @param {any} msg */
  function onJobDone(msg) {
    const stats = msg.stats || {};
    state.cached += stats.cached || 0;
    state.lastStats = stats;
    const failed = msg.failedIds || [];
    for (let i = 0; i < failed.length; i++) {
      const id = failed[i];
      if (!state.pending.has(id)) continue;
      state.pending.delete(id);
      state.sent.delete(id);
      state.failedIds.add(id);
      const u = state.byId.get(id);
      if (u) removeLoader(u);
    }
    maybeFinish();
  }

  /* 全部片段都有了结果（成功或失败）才算完成；另一个增量任务仍在跑时保持「翻译中」 */
  function maybeFinish() {
    if (state.status !== NS.STATUS.TRANSLATING) return;
    if (state.pending.size) {
      // 兜底：存在尚未发出的片段（例如端口曾短暂不可用）则补发
      if (state.port) sendPending();
      return updateProgress(true);
    }
    setStatus(NS.STATUS.DONE);
    frames.reportStatus(true);
    stopHeartbeat();
    renderQueue.scheduleRelayout();
    // 增量翻译（滚动加载、实时更新）静默完成，只有用户发起的翻译才提示
    if (!state.announce) return;
    state.announce = false;
    const stats = state.lastStats || {};
    const failedTotal = state.failedIds.size;
    if (failedTotal > 0) {
      ui.show('翻译完成，' + failedTotal + ' 段失败', {
        kind: 'err', duration: 0,
        sub: state.error || '网络或限流导致，可重试失败段落',
        actions: [{ label: '重试', run: retryFailed }]
      });
    } else {
      const secs = stats.elapsedMs ? (stats.elapsedMs / 1000).toFixed(1) + 's' : '';
      const cached = state.cached ? ' · 缓存 ' + state.cached + ' 段' : '';
      const lazy = state.lazy.size ? ' · 其余内容滚动到时再翻译' : '';
      ui.show('翻译完成', {
        kind: 'ok',
        sub: ('共 ' + state.total + ' 段' + cached + (secs ? ' · ' + secs : '') + lazy).trim(),
        actions: [{ label: '还原', run: restore }]
      });
    }
  }

  /** @param {Array<[number, string]>} entries */
  function queueRender(entries) {
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i][0];
      const text = entries[i][1];
      state.pending.delete(id);
      renderQueue.push(entries[i]);
      const u = state.byId.get(id);
      if (u && !u.isTitle) memoSet(u.text, U.sameText(text, u.text) ? null : text);
    }
    renderQueue.schedule();
    updateProgress();
  }

  let lastProgressAt = 0;
  /** @param {boolean} [force] */
  function updateProgress(force) {
    const now = Date.now();
    if (!force && now - lastProgressAt < 150) return;
    lastProgressAt = now;
    if (state.status !== NS.STATUS.TRANSLATING || !state.announce) return;
    const total = state.total || 1;
    const done = state.total - state.pending.size;
    ui.show('正在翻译 ' + done + ' / ' + state.total, {
      kind: 'busy', duration: 0, progress: done / total,
      sub: state.cached ? '缓存命中 ' + state.cached + ' 段' : '',
      actions: [{ label: '停止', run: stopJob }]
    });
  }

  /* ---------------- 加载指示（仅对进入视口的待翻译段落） ---------------- */

  function ensureIO() {
    if (state.io || typeof IntersectionObserver !== 'function') return;
    state.io = new IntersectionObserver(onIntersect, { rootMargin: '160px 0px' });
  }

  /** @param {IntersectionObserverEntry[]} entries */
  function onIntersect(entries) {
    const R = NS.Renderer;
    if (!R) return;
    /** @type {WptUnit[]} */
    const need = [];
    for (let i = 0; i < entries.length; i++) {
      const u = state.elUnit.get(entries[i].target);
      if (!u || u.dead) continue;
      u.visible = entries[i].isIntersecting;
      if (u.visible && !u.loader && state.pending.has(u.id) && state.status === NS.STATUS.TRANSLATING) need.push(u);
    }
    if (!need.length) return;
    const only = onlyTranslation();
    const plans = need.map(function (u) { return u.plan || (u.plan = R.plan(u, only)); });   // 先读
    for (let i = 0; i < need.length; i++) {                                                  // 再写
      const loader = R.createLoader();
      if (R.insertLoader(loader, need[i], plans[i])) need[i].loader = loader;
    }
    observer.discardOwn();
  }

  /** @param {WptUnit | null | undefined} u */
  function removeLoader(u) {
    if (u && u.loader) {
      if (u.loader.parentNode) u.loader.parentNode.removeChild(u.loader);
      u.loader = null;
    }
  }

  function removeAllLoaders() {
    state.byId.forEach(removeLoader);
    observer.discardOwn();
  }

  /* ---------------- 还原 / 停止 ---------------- */

  function restore() {
    frames.notify('restore');
    stopAllObservers();
    disconnectPort();
    let removed = 0;
    const hadFrames = frames.reset();
    const hadPlain = plain.teardown();
    state.nodes.forEach(function (node) {
      if (node && node.parentNode) { node.parentNode.removeChild(node); removed++; }
    });
    state.byId.forEach(function (u) {
      removeLoader(u);
      if (u.hidden && NS.Renderer) { NS.Renderer.showOriginal(u.hidden); u.hidden = null; }
    });
    state.nodes.clear();
    renderQueue.reset();
    observer.reset();
    if (state.originalTitle != null) { try { document.title = state.originalTitle; } catch (e) {} }
    state.originalTitle = null;
    state.byId.clear();
    state.elUnit = new WeakMap();
    state.nodeUnit = new WeakMap();
    state.pending.clear();
    state.lazy.clear();
    state.sent.clear();
    state.failedIds.clear();
    state.knownEls = new WeakSet();
    state.total = 0; state.cached = 0; state.lastStats = null;
    state.error = null;
    state.reconnectTries = 0;
    state.overrides = null;
    state.announce = false;             // 备忘保留：还原后再次翻译可瞬间完成
    setStatus(NS.STATUS.IDLE);
    if (removed || hadPlain || hadFrames) ui.show('已还原原文', { kind: 'ok', duration: 1800 });
    else ui.hide();
  }

  function stopJob() {
    frames.notify('stop');
    if (state.port) { try { state.port.postMessage({ type: NS.MSG.STOP }); } catch (e) {} }
    disconnectPort();
    stopAllObservers();
    removeAllLoaders();
    state.sent.clear();
    state.announce = false;
    setStatus(NS.STATUS.IDLE);
    ui.show('已停止翻译', { kind: 'ok', sub: '已完成的译文会保留', actions: state.nodes.size ? [{ label: '还原', run: restore }] : [] });
  }

  /* 快捷键 / 右键菜单：开 <-> 关。翻译进行中也直接还原（restore 会断开端口，后台随即中止在途请求） */
  function toggle() {
    if (state.status === NS.STATUS.TRANSLATING || state.status === NS.STATUS.SCANNING ||
        state.nodes.size || frames.hasAny() || state.status === NS.STATUS.DONE) return restore();
    return start(null);
  }

  /* ---------------- 消息接口 ---------------- */

  function report() {
    return {
      ok: true,
      version: NS.VERSION,
      status: state.status,
      total: state.total,
      done: state.total - state.pending.size,
      failed: state.failedIds.size,
      cached: state.cached,
      dropped: renderQueue.dropped(),
      translated: state.nodes.size + frames.translatedCount(),
      targetLang: state.settings ? state.settings.targetLang : null,
      displayMode: state.settings ? state.settings.displayMode : null,
      error: state.error,
      usage: state.usage
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    if (frames.handleMessage(msg)) return false;
    if (IS_CHILD && !(msg.type === NS.MSG.STATE && msg.child)) return false;   // 状态查询、开关等只由顶层页面应答（调试可指定子框架）
    switch (msg.type) {
      case NS.MSG.PING:
      case NS.MSG.STATE:
        sendResponse(msg.debug ? Object.assign(report(), { dropLog: renderQueue.dropLog(), perf: perf }) : report());
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

  NS.Content = {
    start: start,
    restore: restore,
    toggle: toggle,
    stop: stopJob,
    retryFailed: retryFailed,
    report: report,
    state: state
  };

  /*
   * 自动翻译：动态注册的内容脚本与手动注入都会执行到这里，
   * 因此按全局开关与网站规则判定（「从不翻译」的网站不自动启动，手动翻译不受影响）。
   */
  NS.settings.get().then(async function (s) {
    if (IS_CHILD || !U.autoStartFor(s, location.hostname)) return;
    // 整页已是目标语言（全站自动翻译时打开的中文网页）：不请求、不弹提示；手动翻译不受影响
    if (s.skipTargetLang && await pageIsTarget(s.targetLang)) return;
    start(null, { auto: true });
  }).catch(function () {});

  /** @param {string} targetLang */
  async function pageIsTarget(targetLang) {
    // 优先取主内容区（避免中文化导航栏 / 侧边栏误判英文正文页）；超长页首中尾均衡采样
    const main = document.querySelector && document.querySelector('main, article, [role="main"]');
    let raw = main && (/** @type {HTMLElement} */ (main).innerText || '').trim().length >= 200
      ? /** @type {HTMLElement} */ (main).innerText
      : (document.body && document.body.innerText || '');
    if (raw.length > 3600) {
      const mid = Math.floor(raw.length / 2);
      raw = raw.slice(0, 1200) + '\n' + raw.slice(mid, mid + 1200) + '\n' + raw.slice(-1200);
    }
    const sample = U.normalizeText(raw.slice(0, 3600));
    if (sample.length < 40) return false;
    if (chrome.i18n && typeof chrome.i18n.detectLanguage === 'function') return detectIsTarget(sample, U.baseLang(targetLang));
    return U.isProbablyTargetLang(sample, targetLang);
  }
})();
