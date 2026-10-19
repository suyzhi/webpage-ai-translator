/*
 * 内容脚本主编排：抽取 -> 视口优先排序 -> 流式请求 -> 分帧渲染 -> 动态内容增量翻译。
 *
 * 可靠性设计：
 *   - Service Worker 可能在长任务中被回收：端口断开后自动重连并补发未完成片段；
 *   - 每个片段只发送一次（sent 集合），动态新增内容只追加增量，不会让后台中止在途请求重来；
 *   - 失败片段单独记录，可「重试失败段落」而不必整页重翻；
 *   - 渲染分帧 + 读写分离：每帧先批量读样式、再批量写 DOM，单帧预算约 10ms，大页面不卡顿；
 *   - MutationObserver 处理 SPA / 无限滚动：新增内容增量翻译；原文文本被框架改写时自动重译；
 *     译文被框架重渲染抹掉时自动补回；自己造成的变更通过 takeRecords() 丢弃，不会自激。
 *   - 增量翻译静默进行：只有用户主动发起的翻译才显示进度与「翻译完成」提示，
 *     社交媒体这类持续变化的页面不会反复弹窗；
 *   - 页面级译文备忘（memo）：虚拟列表把同一条内容移出再移入时直接复用译文，不再请求；
 *   - 跳过无需翻译的内容：元素自带 lang 属性 / 浏览器内置语言识别判定已是目标语言的段落不发送；
 *     模型原样返回的内容（人名、品牌、代码）不渲染，避免「Phyrex Phyrex」式重复。
 *   - 按需翻译（lazyTranslate）：段落先登记为 lazy，只有进入视口附近才转入 pending 发送；
 *     按「一屏左右」成块激活，避免逐段小请求反复携带系统提示词。
 *   - 原文频繁变化（流式输出、计时器、实时计数）时，等文本稳定后再翻译一次，
 *     而不是每次变动都重译一遍。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Content) { return; }          // 重复注入时保留既有状态与监听器
  const U = NS.util;
  const R = NS.Renderer;

  /*
   * 子框架（iframe：Cookie 同意框、嵌入内容）：只听顶层页面经后台转发的「开始 / 还原 / 停止」，
   * 不弹提示、不改徽标、不响应弹出面板的状态查询 —— 整个标签页对用户来说仍是「一次翻译」。
   */
  let IS_CHILD = false;
  try { IS_CHILD = window.top !== window; } catch (e) { IS_CHILD = true; }

  const FRAME_BUDGET_MS = 10;
  const SLICE = 40;

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
    total: 0, cached: 0,
    dropped: 0,                 // 放不下而撤掉的译文数（评测用：撤得越多问题率越低，必须一起看）
    dropLog: [],                // 撤掉的前若干条（原因、原文），调试用
    titled: [],                 // [元素, 译文]：撤掉的译文改挂在悬停提示上，还原时摘掉
    hScroll0: false, relayouts: 0, relayoutTimer: 0,   // 翻译前是否已有横向滚动；补发 resize 的次数
    error: null,
    seq: 0,
    port: null,
    heartbeat: null,
    reconnectTries: 0,
    renderQueue: [],
    rafId: 0,                   // 待执行渲染的取消函数（nextFrame 返回）
    observer: null,
    shadowRoots: new Set(),     // 抽取时途经的影子根：document 上的观察者看不到其内部变化，需逐个观察
    clipCheck: [],              // 刚插入的块级译文：下一帧检查是否被容器裁切
    clipTimer: 0,
    io: null,
    nearIO: null,
    armTimer: 0,
    churn: new WeakMap(),       // 原文元素 -> { last, text, timer }：原文被改写的节奏
    dirtyRoots: [],
    dirtyTimer: null,
    deltaChain: Promise.resolve(),
    announce: false,            // 本轮是否由用户发起（决定是否显示进度 / 完成提示）
    memo: new Map(),            // 原文 -> 译文（null 表示模型原样返回，无需显示）
    memoSig: '',
    usage: { input: 0, output: 0, cached: 0 },   // 本页累计 token 用量（还原后保留：已花出去的就是花了）
    originalTitle: null
  };

  const MEMO_MAX = 6000;
  /* 按需翻译：进入「上 1 屏 / 下 1.5 屏」时触发，一次激活「上 2 屏 ~ 下 2.5 屏」内的全部段落 */
  const NEAR_MARGIN = '100% 0px 150% 0px';
  const ARM_BEHIND = 2;
  const ARM_AHEAD = 2.5;
  /* 原文连续改写的间隔小于该值视为「仍在变化」，等稳定后再翻译 */
  const SETTLE_MS = 2500;

  /* ---------------- 页面内提示（Shadow DOM，与页面样式互不干扰） ---------------- */
  const ui = IS_CHILD ? { show: function () {}, hide: function () {} } : (function () {
    let host = null, root = null, box = null, hideTimer = null, removeTimer = null;
    let els = {};

    const STYLE =
      ':host{all:initial}' +
      '.box{--fg:#111827;--sub:#6b7280;--bg:rgba(255,255,255,.9);--line:rgba(15,23,42,.08);--track:rgba(15,23,42,.08);' +
      '--accent:#6366f1;--ok:#10b981;--err:#ef4444;--btn:rgba(15,23,42,.05);--btn-h:rgba(15,23,42,.1);' +
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
      'color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:14px;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 32px -8px rgba(0,0,0,.22);' +
      '-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);' +
      'min-width:220px;max-width:340px;overflow:hidden;pointer-events:auto;' +
      'opacity:0;transform:translateY(10px) scale(.98);transform-origin:100% 100%;' +
      'transition:opacity .22s ease,transform .32s cubic-bezier(.2,.8,.2,1)}' +
      '@media (prefers-color-scheme:dark){.box{--fg:#f3f4f6;--sub:#9ca3af;--bg:rgba(24,24,27,.88);--line:rgba(255,255,255,.1);' +
      '--track:rgba(255,255,255,.12);--accent:#818cf8;--ok:#34d399;--err:#f87171;--btn:rgba(255,255,255,.08);--btn-h:rgba(255,255,255,.16)}}' +
      '.box.show{opacity:1;transform:none}' +
      '.main{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px}' +
      '.ic{width:16px;height:16px;flex:0 0 auto;position:relative}' +
      '.ic.busy{border-radius:50%;border:2px solid var(--track);border-top-color:var(--accent);box-sizing:border-box;animation:spin .8s linear infinite}' +
      '.ic.ok::before,.ic.err::before{content:"";position:absolute;inset:0;border-radius:50%;background:var(--ok)}' +
      '.ic.err::before{background:var(--err)}' +
      '.ic.ok::after{content:"";position:absolute;left:5px;top:3px;width:4px;height:7px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}' +
      '.ic.err::after{content:"!";position:absolute;inset:0;color:#fff;font:700 11px/16px sans-serif;text-align:center}' +
      '.txt{flex:1;min-width:0}' +
      '.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}' +
      '.sub{color:var(--sub);font-size:11.5px;margin-top:1px}.sub:empty{display:none}' +
      '.acts{display:flex;gap:4px;flex:0 0 auto}' +
      'button{all:unset;cursor:pointer;font:600 12px/1 inherit;font-family:inherit;color:var(--fg);background:var(--btn);' +
      'padding:6px 9px;border-radius:8px;transition:background .15s}' +
      'button:hover{background:var(--btn-h)}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
      'button.x{color:var(--sub);background:transparent;padding:6px 7px}' +
      '.bar{height:2px;background:var(--track)}.bar[hidden]{display:none}' +
      '.bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .35s cubic-bezier(.2,.8,.2,1)}' +
      '@keyframes spin{to{transform:rotate(360deg)}}' +
      '@media (prefers-reduced-motion:reduce){.box,.bar i{transition:none}.ic.busy{animation-duration:2.4s}}';

    function ensure() {
      clearTimeout(removeTimer);
      if (host && host.isConnected) return;
      host = document.createElement('wpt-ui');
      host.setAttribute('data-wpt', '1');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:16px;bottom:16px;pointer-events:none;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>' + STYLE + '</style>' +
        '<div class="box" role="status" aria-live="polite"><div class="main"><span class="ic"></span>' +
        '<div class="txt"><div class="t"></div><div class="sub"></div></div><div class="acts"></div>' +
        '<button class="x" title="关闭" aria-label="关闭">✕</button></div><div class="bar"><i></i></div></div>';
      box = root.querySelector('.box');
      els = {
        ic: root.querySelector('.ic'), t: root.querySelector('.t'), sub: root.querySelector('.sub'),
        acts: root.querySelector('.acts'), bar: root.querySelector('.bar'), x: root.querySelector('.x')
      };
      els.x.addEventListener('click', hide);
      document.documentElement.appendChild(host);
      void box.offsetWidth;   // 保证首次出现也有过渡
    }

    function show(msg, opts) {
      const o = opts || {};
      ensure();
      clearTimeout(hideTimer);
      els.t.textContent = msg;
      els.sub.textContent = o.sub || '';
      els.ic.className = 'ic' + (o.kind ? ' ' + o.kind : '');
      if (o.progress != null) {
        els.bar.hidden = false;
        els.bar.firstChild.style.width = Math.round(Math.max(0.02, o.progress) * 100) + '%';
      } else {
        els.bar.hidden = true;
      }
      const acts = o.actions || [];
      const sig = acts.map(function (a) { return a.label; }).join('|');
      if (els.acts.getAttribute('data-sig') !== sig) {
        els.acts.textContent = '';
        els.acts.setAttribute('data-sig', sig);
        acts.forEach(function (a) {
          const b = document.createElement('button');
          b.textContent = a.label;
          b.addEventListener('click', function () { a.run(); });
          els.acts.appendChild(b);
        });
      }
      box.classList.add('show');
      if (o.duration !== 0) {
        // 成功提示尽量不打扰（还原随时可用快捷键 / 弹出面板），错误提示留足阅读时间
        hideTimer = setTimeout(hide, o.duration || (o.kind === 'err' ? 8000 : 1600));
      }
    }

    function hide() {
      if (!box) return;
      clearTimeout(hideTimer);
      box.classList.remove('show');
      removeTimer = setTimeout(function () {
        if (host && host.parentNode && !box.classList.contains('show')) { host.parentNode.removeChild(host); host = null; root = null; box = null; }
      }, 360);
    }

    return { show: show, hide: hide };
  })();

  function setStatus(s) {
    if (state.status === s) return;
    state.status = s;
    if (IS_CHILD) return;
    // 状态变化时轻触后台（同时可重置 Service Worker 的空闲计时器）
    try {
      const p = chrome.runtime.sendMessage({ type: 'wpt:state-changed', status: s });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

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

  /* ---------------- 启动 / 续翻 ---------------- */
  async function start(overrides) {
    if (state.status === NS.STATUS.SCANNING || state.status === NS.STATUS.TRANSLATING) return;
    state.error = null;
    if (overrides) state.overrides = overrides;

    let settings;
    try {
      settings = await NS.settings.get();
    } catch (e) {
      return fail('扩展上下文已失效，请刷新页面后重试');
    }
    settings = Object.assign({}, settings, state.overrides || {});
    state.settings = settings;
    notifyFrames('start');
    watchFrames(document);
    if (!state.nodes.size) state.hScroll0 = hasHScroll();
    setStatus(NS.STATUS.SCANNING);
    ui.show('正在分析页面…', { kind: 'busy', duration: 0, sub: '提取可翻译段落' });

    // 让提示先绘制出来（拿不到帧时由 nextFrame 的定时器兜底，否则会卡在「分析中」）
    await new Promise(function (r) { nextFrame(r, 0); });

    let units;
    try {
      units = timed('collectMax', NS.Extractor.collect)(document.body, NS.settings.forContent(settings));
    } catch (e) {
      return fail('页面解析失败：' + ((e && e.message) || e));
    }
    observeShadows(units.shadowRoots);
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
      setStatus(state.nodes.size ? NS.STATUS.DONE : NS.STATUS.IDLE);
      if (state.nodes.size) ui.show('译文已是最新', { kind: 'ok' });
      else ui.show('未找到可翻译的内容', { kind: 'err', sub: '页面可能是图片、代码或已是目标语言' });
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
    armNear();
    updateProgress(true);
    connectAndSend();
    startObserving();
    if (!state.pending.size) maybeFinish();                // 全部来自备忘，无需请求
  }

  /* ---------------- 跳过已是目标语言的内容 ---------------- */
  function explicitLang(el) {
    if (!el || !el.closest) return null;
    const host = el.closest('[lang]');
    // <html>/<body> 上的 lang 常常是站点模板默认值，不可信；只采信具体元素上的标注（如推文正文）
    if (!host || host === document.documentElement || host === document.body) return null;
    return host.getAttribute('lang') || null;
  }

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

  async function filterLanguage(units, settings) {
    if (!settings.skipTargetLang || !units.length) return units;
    const target = U.baseLang(settings.targetLang);
    const canDetect = !!(chrome.i18n && typeof chrome.i18n.detectLanguage === 'function');
    const keep = units.map(function () { return true; });
    const jobs = [];
    units.forEach(function (u, i) {
      if (u.isTitle || !u.el) return;
      const lang = explicitLang(u.el);
      if (lang) { if (U.baseLang(lang) === target) keep[i] = false; return; }
      // 太短的文本识别不可靠（人名、按钮），交给「原样返回不显示」兜底
      if (!canDetect || (u.text.match(/\p{L}/gu) || []).length < 16) return;
      jobs.push(detectIsTarget(u.text, target).then(function (hit) { if (hit) keep[i] = false; }));
    });
    if (jobs.length) await Promise.all(jobs);
    return units.filter(function (u, i) { return keep[i]; });
  }

  /* ---------------- 页面级译文备忘 ---------------- */
  function resetMemoIfNeeded(settings) {
    const sig = [settings.targetLang, settings.model, settings.baseUrl, settings.customPrompt].join('|');
    if (state.memoSig !== sig) { state.memo.clear(); state.memoSig = sig; }
  }

  function memoSet(text, translation) {
    if (state.memo.has(text)) state.memo.delete(text);
    state.memo.set(text, translation);
    if (state.memo.size > MEMO_MAX) state.memo.delete(state.memo.keys().next().value);
  }

  /* 备忘命中的单元直接进入渲染队列，不再请求；返回仍需请求的数量 */
  function routeFromMemo(units) {
    let hit = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.isTitle || !state.memo.has(u.text)) continue;
      state.pending.delete(u.id);
      unlazy(u);
      const t = state.memo.get(u.text);
      state.renderQueue.push([u.id, t == null ? u.text : t]);
      hit++;
    }
    if (hit) { scheduleRender(); recount(); }
    return units.length - hit;
  }

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
    if (u.hidden) { R.showOriginal(u.hidden); u.hidden = null; }
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

  /* 短页面一两批就翻完，前后不一致的机会很少，不值得多一次请求：全文 ≥ 8000 字才挑 */
  const GLOSSARY_MIN_CHARS = 8000;
  function pageTerms() {
    if (!state.settings || !state.settings.pageGlossary || state.byId.size < 20) return null;
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
    const items = [];
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
    stopHeartbeat();
    scheduleRelayout();
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

  /* ---------------- 渲染（分帧 + 读写分离） ---------------- */
  function queueRender(entries) {
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i][0];
      const text = entries[i][1];
      state.pending.delete(id);
      state.renderQueue.push(entries[i]);
      const u = state.byId.get(id);
      if (u && !u.isTitle) memoSet(u.text, U.sameText(text, u.text) ? null : text);
    }
    scheduleRender();
    updateProgress();
  }

  /*
   * 下一帧执行。拿不到帧时（后台标签页暂停 rAF；滚出视口的 iframe 也不触发 rAF）由定时器兜底：
   * 隐藏页面直接用 hiddenDelay，可见页面 100 ms 内没等到帧也照常执行。返回取消函数。
   */
  function nextFrame(fn, hiddenDelay) {
    let done = false, raf = 0, timer = 0;
    function run() {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
      fn();
    }
    if (document.hidden) timer = setTimeout(run, hiddenDelay || 0);
    else { raf = requestAnimationFrame(run); timer = setTimeout(run, 100); }
    return function () { done = true; if (raf) cancelAnimationFrame(raf); clearTimeout(timer); };
  }

  function scheduleRender() {
    if (state.rafId || !state.renderQueue.length) return;
    state.rafId = nextFrame(flushRender, 0);            // 存的是取消函数
  }

  /*
   * 主线程耗时记录（评测用，随 debug 状态上报）：渲染、裁切复查、抽取各自的单次最大值，
   * 以及超过 50 ms（长任务阈值，会让页面卡一下）的次数。
   */
  const perf = { renderMax: 0, clipMax: 0, collectMax: 0, longTasks: 0 };
  function timed(key, fn) {
    return function () {
      const t = performance.now();
      try { return fn.apply(this, arguments); } finally {
        const d = performance.now() - t;
        if (d > perf[key]) perf[key] = Math.round(d * 10) / 10;
        if (d > 50) perf.longTasks++;
      }
    };
  }

  const flushRender = timed('renderMax', flushRenderNow);
  function flushRenderNow() {
    state.rafId = 0;
    if (!state.renderQueue.length || !state.settings) return;
    const settings = state.settings;
    const only = onlyTranslation();
    const animate = settings.animations && !R.reducedMotion();
    const budget = document.hidden ? Infinity : FRAME_BUDGET_MS;
    const t0 = performance.now();
    let stagger = 0;

    while (state.renderQueue.length && performance.now() - t0 < budget) {
      const slice = state.renderQueue.splice(0, SLICE);
      // 读阶段：规划位置、创建（未挂载的）译文节点 —— 只读样式，不触发重排
      const jobs = [];
      for (let i = 0; i < slice.length; i++) {
        const id = slice[i][0];
        const text = slice[i][1];
        const u = state.byId.get(id);
        if (!u || u.dead) continue;
        if (u.isTitle) {
          if (settings.translateTitle && text) document.title = text;
          continue;
        }
        const existing = state.nodes.get(u.id) || adoptStray(u, slice[i][2]);
        if (existing && existing.isConnected) {
          state.nodes.set(u.id, existing);
          if (existing.textContent !== text) existing.textContent = text;
          continue;
        }
        if (!u.el || !u.el.isConnected) { removeLoader(u); continue; }
        // 模型原样返回（人名、品牌、代码等）：不重复显示
        if (U.sameText(text, u.text)) {
          u.same = true;
          removeLoader(u);
          if (state.io) { try { state.io.unobserve(u.el); } catch (e) {} }
          continue;
        }
        const plan = u.plan || (u.plan = R.plan(u, only));
        jobs.push({ u: u, node: R.create(u.el, text, settings, plan), plan: plan });
      }
      // 写阶段
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        removeLoader(j.u);
        const mode = R.insert(j.node, j.u, j.plan);
        if (!mode) continue;
        state.nodes.set(j.u.id, j.node);
        state.nodeUnit.set(j.node, j.u);
        if (only && !j.u.hidden) j.u.hidden = R.hideOriginal(j.u, j.node);
        if (animate && j.u.visible) R.animate(j.node, Math.min(stagger++ * 45, 360));
        if (state.io && j.u.el) { try { state.io.unobserve(j.u.el); } catch (e) {} }
        if (!only) state.clipCheck.push(j.node);
      }
    }
    discardOwnMutations();
    scheduleClipCheck();
    scheduleRender();
    updateProgress();
  }

  /*
   * 被裁切兜底：固定高度 + overflow 的容器里（横向导航条、限高卡片），块级译文会被截掉，
   * 只剩「Schlagz 是一段」这样的碎片。渲染后的下一帧统一检查（先全部读、再全部写），
   * 被裁切的改为行内追加在原文之后。
   */
  function scheduleClipCheck() {
    if (state.clipTimer || !state.clipCheck.length) return;
    state.clipTimer = nextFrame(checkClipped, 50);
  }

  /* 撤掉的译文不丢：挂到原文的悬停提示上（不占位置；原文或其外层已有提示的不覆盖） */
  function noteDrop(u, why, text) {
    state.dropped++;
    if (state.dropLog.length < 40) state.dropLog.push(why + ': ' + String(u.text || '').slice(0, 40));
    const el = u.el;
    if (!el || !text || !el.closest || el.closest('[title]')) return;
    el.setAttribute('title', text);
    state.titled.push([el, text]);
  }

  const checkClipped = timed('clipMax', checkClippedNow);
  function checkClippedNow() {
    state.clipTimer = 0;
    const list = state.clipCheck;
    state.clipCheck = [];
    if (!state.settings || onlyTranslation()) return;
    const fix = [];
    const drop = [];
    const realign = [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const u = node.isConnected ? state.nodeUnit.get(node) : null;
      if (!u || u.dead || !u.el) continue;
      // 入场动画（上浮 + 位移）期间矩形带着 transform，会被误判为溢出：动画结束后再查
      const anims = typeof node.getAnimations === 'function' ? node.getAnimations() : [];
      if (anims.length) {
        Promise.all(anims.map(function (a) { return a.finished; })).catch(function () {}).then(function () {
          state.clipCheck.push(node);
          scheduleClipCheck();
        });
        continue;
      }
      if (u.plan && u.plan.nav) {
        // 导航条里的行内译文放不下：直接撤掉，不再尝试别的位置
        if (R.navMisfit(node, u.el)) drop.push([u, node, 'nav']);
        continue;
      }
      if (u.plan && u.plan.mode === 'inline' && !u.clipFallback) {
        // 行内译文撑出定高标题 / 侧栏条目：标题类移到其后单独成行，链接按钮里的撤掉
        const ibox = R.clipBox(node, u.el);
        const p = ibox ? R.afterClipPlan(u, ibox, true) : null;
        if (p) fix.push([u, node, p]);
        else if (ibox) drop.push([u, node, 'inline']);
        continue;
      }
      const box = R.clipBox(node, u.el);
      // 长段落改行内也放不下：优先移到定高容器之后（同样在读阶段算好位置）
      if (box) fix.push([u, node, u.clipFallback ? null : R.afterClipPlan(u, box)]);
      else if (node.style.display === 'block' && R.centeredMisfit(node, u.el)) realign.push(node);
    }
    for (let i = 0; i < realign.length; i++) realign[i].style.textAlign = 'start';
    for (let i = 0; i < drop.length; i++) {
      drop[i][1].remove();
      state.nodes.delete(drop[i][0].id);
      noteDrop(drop[i][0], drop[i][2], drop[i][1].textContent);
    }
    for (let i = 0; i < fix.length; i++) {
      const u = fix[i][0];
      const node = fix[i][1];
      node.remove();
      if (u.clipFallback) {
        // 改成行内后仍被截（容器太窄、换行后超出）：宁可不显示，也不留半截碎片
        state.nodes.delete(u.id);
        noteDrop(u, 'fallback', node.textContent);
        continue;
      }
      const plan = fix[i][2] || { mode: 'inline', target: u.el, typo: null, only: false };
      const repl = R.create(u.el, node.textContent, state.settings, plan);
      if (!R.insert(repl, u, plan)) continue;
      u.plan = plan;
      u.clipFallback = true;
      state.nodes.set(u.id, repl);
      state.nodeUnit.set(repl, u);
      state.clipCheck.push(repl);                  // 再查一次
    }
    discardOwnMutations();
    scheduleClipCheck();
    scheduleRelayout();
  }

  /*
   * 页面脚本按加载时的高度排好的布局（瀑布流 / masonry：定高的纵向换行 flex），
   * 加了译文之后内容变高、多出一列，整页出现横向滚动条。这类脚本都监听 resize：
   * 翻译前没有横向滚动、翻译后出现了，就补发一次 resize 让页面自己重新排版。
   * 流式翻译会分很多次落地：翻译中等安静 1 s 再发，完成时再查一次；每页最多 5 次。
   */
  function hasHScroll() {
    const d = document.documentElement;
    return !!d && d.scrollWidth > window.innerWidth + 1;
  }

  function scheduleRelayout() {
    if (state.hScroll0 || state.relayouts >= 5) return;
    clearTimeout(state.relayoutTimer);
    const wait = state.status === NS.STATUS.TRANSLATING ? 1000 : 300;
    state.relayoutTimer = setTimeout(function () {
      if (!state.nodes.size || !hasHScroll()) return;
      state.relayouts++;
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }, wait);
  }

  /*
   * 防重复：框架有时会把我们的译文节点「移走再放回」（先触发删除记录），
   * 此时不应再插一份；优先认领仍在页面上、且属于该单元的旧节点。
   */
  function adoptStray(u, hint) {
    if (hint && hint.isConnected) return hint;
    if (!u.el || !u.el.querySelectorAll) return null;
    const found = u.el.querySelectorAll('.wpt-translation');
    let keep = null;
    for (let i = 0; i < found.length; i++) {
      if (state.nodeUnit.get(found[i]) !== u) continue;
      if (!keep) keep = found[i];
      else found[i].parentNode.removeChild(found[i]);      // 多余的副本直接清掉
    }
    return keep;
  }

  function updateProgress(force) {
    const now = Date.now();
    if (!force && now - (updateProgress.last || 0) < 150) return;
    updateProgress.last = now;
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

  function onIntersect(entries) {
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
    discardOwnMutations();
  }

  function removeLoader(u) {
    if (u && u.loader) {
      if (u.loader.parentNode) u.loader.parentNode.removeChild(u.loader);
      u.loader = null;
    }
  }

  function removeAllLoaders() {
    state.byId.forEach(removeLoader);
    discardOwnMutations();
  }

  /* ---------------- 还原 / 停止 ---------------- */
  function restore() {
    notifyFrames('restore');
    stopObserving();
    disconnectPort();
    let removed = 0;
    state.nodes.forEach(function (node) {
      if (node && node.parentNode) { node.parentNode.removeChild(node); removed++; }
    });
    state.byId.forEach(function (u) {
      removeLoader(u);
      if (u.hidden) { R.showOriginal(u.hidden); u.hidden = null; }
    });
    state.nodes.clear();
    state.titled.forEach(function (x) { if (x[0].getAttribute('title') === x[1]) x[0].removeAttribute('title'); });
    state.titled = [];
    // 翻译时补发过 resize 的页面，译文撤掉后同样需要重新排版
    clearTimeout(state.relayoutTimer);
    if (state.relayouts) { state.relayouts = 0; try { window.dispatchEvent(new Event('resize')); } catch (e) {} }
    if (state.originalTitle != null) { try { document.title = state.originalTitle; } catch (e) {} }
    state.originalTitle = null;
    state.renderQueue.length = 0;
    if (state.rafId) { state.rafId(); state.rafId = 0; }
    state.byId.clear();
    state.elUnit = new WeakMap();
    state.nodeUnit = new WeakMap();
    state.pending.clear();
    state.lazy.clear();
    state.sent.clear();
    state.failedIds.clear();
    state.knownEls = new WeakSet();
    state.churn = new WeakMap();
    state.total = 0; state.cached = 0; state.dropped = 0; state.dropLog = []; state.lastStats = null;
    state.error = null;
    state.reconnectTries = 0;
    state.overrides = null;
    state.announce = false;             // 备忘保留：还原后再次翻译可瞬间完成
    setStatus(NS.STATUS.IDLE);
    if (removed) ui.show('已还原原文', { kind: 'ok', duration: 1800 });
    else ui.hide();
  }

  function stopJob() {
    notifyFrames('stop');
    if (state.port) { try { state.port.postMessage({ type: NS.MSG.STOP }); } catch (e) {} }
    disconnectPort();
    stopObserving();
    removeAllLoaders();
    state.sent.clear();
    state.announce = false;
    setStatus(NS.STATUS.IDLE);
    ui.show('已停止翻译', { kind: 'ok', sub: '已完成的译文会保留', actions: state.nodes.size ? [{ label: '还原', run: restore }] : [] });
  }

  /* 快捷键 / 右键菜单：开 <-> 关。翻译进行中也直接还原（restore 会断开端口，后台随即中止在途请求） */
  function toggle() {
    if (state.status === NS.STATUS.TRANSLATING || state.status === NS.STATUS.SCANNING ||
        state.nodes.size || state.status === NS.STATUS.DONE) return restore();
    return start(null);
  }

  /* ---------------- 动态内容（SPA / 滚动加载 / 原文改写） ---------------- */
  const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true };

  function startObserving() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(onMutations);
    try {
      state.observer.observe(document.documentElement, OBSERVE_OPTS);
    } catch (e) {}
    state.shadowRoots.forEach(function (r) {
      if (!r.host || !r.host.isConnected) { state.shadowRoots.delete(r); return; }
      try { state.observer.observe(r, OBSERVE_OPTS); } catch (e) {}
    });
  }

  function observeShadows(roots) {
    if (!roots) return;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (state.shadowRoots.has(r)) continue;
      state.shadowRoots.add(r);
      if (state.observer) { try { state.observer.observe(r, OBSERVE_OPTS); } catch (e) {} }
    }
  }

  function stopObserving() {
    if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
    if (state.io) { try { state.io.disconnect(); } catch (e) {} state.io = null; }
    if (state.nearIO) { try { state.nearIO.disconnect(); } catch (e) {} state.nearIO = null; }
    if (state.armTimer) { clearTimeout(state.armTimer); state.armTimer = 0; }
    if (state.dirtyTimer) { clearTimeout(state.dirtyTimer); state.dirtyTimer = null; }
    state.dirtyRoots = [];
  }

  /* 丢弃自己写 DOM 产生的变更记录，避免自激 */
  function discardOwnMutations() {
    if (state.observer) { try { state.observer.takeRecords(); } catch (e) {} }
  }

  function isOurs(node) {
    return node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-wpt');
  }

  function insideOurs(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-wpt]'));
  }

  function onMutations(mutations) {
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === 'characterData') {
        if (!insideOurs(m.target) && m.target.parentElement) { state.dirtyRoots.push(m.target.parentElement); relevant = true; }
        continue;
      }
      if (insideOurs(m.target)) continue;
      // 译文被页面框架的重渲染抹掉：原样补回（每个单元最多 3 次，防止与框架拉锯）
      const removed = m.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        const n = removed[j];
        if (!isOurs(n)) continue;
        const u = state.nodeUnit.get(n);
        if (u && !u.dead && state.nodes.get(u.id) === n && (u.reinserts || 0) < 3) {
          u.reinserts = (u.reinserts || 0) + 1;
          state.nodes.delete(u.id);
          u.plan = null;
          state.renderQueue.push([u.id, n.textContent, n]);   // 附带旧节点：若只是被移动而非删除，直接认领
          scheduleRender();
        }
      }
      const added = m.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (isOurs(n)) continue;
        if (n.nodeType === 1) watchFrames(n);
        if (n.nodeType === 3) {
          const p = n.parentNode;
          if (p && p.nodeType === 1) { state.dirtyRoots.push(p); relevant = true; }
        } else if (n.nodeType === 1) {
          state.dirtyRoots.push(n); relevant = true;
        }
      }
    }
    if (!relevant) return;
    scheduleDelta();
  }

  function scheduleDelta() {
    if (state.dirtyRoots.length > 400) state.dirtyRoots = [document.body];
    if (state.dirtyTimer) return;
    state.dirtyTimer = setTimeout(function () {
      state.dirtyTimer = null;
      const roots = state.dirtyRoots;
      state.dirtyRoots = [];
      // 串行处理：语言识别是异步的，并行扫描可能把同一元素登记两次
      state.deltaChain = state.deltaChain.then(function () { return scanDelta(roots); }).catch(function () {});
    }, 700);
  }

  /*
   * 原文改写节奏控制：流式输出（AI 聊天逐字生成）、秒表、实时计数会持续改写同一元素，
   * 每次改写都重译会成倍消耗 token。第二次起，若距上次改写不足 SETTLE_MS，
   * 先撤下过期译文，等文本稳定 SETTLE_MS 后再翻译最终版本。
   */
  function noteRewrite(el, text) {
    let rec = state.churn.get(el);
    if (!rec) { rec = { last: 0, text: '', hot: false, timer: 0 }; state.churn.set(el, rec); }
    const now = Date.now();
    rec.hot = now - rec.last < SETTLE_MS;      // 首次改写照常立即重译；短时间内再次改写才进入观察
    rec.last = now;
    rec.text = text;
  }

  /* 该元素的原文是否已稳定；未稳定则安排稍后复查 */
  function settled(el, text) {
    const rec = state.churn.get(el);
    if (!rec || !rec.hot) return true;
    const now = Date.now();
    if (rec.text !== text) { rec.text = text; rec.last = now; }
    if (now - rec.last >= SETTLE_MS) { rec.hot = false; return true; }
    if (!rec.timer) {
      rec.timer = setTimeout(function () {
        rec.timer = 0;
        if (!el.isConnected) return;
        state.dirtyRoots.push(el);
        scheduleDelta();
      }, SETTLE_MS - (now - rec.last) + 50);
    }
    return false;
  }

  /* 行内节点的变化要归到所属的块（通常就是已登记的段落），否则会把半句话单独拿去翻译 */
  function normalizeRoot(node) {
    let cur = node && node.nodeType === 3 ? node.parentElement : node;
    for (let i = 0; cur && i < 10; i++) {
      if (state.elUnit.has(cur)) return cur;
      const p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement) return cur;
      let cs = null;
      try { cs = getComputedStyle(cur); } catch (e) {}
      if (cs && NS.Extractor.isBlockish(cur, cs)) return cur;
      cur = p;
    }
    return cur;
  }

  async function scanDelta(roots) {
    // 只在正常翻译 / 已完成时跟进；出错（如密钥无效）时不再自动发请求
    if (state.status !== NS.STATUS.TRANSLATING && state.status !== NS.STATUS.DONE) return;
    const settings = state.settings;
    if (!settings) return;
    const cfg = NS.settings.forContent(settings);
    const found = [];
    const seen = new Set();
    for (let i = 0; i < roots.length && found.length < 800; i++) {
      let node = normalizeRoot(roots[i]);
      if (!node || node.nodeType !== 1 || !node.isConnected) continue;
      if (seen.has(node) || insideOurs(node) || NS.Extractor.isHardSkip(node)) continue;
      if (!NS.Extractor.isRendered(node)) continue;      // 位于隐藏占位（虚拟列表离屏项）内部
      seen.add(node);
      let units;
      try { units = timed('collectMax', NS.Extractor.collect)(node, cfg); } catch (e) { continue; }
      observeShadows(units.shadowRoots);
      let invalidated = false;
      const mark = found.length;
      for (let j = 0; j < units.length; j++) {
        const u = units[j];
        const old = u.el ? state.elUnit.get(u.el) : null;
        if (old && !old.dead) {
          if (old.text === u.text) continue;
          noteRewrite(u.el, u.text);
          removeUnit(old);                       // 原文已被页面改写：旧译文作废
          invalidated = true;
        } else if (u.el && state.knownEls.has(u.el)) {
          continue;
        }
        if (u.el && !settled(u.el, u.text)) continue;   // 仍在频繁变化：稳定后再翻
        found.push(u);
      }
      if (invalidated) {
        // 旧译文 / 隐藏状态清理后重新抽取，拿到完整的新原文
        discardOwnMutations();
        found.length = mark;
        seen.delete(node);
        roots.splice(i + 1, 0, node);
      }
    }
    discardOwnMutations();
    if (!found.length) return;
    const fresh = await filterLanguage(found.filter(function (u) { return u.el && u.el.isConnected && !state.knownEls.has(u.el); }), settings);
    if ((state.status !== NS.STATUS.TRANSLATING && state.status !== NS.STATUS.DONE) || state.settings !== settings) return;
    // 已判定无需翻译的元素也登记，避免之后每次变动都重复识别
    for (let i = 0; i < found.length; i++) if (found[i].el) { try { state.knownEls.add(found[i].el); } catch (e) {} }
    if (!fresh.length) return;
    const ordered = NS.Extractor.byViewportPriority(fresh);
    addUnits(ordered);
    routeFromMemo(ordered);                                // 备忘命中直接渲染，无需请求
    armNear();                                             // 按需翻译：只激活视口附近的新段落
    dispatch();
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
      dropped: state.dropped,
      translated: state.nodes.size,
      targetLang: state.settings ? state.settings.targetLang : null,
      displayMode: state.settings ? state.settings.displayMode : null,
      error: state.error,
      usage: state.usage
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;
    if (msg.type === 'wpt:frame-cmd') { if (IS_CHILD) onFrameCmd(msg); return false; }
    if (IS_CHILD && !(msg.type === 'wpt:state' && msg.child)) return false;   // 状态查询、开关等只由顶层页面应答（调试可指定子框架）
    switch (msg.type) {
      case NS.MSG.PING:
      case 'wpt:state':
        sendResponse(msg.debug ? Object.assign(report(), { dropLog: state.dropLog, perf: perf }) : report());
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

  function openSettings() {
    try {
      const p = chrome.runtime.sendMessage({ type: 'wpt:open-options' });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 子框架 ---------------- */
  function notifyFrames(action) {
    if (IS_CHILD) return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'wpt:frames', action: action, overrides: state.overrides || null });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  /*
   * 晚到的框架：Cookie 同意框等常在页面加载完之后才插入 iframe，开始翻译时还不存在。
   * 顶层盯住每个 iframe 的 load：翻译进行中或已完成时，再让后台注入并通知一次（合并 400 ms 内的多次加载）；
   * 已经翻过的框架收到后只做增量，不会重翻。
   */
  const seenFrames = new WeakSet();
  let frameTimer = 0;
  function watchFrames(root) {
    if (IS_CHILD || !root) return;
    const list = root.tagName === 'IFRAME' || root.tagName === 'FRAME' ? [root]
      : (root.querySelectorAll ? root.querySelectorAll('iframe,frame') : []);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (seenFrames.has(f)) continue;
      seenFrames.add(f);
      f.addEventListener('load', onFrameLoad);
    }
  }

  function onFrameLoad() {
    if (state.status !== NS.STATUS.TRANSLATING && state.status !== NS.STATUS.DONE) return;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(function () { notifyFrames('start'); }, 400);
  }

  /* 太小（广告位、跟踪像素）或几乎没有文字的框架不值得翻译 */
  function frameWorthTranslating() {
    if (window.innerWidth < 200 || window.innerHeight < 60 || !document.body) return false;
    return (document.body.innerText || '').trim().length >= 20;
  }

  function onFrameCmd(msg) {
    if (msg.action === 'start') {
      if (frameWorthTranslating()) start(msg.overrides || null).catch(function () {});
    } else if (msg.action === 'restore') {
      if (state.nodes.size || state.status !== NS.STATUS.IDLE) restore();
    } else if (msg.action === 'stop') {
      if (state.status === NS.STATUS.TRANSLATING || state.status === NS.STATUS.SCANNING) stopJob();
    }
  }

  NS.Content = {
    start: start,
    restore: restore,
    toggle: toggle,
    stop: stopJob,
    retryFailed: retryFailed,
    report: report,
    state: state
  };

  /* 自动翻译模式（动态注册内容脚本时） */
  NS.settings.get().then(async function (s) {
    if (IS_CHILD || !NS.settings.autoAllowed(s, location.hostname)) return;
    // 整页已是目标语言（全站自动翻译时打开的中文网页）：不请求、不弹提示；手动翻译不受影响
    if (s.skipTargetLang && await pageIsTarget(s.targetLang)) return;
    start(null);
  }).catch(function () {});

  async function pageIsTarget(targetLang) {
    const sample = U.normalizeText((document.body && document.body.innerText || '').slice(0, 3000));
    if (sample.length < 40) return false;
    if (chrome.i18n && typeof chrome.i18n.detectLanguage === 'function') return detectIsTarget(sample, U.baseLang(targetLang));
    return U.isProbablyTargetLang(sample, targetLang);
  }
})();
