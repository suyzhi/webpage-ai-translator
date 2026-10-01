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

  const SKIP_CLASS_RE = /(^|[-_\s])(wpt-translation|wpt-ignore|hljs|highlight|monaco-editor|CodeMirror|cm-editor|ace_editor|katex|MathJax|mwe-math-element|blob-code|linenumber)([-_\s]|$)/i;
  const OPT_OUT_CLASS_RE = /(^|[-_\s])(notranslate|no-?translate|skiptranslate)([-_\s]|$)/i;
  const SKIP_ID_RE = /^wpt-/i;
  const OPT_OUT_ID_RE = /^(?:notranslate|no-?translate)/i;
  const APP_SHELL_BLOCKS = 'p,li,h1,h2,h3,h4,article,section,blockquote,[role="article"]';
  const optOutCache = new WeakMap();

  /*
   * 页面声明「不要翻译」（translate="no" / class="notranslate"）：
   * 对具体元素（代码、人名、某一段）照常尊重；但 React/Vue 应用常把它挂在整个应用根节点上，
   * 目的只是阻止浏览器自带翻译改写 DOM —— 此时整页都会被跳过（如 Mastodon）。
   * 因此对「装着整页段落的外壳容器」忽略该声明，其内部更具体的声明仍然生效。
   */
  function optsOut(el) {
    const cls = el.className;
    const flagged = (el.getAttribute && el.getAttribute('translate') === 'no') ||
      (typeof cls === 'string' && cls && OPT_OUT_CLASS_RE.test(cls)) ||
      (typeof el.id === 'string' && el.id && OPT_OUT_ID_RE.test(el.id));
    if (!flagged) return false;
    let v = optOutCache.get(el);
    if (v === undefined) {
      const shell = el === document.body || el === document.documentElement ||
        ((el.textContent || '').length > 600 && !!el.querySelectorAll && el.querySelectorAll(APP_SHELL_BLOCKS).length >= 3);
      v = !shell;
      optOutCache.set(el, v);
    }
    return v;
  }

  const TABLE_STRUCT = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'UL', 'OL', 'DL', 'SELECT', 'MENU']);
  const CELL_LIKE = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'CAPTION', 'SUMMARY', 'FIGCAPTION']);

  const MAX_UNITS = 5000;
  const MAX_DEPTH = 80;
  const INLINE_BLOCK_MIN_TEXT = 20;   // 视觉长度阈值（约 10 个汉字 / 20 个西文字符）

  function isHardSkip(el) {
    const tag = el.tagName;
    if (HARD_SKIP_TAGS.has(tag)) return true;
    if (el.hasAttribute && el.hasAttribute('data-wpt')) return true;
    if (el.isContentEditable) return true;
    if (optsOut(el)) return true;
    const cls = el.className;
    if (typeof cls === 'string' && cls && SKIP_CLASS_RE.test(cls)) return true;
    const id = el.id;
    if (typeof id === 'string' && id && SKIP_ID_RE.test(id)) return true;
    return false;
  }

  function isVisible(el) {
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    // 虚拟列表的离屏占位（如 Mastodon：固定高度 + overflow:hidden + opacity:0，内部是原始 HTML 文本）。
    // 需要「透明」且「裁切或 aria-hidden」同时成立 —— 单独的 opacity:0 可能是滚动入场动画的初始状态。
    try {
      const cs = getComputedStyle(el);
      if (cs.opacity === '0' && (cs.overflow === 'hidden' || cs.overflow === 'clip' ||
          (el.getAttribute && el.getAttribute('aria-hidden') === 'true'))) return false;
    } catch (e) { /* 继续 */ }
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ visibilityProperty: true }); } catch (e) { /* 继续降级 */ }
    }
    return el.getClientRects().length > 0;
  }

  function isBlockish(el, cs) {
    const d = cs.display;
    // display:contents 的包装层自身不产生盒子，按容器处理（向内遍历），否则会把里面的按钮、段落拼成一句
    if (d === 'contents') return el.childElementCount > 0;
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
  /*
   * 相邻的两个「独立」行内元素（链接、按钮、inline-block 徽章）之间没有空白时补一个空格：
   * 页脚链接、标签列表在视觉上靠 CSS 间距 / 伪元素分隔，直接拼接会变成「AboutStatusPrivacy」。
   * 普通 <span> 之间不补（它们可能是被高亮拆开的同一个单词）。
   */
  const SEPARATE_TAGS = new Set(['A', 'BUTTON', 'LABEL', 'IMG']);
  function separate(el) {
    if (SEPARATE_TAGS.has(el.tagName)) return true;
    try { return getComputedStyle(el).display !== 'inline'; } catch (e) { return false; }
  }
  function pushGap(out, prev, n) {
    if (!prev || prev.nodeType !== 1 || !(separate(prev) || separate(n))) return;
    const last = out.length ? out[out.length - 1] : '';
    if (last && !/\s$/.test(last)) out.push(' ');
  }

  function collectText(node, out, depth) {
    let prev = null;
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        if (n.nodeValue) { out.push(n.nodeValue); prev = n; }
        continue;
      }
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'BR') { out.push('\n'); prev = n; continue; }
      if (isHardSkip(n)) continue;
      if (depth < 40 && !isVisible(n)) continue;
      pushGap(out, prev, n);
      collectText(n, out, depth + 1);
      prev = n;
    }
    return out;
  }

  function inlineTextOf(node) {
    return collectText(node, [], 0).join('');
  }

  function inlineTextOfNodes(nodes) {
    const out = [];
    let prev = null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3) { if (n.nodeValue) out.push(n.nodeValue); }
      else if (n.tagName === 'BR') out.push('\n');
      else if (!isHardSkip(n)) { pushGap(out, prev, n); collectText(n, out, 0); }
      prev = n;
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

  /*
   * 控件组：<p><button>Accept all</button> <button>Manage</button></p> 这类只由短按钮 / 短链接
   * 组成的块。整块合成一句会把几个标签拼成一段怪文，还会让仅译文模式丢掉按钮外观；
   * 因此每个控件单独成单元，译文随后以行内方式放进控件自身。
   */
  const CONTROL_TAGS = new Set(['BUTTON', 'A', 'LABEL']);
  function controlGroup(el) { return controlGroupOf(el.childNodes, 2); }

  function controlGroupOf(list, min) {
    const kids = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.nodeType === 3) { if (/[\p{L}\p{N}]/u.test(n.nodeValue || '')) return null; continue; }
      if (n.nodeType !== 1 || isHardSkip(n) || !isVisible(n)) continue;
      if (n.tagName === 'BR') continue;
      let ok = CONTROL_TAGS.has(n.tagName);
      if (!ok) {
        const d = getComputedStyle(n).display;
        ok = d === 'inline-block' || d === 'inline-flex';
      }
      if (!ok || U.visualLength(n.textContent) > 28) return null;
      kids.push(n);
    }
    return kids.length >= min ? kids : null;
  }

  /*
   * 短按钮（关注 / 点赞 / 接受 等界面控件）不翻译：用户一看就懂，
   * 而行内追加译文会把按钮撑宽、挤压旁边的用户名等内容。长文本按钮（如整句的提示条）照常翻译。
   */
  const BUTTON_CLASS_RE = /(^|[\s_-])(btn|button)([\s_-]|$)/i;
  const CONTROL_ROLES = new Set(['button', 'tab', 'menuitem', 'switch', 'checkbox', 'radio', 'option']);
  function isShortControl(el, text) {
    if (!el || el.nodeType !== 1) return false;
    // 文字可能包在按钮内部的 div/span 里（React Native Web、各类组件库），所以向上找最近的控件
    let ctl = null;
    for (let c = el, d = 0; c && d < 5; c = c.parentElement, d++) {
      const role = c.getAttribute && c.getAttribute('role');
      const cls = typeof c.className === 'string' ? c.className : '';
      if (c.tagName === 'BUTTON' || (role && CONTROL_ROLES.has(role)) ||
          (c.tagName === 'A' && BUTTON_CLASS_RE.test(cls))) { ctl = c; break; }   // <a class="button"> 样式的按钮
    }
    if (!ctl) return false;
    return U.visualLength(ctl.textContent || text) <= 28;
  }

  const HTML_LIKE_RE = /<\/?[a-z][a-z0-9-]*[\s>\/]/i;
  const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

  function pushUnit(ctx, el, text, kind, anchorNode, nodes) {
    if (ctx.units.length >= MAX_UNITS) return;
    const norm = U.normalizeText(text);
    if (!U.isTranslatable(norm, ctx.settings, true)) return;
    if (kind === 'full' && isShortControl(el, norm)) return;
    // 兜底：看起来是序列化的 HTML（虚拟列表占位、隐藏的无障碍副本）绝不送去翻译
    if (HTML_LIKE_RE.test(norm) && (norm.match(HTML_TAG_RE) || []).length >= 3) return;
    ctx.seq++;
    ctx.units.push({
      id: ctx.seq,
      seq: ctx.seq,
      el: el,
      text: norm,
      kind: kind,                       // 'full' | 'partial'
      anchorNode: anchorNode || null,
      nodes: nodes || null,             // 'partial' 单元的行内节点（仅译文模式隐藏原文时用）
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
      if (isUiStrip(selfStyle, text)) return;
      const group = controlGroup(el);
      if (group) {
        for (let i = 0; i < group.length; i++) pushUnit(ctx, group[i], inlineTextOf(group[i]), 'full', null);
        return;
      }
      pushUnit(ctx, el, text, 'full', null);
      return;
    }

    // 混合元素：行内部分单独成单元，插入在最后一个行内节点之后
    if (inlineNodes.length) {
      const text = inlineTextOfNodes(inlineNodes);
      // 段落之后跟着一排按钮 / 链接（如「创建账号」「登录」）：逐个控件处理，不拼成一句
      const group = controlGroupOf(inlineNodes, 1);
      if (group) {
        for (let i = 0; i < group.length; i++) pushUnit(ctx, group[i], inlineTextOf(group[i]), 'full', null);
      } else if (!isUiStrip(selfStyle, text)) {
        pushUnit(ctx, el, text, 'partial', inlineNodes[inlineNodes.length - 1], inlineNodes);
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

  /* 节点及其祖先是否真的显示在页面上（增量扫描的起点可能位于隐藏的占位容器内部） */
  function isRendered(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      try { if (!el.checkVisibility({ visibilityProperty: true })) return false; } catch (e) { /* 忽略 */ }
    }
    for (let c = el, d = 0; c && c !== document.body && d < 60; c = c.parentElement, d++) {
      if (!isVisible(c)) return false;
    }
    return true;
  }

  NS.Extractor = {
    isRendered: isRendered,
    collect: collect,
    byViewportPriority: byViewportPriority,
    isHardSkip: isHardSkip,
    isVisible: isVisible,
    isBlockish: isBlockish
  };
})();
