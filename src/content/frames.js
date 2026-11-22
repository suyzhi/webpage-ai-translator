/*
 * AI 网页翻译 — 主文档与子框架（iframe / frameset）协同。
 * 顶层页面负责发现候选框架、监听晚到 iframe 的 load 并通知后台注入与转发指令；
 * 子框架仅监听后台转发的开始 / 还原 / 停止指令，并上报自身的译文数给顶层页面。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.Frames) return;

  /** @param {Element | null | undefined} el */
  function tagOf(el) { return el && el.tagName ? el.tagName.toUpperCase() : ''; }

  /**
   * 创建主/子框架协同控制器。
   * @param {WptFramesDeps} deps
   * @returns {WptFramesApi}
   */
  function create(deps) {
    const isChild = !!deps.isChild;
    let active = false;
    let translated = 0;
    /** @type {Map<number, number>} */
    const counts = new Map();
    const seenFrames = new WeakSet();
    /** @type {any} */
    let frameTimer = 0;

    /**
     * @param {'start' | 'restore' | 'stop'} action
     * @returns {Promise<any>}
     */
    function notify(action) {
      if (isChild) return Promise.resolve();
      try {
        const p = chrome.runtime.sendMessage({
          type: NS.MSG.FRAMES,
          action: action,
          overrides: deps.getOverrides() || null
        });
        return p && typeof p.catch === 'function' ? p.catch(function () {}) : Promise.resolve();
      } catch (e) {
        return Promise.resolve();
      }
    }

    /** @param {boolean} isActive */
    function reportStatus(isActive) {
      if (!isChild) return;
      try {
        const p = chrome.runtime.sendMessage({
          type: NS.MSG.FRAME_STATUS,
          active: !!isActive,
          translated: deps.getTranslatedCount()
        });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }

    function hasCandidates() {
      if (document.body && tagOf(document.body) === 'FRAMESET') return true;
      /** @type {Array<Document | ShadowRoot>} */
      const roots = [document];
      const shadows = deps.getShadowRoots();
      if (shadows) shadows.forEach(function (r) { roots.push(r); });
      for (let k = 0; k < roots.length; k++) {
        const list = roots[k].querySelectorAll ? roots[k].querySelectorAll('iframe,frame') : [];
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          if (tagOf(f) === 'FRAME') return true;
          try {
            const r = f.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 60) return true;
          } catch (e) {}
        }
      }
      return false;
    }

    /** @param {Promise<any>} frameTask */
    async function waitForActive(frameTask) {
      try { await frameTask; } catch (e) {}
      for (let i = 0; i < 8 && !active; i++) {
        await new Promise(function (r) { setTimeout(r, 80); });
      }
    }

    /*
     * 晚到的框架：Cookie 同意框等常在页面加载完之后才插入 iframe，开始翻译时还不存在。
     * 顶层盯住每个 iframe 的 load：翻译进行中或已完成时，再让后台注入并通知一次（合并 400 ms 内的多次加载）；
     * 已经翻过的框架收到后只做增量，不会重翻。
     */
    function onFrameLoad() {
      const st = deps.getStatus();
      if (st !== NS.STATUS.TRANSLATING && st !== NS.STATUS.DONE) return;
      clearTimeout(frameTimer);
      frameTimer = setTimeout(function () { notify('start'); }, 400);
    }

    /** @param {Document | Element | ShadowRoot | null | undefined} root */
    function watch(root) {
      if (isChild || !root) return;
      const tag = tagOf(/** @type {Element} */ (root));
      const list = tag === 'IFRAME' || tag === 'FRAME' ? [/** @type {Element} */ (root)]
        : (root.querySelectorAll ? root.querySelectorAll('iframe,frame') : []);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (seenFrames.has(f)) continue;
        seenFrames.add(f);
        f.addEventListener('load', onFrameLoad);
      }
    }

    /* 太小（广告位、跟踪像素）或几乎没有文字的框架不值得翻译；兼容影子树内容与仍在加载中的子框架 */
    async function worthTranslating() {
      await deps.waitBodyReady();
      if (window.innerWidth < 200 || window.innerHeight < 60 || !document.body) return false;
      if (tagOf(document.body) === 'FRAMESET') return true;
      if ((document.body.innerText || '').trim().length >= 20) return true;
      // 影子树里的内容不会出现在 document.body.innerText 中
      if (NS.Extractor && NS.Extractor.shadowOf) {
        if (NS.Extractor.shadowOf(document.body)) return true;
        const els = document.body.querySelectorAll ? document.body.querySelectorAll('*') : [];
        for (let i = 0; i < els.length && i < 60; i++) {
          if (NS.Extractor.shadowOf(els[i])) return true;
        }
      }
      return false;
    }

    /** @param {any} msg */
    function onFrameCmd(msg) {
      if (msg.action === 'start') {
        worthTranslating().then(function (ok) {
          if (ok) deps.onStart(msg.overrides || null);
        }).catch(function () {});
      } else if (msg.action === 'restore') {
        deps.onRestore();
      } else if (msg.action === 'stop') {
        deps.onStop();
      }
    }

    /**
     * 处理与框架相关的 runtime 消息；已消费返回 true。
     * @param {any} msg
     * @returns {boolean}
     */
    function handleMessage(msg) {
      if (msg.type === NS.MSG.FRAME_CMD) {
        if (isChild) onFrameCmd(msg);
        return true;
      }
      if (msg.type === NS.MSG.FRAME_STATUS) {
        if (!isChild && msg.frameId != null) {
          if (msg.active) active = true;
          counts.set(msg.frameId, msg.translated || 0);
          let sum = 0;
          counts.forEach(function (v) { sum += v; });
          translated = sum;
        }
        return true;
      }
      return false;
    }

    function reset() {
      const had = active || translated > 0;
      active = false;
      translated = 0;
      counts.clear();
      clearTimeout(frameTimer);
      frameTimer = 0;
      return had;
    }

    return {
      notify: notify,
      reportStatus: reportStatus,
      hasCandidates: hasCandidates,
      waitForActive: waitForActive,
      watch: watch,
      handleMessage: handleMessage,
      isActive: function () { return active; },
      translatedCount: function () { return translated; },
      hasAny: function () { return active || translated > 0; },
      reset: reset
    };
  }

  NS.Frames = { create: create };
})();
