/*
 * 内容抽取：把页面切分成「段落级翻译单元」。
 *
 * 算法（单次 O(n) 遍历，读写分离，不触发布局抖动）：
 *   1. 自顶向下遍历，用 getComputedStyle 判定块级 / 行内；
 *   2. 无块级子元素的元素 => 叶子块，整段文本作为一个翻译单元；
 *   3. 同时含块级子元素与行内文本的混合元素 => 行内部分单独作为一个单元，
 *      插入锚点定在最后一个行内节点之后（位置恰好在该段文字下方）；
 *   4. 纯行内元素不单独成单元，其文本并入所属块，保证句子完整、语义不割裂；
 *   5. 过滤：不可见 / 代码块 / 输入控件 / 已是目标语言 / 纯数字符号 / 过短。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Extractor) return;
  const U = NS.util;

  const HARD_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'OPTGROUP', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'MAP',
    'AREA', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'TRACK', 'SOURCE', 'DIALOG'
  ]);

  /* 这些行内元素不单独成单元，但其文本会并入所属块，避免句子被截断 */
  const INLINE_SOFT_SKIP = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'CITE', 'ABBR']);

  const SKIP_CLASS_RE = /(^|[-_\s])(notranslate|no-?translate|skiptranslate|wpt-translation|wpt-ignore|hljs|highlight|monaco-editor|CodeMirror|cm-editor|ace_editor|katex|MathJax|mwe-math-element|blob-code|linenumber)([-_\s]|$)/i;
  const SKIP_ID_RE = /^(?:notranslate|no-?translate|wpt-)/i;

  const TABLE_STRUCT = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'UL', 'OL', 'DL', 'SELECT', 'MENU']);
  const CELL_LIKE = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'CAPTION', 'SUMMARY', 'FIGCAPTION']);

  const MAX_UNITS = 5000;
  const MAX_DEPTH = 80;
  const INLINE_BLOCK_MIN_TEXT = 20;   // 视觉长度阈值（约 10 个汉字 / 20 个西文字符）

  function isHardSkip(el) {
    const tag = el.tagName;
    if (HARD_SKIP_TAGS.has(tag)) return true;
    if (el.hasAttribute && el.hasAttribute('data-wpt')) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.isContentEditable) return true;
    const cls = el.className;
    if (typeof cls === 'string' && cls && SKIP_CLASS_RE.test(cls)) return true;
    const id = el.id;
    if (typeof id === 'string' && id && SKIP_ID_RE.test(id)) return true;
    return false;
  }

  function isVisible(el) {
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ visibilityProperty: true }); } catch (e) { /* 继续降级 */ }
    }
    return el.getClientRects().length > 0;
  }

  function isBlockish(el, cs) {
    const d = cs.display;
    if (d === 'block' || d === 'flow-root' || d === 'list-item' || d === 'flex' || d === 'grid' ||
        d === 'table' || d === 'table-row' || d === 'table-row-group' || d === 'table-header-group' ||
        d === 'table-footer-group' || d === 'table-cell' || d === 'table-caption') return true;
    if (d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid' || d === 'inline-table') {
      // 卡片式 inline-block：有子元素且文本足够长才当作独立块，
      // 否则会把导航按钮、徽章切成一堆碎块。
      // 用视觉长度（CJK 记 2）而非字符数，中日韩页面才不会因为阈值过高而被合并成大段。
      if (!el.childElementCount) return false;
      return U.visualLength(el.textContent) >= INLINE_BLOCK_MIN_TEXT;
    }
    return false;
  }

  /* 收集行内文本（含 <br> 换行），跳过硬过滤元素与不可见元素 */
  function collectText(node, out, depth) {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        if (n.nodeValue) out.push(n.nodeValue);
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'BR') { out.push('\n'); continue; }
      if (isHardSkip(n)) continue;
      if (depth < 40 && !isVisible(n)) continue;
      collectText(n, out, depth + 1);
    }
    return out;
  }

  function inlineTextOf(node) {
    return collectText(node, [], 0).join('');
  }

  function inlineTextOfNodes(nodes) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3) { if (n.nodeValue) out.push(n.nodeValue); }
      else if (n.tagName === 'BR') out.push('\n');
      else if (!isHardSkip(n)) collectText(n, out, 0);
    }
    return out.join('');
  }

  /*
   * 横向排列的 flex/grid「UI 条」：导航条、工具栏、带图标的品牌名等。
   * 其内容都是短标签，且插入块级译文会变成新的 flex item 打乱整行布局，
   * 因此整条跳过（纵向排列的 flex 容器不受影响，插入新块是安全的）。
   */
  function isUiStrip(cs, text) {
    if (!cs) return false;
    const d = cs.display || '';
    if (d.indexOf('flex') < 0 && d.indexOf('grid') < 0) return false;
    const dir = cs.flexDirection || 'row';
    if (dir.indexOf('column') === 0) return false;
    return U.visualLength(text) < 40;
  }

  function pushUnit(ctx, el, text, kind, anchorNode) {
    if (ctx.units.length >= MAX_UNITS) return;
    const norm = U.normalizeText(text);
    if (!U.isTranslatable(norm, ctx.settings)) return;
    ctx.seq++;
    ctx.units.push({
      id: ctx.seq,
      seq: ctx.seq,
      el: el,
      text: norm,
      kind: kind,                       // 'full' | 'partial'
      anchorNode: anchorNode || null,
      unit: true
    });
  }

  function walk(el, ctx, depth, selfStyle) {
    if (depth > MAX_DEPTH || ctx.units.length >= MAX_UNITS) return;
    if (isHardSkip(el)) return;
    // 行内代码用元素一旦被 CSS 变成块级容器（例如 div > code{display:block}），
    // 整块都是代码，必须跳过；而行内的 <code> 仍会作为句子的一部分参与翻译。
    if (INLINE_SOFT_SKIP.has(el.tagName)) return;

    const inlineNodes = [];
    const blockKids = [];
    const blockStyles = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { if (n.nodeValue && n.nodeValue.trim()) inlineNodes.push(n); continue; }
      if (n.nodeType !== 1) continue;
      if (isHardSkip(n)) continue;
      if (!isVisible(n)) continue;
      const cs = getComputedStyle(n);
      if (isBlockish(n, cs)) { blockKids.push(n); blockStyles.push(cs); }
      else inlineNodes.push(n);
    }

    if (!blockKids.length) {
      // 叶子块：整段文本就是一个翻译单元
      const text = inlineTextOf(el);
      if (!isUiStrip(selfStyle, text)) pushUnit(ctx, el, text, 'full', null);
      return;
    }

    // 混合元素：行内部分单独成单元，插入在最后一个行内节点之后
    if (inlineNodes.length) {
      const text = inlineTextOfNodes(inlineNodes);
      if (!isUiStrip(selfStyle, text)) {
        pushUnit(ctx, el, text, 'partial', inlineNodes[inlineNodes.length - 1]);
      }
    }
    for (let i = 0; i < blockKids.length; i++) walk(blockKids[i], ctx, depth + 1, blockStyles[i]);
  }

  function collect(root, settings) {
    const ctx = { units: [], settings: settings || NS.DEFAULT_SETTINGS, seq: 0 };
    const start = root || document.body;
    if (!start) return [];
    let rootStyle = null;
    try { rootStyle = getComputedStyle(start); } catch (e) {}
    walk(start, ctx, 0, rootStyle);
    return ctx.units;
  }

  /* 视口优先：先把用户看得见的内容翻出来 */
  function byViewportPriority(units, win) {
    const w = win || window;
    const vh = w.innerHeight || 800;
    const scrollY = w.scrollY || 0;
    const top = scrollY - vh * 0.35;
    const bottom = scrollY + vh * 1.4;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      let y = Number.MAX_SAFE_INTEGER;
      if (u.isTitle) y = -1;
      else if (u.el && u.el.isConnected) {
        try { y = u.el.getBoundingClientRect().top + scrollY; } catch (e) { y = Number.MAX_SAFE_INTEGER; }
      }
      u.absTop = y;
      u.inView = y >= top && y <= bottom;
    }
    const idx = units.map(function (u, i) { return i; });
    idx.sort(function (a, b) {
      const ua = units[a], ub = units[b];
      if (ua.inView !== ub.inView) return ua.inView ? -1 : 1;
      if (ua.inView && ub.inView) return ua.absTop - ub.absTop;
      return a - b;                       // 其余保持文档顺序
    });
    return idx.map(function (i) { return units[i]; });
  }

  NS.Extractor = {
    collect: collect,
    byViewportPriority: byViewportPriority,
    isHardSkip: isHardSkip,
    isVisible: isVisible,
    isBlockish: isBlockish
  };
})();
