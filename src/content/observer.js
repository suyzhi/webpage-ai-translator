/*
 * AI 网页翻译 — 动态内容监听（SPA / 滚动加载 / 原文改写节流 / 隐藏块显现补翻）。
 * 负责 MutationObserver、ShadowRoot 追踪、文本频繁改写稳定判定（churn/settle）与增量扫描。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.Observer) return;

  /* 原文连续改写的间隔小于该值视为「仍在变化」，等稳定后再翻译 */
  const SETTLE_MS = 2500;
  const OBSERVE_OPTS = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden', 'data-state']
  };

  /** @param {Node | null | undefined} node */
  function isOurs(node) {
    return !!(node && node.nodeType === 1 && /** @type {Element} */ (node).hasAttribute && /** @type {Element} */ (node).hasAttribute('data-wpt'));
  }

  /** @param {Node | null | undefined} node */
  function insideOurs(node) {
    const el = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement);
    return !!(el && el.closest && el.closest('[data-wpt]'));
  }

  /**
   * 创建动态内容监听器。
   * @param {WptObserverDeps} deps
   * @returns {WptObserverApi}
   */
  function create(deps) {
    /** @type {MutationObserver | null} */
    let observer = null;
    /** @type {Set<ShadowRoot>} */
    const shadowRoots = new Set();
    /** @type {Set<Element>} */
    const hiddenEls = new Set();
    /** @type {any} */
    let revealTimer = 0;
    /** @type {any} */
    let scrollTimer = 0;
    let scrollBound = false;
    /** @type {Element[]} */
    let dirtyRoots = [];
    /** @type {any} */
    let dirtyTimer = null;
    let deltaChain = Promise.resolve();
    /** @type {WeakMap<Element, { last: number, text: string, hot: boolean, timer: any }>} */
    let churn = new WeakMap();

    function isActive() {
      const st = deps.getStatus();
      return st === NS.STATUS.TRANSLATING || st === NS.STATUS.DONE;
    }

    /** @param {Element[] | null | undefined} list */
    function trackHidden(list) {
      if (!list || !list.length) return;
      for (let i = 0; i < list.length && hiddenEls.size < 600; i++) hiddenEls.add(list[i]);
    }

    function onScroll() {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = 0;
        if (!isActive()) return;
        deps.onLazyScroll();
        if (hiddenEls.size) scheduleRevealCheck();
      }, 180);
    }

    function scheduleRevealCheck() {
      if (revealTimer || !hiddenEls.size) return;
      revealTimer = setTimeout(checkRevealed, 250);
    }

    /* 检查此前因不可见跳过的元素（标签页切换 / 折叠面板 / 滚动淡入）：一旦变为可见立即补翻 */
    function checkRevealed() {
      revealTimer = 0;
      if (!isActive() || !hiddenEls.size) return;
      let found = false;
      hiddenEls.forEach(function (el) {
        if (!el || !el.isConnected) { hiddenEls.delete(el); return; }
        if (NS.Extractor.isVisible(el)) {
          hiddenEls.delete(el);
          dirtyRoots.push(el);
          found = true;
        }
      });
      if (found) scheduleDelta();
    }

    function start() {
      if (!scrollBound && typeof document.addEventListener === 'function') {
        document.addEventListener('scroll', onScroll, { passive: true, capture: true });
        scrollBound = true;
      }
      if (observer || !document.documentElement) return;
      observer = new MutationObserver(onMutations);
      try { observer.observe(document.documentElement, OBSERVE_OPTS); } catch (e) {}
      shadowRoots.forEach(function (r) {
        if (!r.host || !r.host.isConnected) { shadowRoots.delete(r); return; }
        try { observer.observe(r, OBSERVE_OPTS); } catch (e) {}
      });
    }

    /** @param {ShadowRoot[] | null | undefined} roots */
    function observeShadows(roots) {
      if (!roots) return;
      for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        if (shadowRoots.has(r)) continue;
        shadowRoots.add(r);
        deps.onNewFrameRoot(r);
        if (observer) { try { observer.observe(r, OBSERVE_OPTS); } catch (e) {} }
      }
    }

    function stop() {
      if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = 0; }
      if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = 0; }
      if (scrollBound && typeof document.removeEventListener === 'function') {
        document.removeEventListener('scroll', onScroll, { capture: true });
        scrollBound = false;
      }
      if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
      dirtyRoots = [];
    }

    function reset() {
      hiddenEls.clear();
      churn = new WeakMap();
    }

    /* 丢弃自己写 DOM 产生的变更记录，避免自激 */
    function discardOwn() {
      if (observer) { try { observer.takeRecords(); } catch (e) {} }
    }

    /** @param {MutationRecord[]} mutations */
    function onMutations(mutations) {
      let relevant = false;
      let checkReveal = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'characterData') {
          if (!insideOurs(m.target) && m.target.parentElement) {
            dirtyRoots.push(m.target.parentElement);
            relevant = true;
          }
          continue;
        }
        if (insideOurs(m.target)) continue;
        if (m.type === 'attributes') {
          const targetEl = /** @type {Element} */ (m.target);
          if (m.attributeName === 'open' && targetEl && targetEl.hasAttribute && targetEl.hasAttribute('open')) {
            dirtyRoots.push(targetEl);
            relevant = true;
          } else if (hiddenEls.size) {
            checkReveal = true;
          }
          continue;
        }
        // 译文被页面框架的重渲染抹掉：交由主控补回
        const removed = m.removedNodes;
        for (let j = 0; j < removed.length; j++) {
          const n = removed[j];
          if (isOurs(n)) deps.onNodeRemoved(/** @type {HTMLElement} */ (n));
        }
        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (isOurs(n)) continue;
          if (n.nodeType === 1) deps.onNewFrameRoot(/** @type {Element} */ (n));
          if (n.nodeType === 3) {
            const p = n.parentNode;
            if (p && p.nodeType === 1) { dirtyRoots.push(/** @type {Element} */ (p)); relevant = true; }
          } else if (n.nodeType === 1) {
            dirtyRoots.push(/** @type {Element} */ (n));
            relevant = true;
          }
        }
      }
      if (checkReveal) scheduleRevealCheck();
      if (!relevant) return;
      scheduleDelta();
    }

    function scheduleDelta() {
      if (dirtyRoots.length > 400) dirtyRoots = [document.body];
      if (dirtyTimer) return;
      dirtyTimer = setTimeout(function () {
        dirtyTimer = null;
        const roots = dirtyRoots;
        dirtyRoots = [];
        // 串行处理：语言识别是异步的，并行扫描可能把同一元素登记两次
        deltaChain = deltaChain.then(function () { return scanDelta(roots); }).catch(function () {});
      }, 700);
    }

    /*
     * 原文改写节奏控制：流式输出（AI 聊天逐字生成）、秒表、实时计数会持续改写同一元素，
     * 每次改写都重译会成倍消耗 token。第二次起，若距上次改写不足 SETTLE_MS，
     * 先撤下过期译文，等文本稳定 SETTLE_MS 后再翻译最终版本。
     */
    /**
     * @param {Element} el
     * @param {string} text
     */
    function noteRewrite(el, text) {
      let rec = churn.get(el);
      if (!rec) { rec = { last: 0, text: '', hot: false, timer: 0 }; churn.set(el, rec); }
      const now = Date.now();
      rec.hot = now - rec.last < SETTLE_MS;      // 首次改写照常立即重译；短时间内再次改写才进入观察
      rec.last = now;
      rec.text = text;
    }

    /* 该元素的原文是否已稳定；未稳定则安排稍后复查 */
    /**
     * @param {Element} el
     * @param {string} text
     * @returns {boolean}
     */
    function settled(el, text) {
      const rec = churn.get(el);
      if (!rec || !rec.hot) return true;
      const now = Date.now();
      if (rec.text !== text) { rec.text = text; rec.last = now; }
      if (now - rec.last >= SETTLE_MS) { rec.hot = false; return true; }
      if (!rec.timer) {
        rec.timer = setTimeout(function () {
          rec.timer = 0;
          if (!el.isConnected) return;
          dirtyRoots.push(el);
          scheduleDelta();
        }, SETTLE_MS - (now - rec.last) + 50);
      }
      return false;
    }

    /* 行内节点的变化要归到所属的块（通常就是已登记的段落），否则会把半句话单独拿去翻译 */
    /** @param {Node} node */
    function normalizeRoot(node) {
      let cur = node && node.nodeType === 3 ? node.parentElement : /** @type {Element | null} */ (node);
      for (let i = 0; cur && i < 10; i++) {
        if (deps.hasUnitElement(cur)) return cur;
        const p = cur.parentElement;
        if (!p || p === document.body || p === document.documentElement) return cur;
        let cs = null;
        try { cs = getComputedStyle(cur); } catch (e) {}
        if (cs && NS.Extractor.isBlockish(cur, cs)) return cur;
        cur = p;
      }
      return cur;
    }

    /** @param {Element[]} roots */
    async function scanDelta(roots) {
      // 只在正常翻译 / 已完成时跟进；出错（如密钥无效）时不再自动发请求
      if (!isActive()) return;
      const settings = deps.getSettings();
      if (!settings) return;
      const cfg = NS.settings.forContent(settings);
      /** @type {WptUnit[]} */
      const found = [];
      const seen = new Set();
      for (let i = 0; i < roots.length && found.length < 800; i++) {
        const node = normalizeRoot(roots[i]);
        if (!node || node.nodeType !== 1 || !node.isConnected) continue;
        if (seen.has(node) || insideOurs(node) || NS.Extractor.isHardSkip(node)) continue;
        if (!NS.Extractor.isRendered(node)) continue;      // 位于隐藏占位（虚拟列表离屏项）内部
        seen.add(node);
        let units;
        try { units = deps.collect(node, cfg); } catch (e) { continue; }
        observeShadows(units.shadowRoots);
        trackHidden(units.hiddenEls);
        let invalidated = false;
        const mark = found.length;
        for (let j = 0; j < units.length; j++) {
          const u = units[j];
          const old = u.el ? deps.getUnitByElement(u.el) : null;
          if (old && !old.dead) {
            if (old.text === u.text) continue;
            noteRewrite(u.el, u.text);
            deps.removeUnit(old);                // 原文已被页面改写：旧译文作废
            invalidated = true;
          } else if (u.el && deps.isKnownElement(u.el)) {
            continue;
          }
          if (u.el && !settled(u.el, u.text)) continue;   // 仍在频繁变化：稳定后再翻
          found.push(u);
        }
        if (invalidated) {
          // 旧译文 / 隐藏状态清理后重新抽取，拿到完整的新原文
          discardOwn();
          found.length = mark;
          seen.delete(node);
          roots.splice(i + 1, 0, node);
        }
      }
      discardOwn();
      if (!found.length) return;
      const fresh = await deps.filterLanguage(
        found.filter(function (u) { return !!(u.el && u.el.isConnected && !deps.isKnownElement(u.el)); }),
        settings
      );
      if (!isActive() || deps.getSettings() !== settings) return;
      // 已判定无需翻译的元素也登记，避免之后每次变动都重复识别
      for (let i = 0; i < found.length; i++) if (found[i].el) deps.markKnownElement(found[i].el);
      if (!fresh.length) return;
      deps.onDeltaUnits(fresh);
    }

    return {
      start: start,
      stop: stop,
      reset: reset,
      observeShadows: observeShadows,
      trackHidden: trackHidden,
      discardOwn: discardOwn,
      getShadowRoots: function () { return shadowRoots; }
    };
  }

  NS.Observer = { create: create };
})();
