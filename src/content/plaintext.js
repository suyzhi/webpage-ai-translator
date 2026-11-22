/*
 * AI 网页翻译 — 纯文本页面（RFC、.txt 文档、GitHub Raw）适配。
 * Chrome 用单个 <pre> 包装全文；本模块将其切分为段落后再走常规按需翻译链路，还原时无损恢复。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.PlainText) return;

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  /** @param {Element | null | undefined} el */
  function tagOf(el) { return el && el.tagName ? el.tagName.toUpperCase() : ''; }

  /**
   * @param {string} tag
   * @param {string} [cls]
   * @returns {HTMLElement}
   */
  function mkEl(tag, cls) {
    const el = /** @type {HTMLElement} */ (typeof document.createElementNS === 'function'
      ? document.createElementNS(XHTML_NS, tag)
      : document.createElement(tag));
    if (cls) el.className = cls;
    return el;
  }

  /**
   * 创建纯文本页面适配器。
   * @param {boolean} isChild
   * @returns {WptPlainTextApi}
   */
  function create(isChild) {
    /** @type {HTMLElement | null} */
    let wrap = null;
    /** @type {HTMLElement | null} */
    let pre = null;
    let preDisplay = '';

    function prepare() {
      if (isChild || document.contentType !== 'text/plain' || wrap || !document.body) return wrap;
      const kids = document.body.children;
      if (!kids || kids.length !== 1 || tagOf(kids[0]) !== 'PRE') return null;
      const orig = /** @type {HTMLElement} */ (kids[0]);
      const raw = orig.textContent || '';
      if (!raw.trim()) return null;

      const box = mkEl('div', 'wpt-plain-wrap');
      let cs = null;
      try { cs = getComputedStyle(orig); } catch (e) {}
      box.style.cssText = 'white-space:pre-wrap;word-wrap:break-word;margin:0;padding:0;' +
        (cs ? 'font-family:' + cs.fontFamily + ';font-size:' + cs.fontSize + ';line-height:1.65;color:' + cs.color + ';' : 'font-family:monospace;line-height:1.65;');

      const paras = raw.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
      const chunks = [];
      for (let i = 0; i < paras.length && chunks.length < 4000; i++) {
        const part = paras[i];
        if (part.length <= 1200) { chunks.push(part); continue; }
        const lines = part.split('\n');
        let cur = '';
        for (let j = 0; j < lines.length && chunks.length < 4000; j++) {
          if (cur && cur.length + lines[j].length + 1 > 1000) { chunks.push(cur); cur = lines[j]; }
          else cur = cur ? cur + '\n' + lines[j] : lines[j];
        }
        if (cur) chunks.push(cur);
      }

      const frag = document.createDocumentFragment();
      for (let i = 0; i < chunks.length; i++) {
        const p = mkEl('p');
        p.style.cssText = 'margin:0 0 1em 0;white-space:pre-wrap;';
        p.textContent = chunks[i];
        frag.appendChild(p);
      }
      box.appendChild(frag);
      pre = orig;
      preDisplay = orig.style.display;
      orig.style.display = 'none';
      document.body.appendChild(box);
      wrap = box;
      return wrap;
    }

    function teardown() {
      const had = !!wrap;
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (pre) pre.style.display = preDisplay || '';
      wrap = null;
      pre = null;
      preDisplay = '';
      return had;
    }

    function root() { return wrap; }

    return { prepare: prepare, teardown: teardown, root: root };
  }

  NS.PlainText = { create: create };
})();
