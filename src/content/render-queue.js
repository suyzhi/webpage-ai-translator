/*
 * AI 网页翻译 — 分帧渲染队列、裁切复查与瀑布流重排兜底。
 *  - 每帧预算约 10 ms，读写分离（先批量规划并创建离线节点，再统一插入 DOM），大页面不卡顿；
 *  - 渲染后的下一帧统一检查被定高容器裁切的译文，自动改行内 / 移到容器后 / 撤掉并挂悬停提示；
 *  - 若翻译前无横向滚动而翻译后出现（瀑布流脚本按加载高度排布），补发 resize 让页面自行重排。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.RenderQueue) return;

  const U = NS.util;
  const FRAME_BUDGET_MS = 10;
  const SLICE = 40;

  /**
   * 下一帧执行。拿不到帧时（后台标签页暂停 rAF；滚出视口的 iframe 也不触发 rAF）由定时器兜底：
   * 隐藏页面直接用 hiddenDelay，可见页面 100 ms 内没等到帧也照常执行。返回取消函数。
   * @param {() => void} fn
   * @param {number} [hiddenDelay]
   * @returns {() => void}
   */
  function nextFrame(fn, hiddenDelay) {
    let done = false;
    let raf = 0;
    /** @type {any} */
    let timer = 0;
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

  function hasHScroll() {
    const d = document.documentElement;
    return !!d && d.scrollWidth > window.innerWidth + 1;
  }

  /**
   * 创建分帧渲染与裁切复查控制器。
   * @param {WptRenderQueueDeps} deps
   * @returns {WptRenderQueueApi}
   */
  function create(deps) {
    /** @type {Array<[number, string, HTMLElement?]>} */
    const queue = [];
    /** @type {(() => void) | null} */
    let cancelRaf = null;
    /** @type {HTMLElement[]} */
    let clipCheck = [];
    /** @type {(() => void) | null} */
    let cancelClip = null;
    let dropped = 0;
    /** @type {string[]} */
    let dropLog = [];
    /** @type {Array<[Element, string]>} */
    let titled = [];
    let hScroll0 = false;
    let relayouts = 0;
    /** @type {any} */
    let relayoutTimer = 0;

    function schedule() {
      if (cancelRaf || !queue.length) return;
      cancelRaf = nextFrame(flush, 0);
    }

    /** @param {[number, string, HTMLElement?]} entry */
    function push(entry) {
      queue.push(entry);
    }

    /*
     * 防重复：框架有时会把我们的译文节点「移走再放回」（先触发删除记录），
     * 此时不应再插一份；优先认领仍在页面上、且属于该单元的旧节点。
     */
    /**
     * @param {WptUnit} u
     * @param {HTMLElement | null | undefined} hint
     * @returns {HTMLElement | null}
     */
    function adoptStray(u, hint) {
      if (hint && hint.isConnected) return hint;
      if (!u.el || !u.el.querySelectorAll) return null;
      const found = u.el.querySelectorAll('.wpt-translation');
      /** @type {HTMLElement | null} */
      let keep = null;
      for (let i = 0; i < found.length; i++) {
        const node = /** @type {HTMLElement} */ (found[i]);
        if (deps.getUnitByNode(node) !== u) continue;
        if (!keep) keep = node;
        else if (node.parentNode) node.parentNode.removeChild(node);   // 多余的副本直接清掉
      }
      return keep;
    }

    const flush = deps.timed('renderMax', flushNow);
    function flushNow() {
      cancelRaf = null;
      const settings = deps.getSettings();
      const R = NS.Renderer;
      if (!queue.length || !settings || !R) return;
      const only = deps.onlyTranslation();
      const animate = settings.animations && !R.reducedMotion();
      const budget = document.hidden ? Infinity : FRAME_BUDGET_MS;
      const t0 = performance.now();
      let stagger = 0;

      while (queue.length && performance.now() - t0 < budget) {
        const slice = queue.splice(0, SLICE);
        // 读阶段：规划位置、创建（未挂载的）译文节点 —— 只读样式，不触发重排
        const jobs = [];
        for (let i = 0; i < slice.length; i++) {
          const id = slice[i][0];
          const text = slice[i][1];
          const u = deps.getUnit(id);
          if (!u || u.dead) continue;
          if (u.isTitle) {
            if (settings.translateTitle && text) document.title = text;
            continue;
          }
          const existing = deps.getNode(u.id) || adoptStray(u, slice[i][2]);
          if (existing && existing.isConnected) {
            deps.setNode(u.id, existing, u);
            if (existing.textContent !== text) existing.textContent = text;
            continue;
          }
          if (!u.el || !u.el.isConnected) { deps.removeLoader(u); continue; }
          // 模型原样返回（人名、品牌、代码等）：不重复显示
          if (U.sameText(text, u.text)) {
            u.same = true;
            deps.removeLoader(u);
            deps.unobserveIO(u.el);
            continue;
          }
          const plan = u.plan || (u.plan = R.plan(u, only));
          jobs.push({ u: u, node: R.create(u.el, text, settings, plan), plan: plan });
        }
        // 写阶段
        for (let i = 0; i < jobs.length; i++) {
          const j = jobs[i];
          deps.removeLoader(j.u);
          const mode = R.insert(j.node, j.u, j.plan);
          if (!mode) continue;
          deps.setNode(j.u.id, j.node, j.u);
          if (only && !j.u.hidden) j.u.hidden = R.hideOriginal(j.u, j.node);
          if (animate && j.u.visible) R.animate(j.node, Math.min(stagger++ * 45, 360));
          if (j.u.el) deps.unobserveIO(j.u.el);
          if (!only) clipCheck.push(j.node);
        }
      }
      deps.discardOwnMutations();
      if (deps.isChild && deps.nodeCount()) deps.onChildRendered();
      scheduleClipCheck();
      schedule();
      deps.onProgress();
    }

    /*
     * 被裁切兜底：固定高度 + overflow 的容器里（横向导航条、限高卡片），块级译文会被截掉。
     * 渲染后的下一帧统一检查（先全部读、再全部写），被裁切的改为行内 / 移到容器之后 / 悬停提示。
     */
    function scheduleClipCheck() {
      if (cancelClip || !clipCheck.length) return;
      cancelClip = nextFrame(checkClipped, 50);
    }

    /* 撤掉的译文不丢：挂到原文的悬停提示上（不占位置；原文或其外层已有提示的不覆盖） */
    /**
     * @param {WptUnit} u
     * @param {string} why
     * @param {string | null} text
     */
    function noteDrop(u, why, text) {
      dropped++;
      if (dropLog.length < 40) dropLog.push(why + ': ' + String(u.text || '').slice(0, 40));
      const el = u.el;
      if (!el || !text || !el.closest || el.closest('[title]')) return;
      el.setAttribute('title', text);
      titled.push([el, text]);
    }

    const checkClipped = deps.timed('clipMax', checkClippedNow);
    function checkClippedNow() {
      cancelClip = null;
      const list = clipCheck;
      clipCheck = [];
      const settings = deps.getSettings();
      const R = NS.Renderer;
      if (!settings || !R || deps.onlyTranslation()) return;
      /** @type {Array<[WptUnit, HTMLElement, WptPlan | null]>} */
      const fix = [];
      /** @type {Array<[WptUnit, HTMLElement, string]>} */
      const drop = [];
      /** @type {HTMLElement[]} */
      const realign = [];

      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        const u = node.isConnected ? deps.getUnitByNode(node) : null;
        if (!u || u.dead || !u.el) continue;
        // 入场动画（上浮 + 位移）期间矩形带着 transform，会被误判为溢出：动画结束后再查
        const anims = typeof node.getAnimations === 'function' ? node.getAnimations() : [];
        if (anims.length) {
          Promise.all(anims.map(function (a) { return a.finished; })).catch(function () {}).then(function () {
            clipCheck.push(node);
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
        deps.deleteNode(drop[i][0].id);
        noteDrop(drop[i][0], drop[i][2], drop[i][1].textContent);
      }
      for (let i = 0; i < fix.length; i++) {
        const u = fix[i][0];
        const node = fix[i][1];
        node.remove();
        if (u.clipFallback) {
          // 改成行内后仍被截（容器太窄、换行后超出）：宁可不显示，也不留半截碎片
          deps.deleteNode(u.id);
          noteDrop(u, 'fallback', node.textContent);
          continue;
        }
        const plan = fix[i][2] || { mode: 'inline', target: u.el, typo: null, only: false };
        const repl = R.create(u.el, node.textContent || '', settings, plan);
        if (!R.insert(repl, u, plan)) continue;
        u.plan = plan;
        u.clipFallback = true;
        deps.setNode(u.id, repl, u);
        clipCheck.push(repl);                      // 再查一次
      }
      deps.discardOwnMutations();
      scheduleClipCheck();
      scheduleRelayout();
    }

    function captureHScroll() {
      hScroll0 = hasHScroll();
    }

    /*
     * 页面脚本按加载时的高度排好的布局（瀑布流 / masonry：定高的纵向换行 flex），
     * 加了译文之后内容变高、多出一列，整页出现横向滚动条。这类脚本都监听 resize：
     * 翻译前没有横向滚动、翻译后出现了，就补发一次 resize 让页面自己重新排版。
     * 流式翻译会分很多次落地：翻译中等安静 1 s 再发，完成时再查一次；每页最多 5 次。
     */
    function scheduleRelayout() {
      if (hScroll0 || relayouts >= 5) return;
      clearTimeout(relayoutTimer);
      const wait = deps.getStatus() === NS.STATUS.TRANSLATING ? 1000 : 300;
      relayoutTimer = setTimeout(function () {
        if (!deps.nodeCount() || !hasHScroll()) return;
        relayouts++;
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      }, wait);
    }

    function reset() {
      titled.forEach(function (x) { if (x[0].getAttribute('title') === x[1]) x[0].removeAttribute('title'); });
      titled = [];
      clearTimeout(relayoutTimer);
      relayoutTimer = 0;
      if (relayouts) { relayouts = 0; try { window.dispatchEvent(new Event('resize')); } catch (e) {} }
      queue.length = 0;
      if (cancelRaf) { cancelRaf(); cancelRaf = null; }
      clipCheck = [];
      if (cancelClip) { cancelClip(); cancelClip = null; }
      dropped = 0;
      dropLog = [];
    }

    return {
      push: push,
      schedule: schedule,
      captureHScroll: captureHScroll,
      scheduleRelayout: scheduleRelayout,
      reset: reset,
      dropped: function () { return dropped; },
      dropLog: function () { return dropLog; }
    };
  }

  NS.RenderQueue = { create: create, nextFrame: nextFrame };
})();
