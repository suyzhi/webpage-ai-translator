/*
 * 译文渲染 —— 目标是「像网页自己写出来的」，而不是贴上去的：
 *
 *   1. 默认把译文放进原文元素内部末尾（inside）。译文因此天然继承原文的字体、颜色、对齐、
 *      缩进，并位于原文的内边距 / 边框 / 背景之内（引用块竖线、卡片、提示框都能包住译文），
 *      段落间距也完全保持原样 —— 不会出现「译文贴着下一段」的错位感。
 *   2. 横向 flex/grid 容器：放进承载主要文本的子元素；找不到才退到容器之后（sibling），
 *      此时复制排版属性并用负 margin 抵消原文的下边距，让译文紧跟原文、间距仍归还给下一段。
 *   3. 横排导航 / 按钮 / 标签等短文本：行内（inline）追加，保持行高，不撑破固定高度的导航栏。
 *   4. 标记样式基于 currentColor 派生，自动适配网站配色与深色模式。
 *   5. 「仅译文」模式同样放在内部，并隐藏原文节点（可完整还原），列表、表格也生效。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Renderer) return;

  const TAG = 'wpt-t';
  const RIGID_PARENT = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'SELECT', 'UL', 'OL', 'DL', 'MENU']);
  const SHORT_TEXT = 28;                     // 视觉长度（CJK 记 2）不超过该值视为短标签

  function css(el) {
    try { return getComputedStyle(el); } catch (e) { return null; }
  }

  function visualLength(text) {
    const U = NS.util;
    return U && U.visualLength ? U.visualLength(text) : String(text || '').length;
  }

  /* 子元素按行排布：flex 行方向，或多列 grid */
  function isRowFlow(cs) {
    if (!cs) return false;
    const d = cs.display || '';
    if (d.indexOf('flex') >= 0) return String(cs.flexDirection || 'row').indexOf('column') !== 0;
    if (d.indexOf('grid') >= 0) {
      const cols = String(cs.gridTemplateColumns || 'none').trim();
      return cols !== 'none' && cols.split(/\s+/).length > 1;
    }
    return false;
  }

  /* 位于横向导航条内：nav / 导航类 role，且整条不高（纵向侧栏导航很高，不算） */
  const NAV_SEL = 'nav,[role="navigation"],[role="menubar"],[role="tablist"]';
  const NAV_MAX_HEIGHT = 120;
  function inHorizontalNav(el) {
    const nav = el.closest ? el.closest(NAV_SEL) : null;
    if (!nav) return false;
    const h = nav.getBoundingClientRect().height;
    return h > 0 && h <= NAV_MAX_HEIGHT;
  }

  /*
   * 导航条里的行内译文是否「放不下」：被挤到下一行（原文是单行、译文却从原文下方开始），
   * 或者撑出容器被截。
   */
  function navMisfit(node, src) {
    const rects = node.getClientRects();
    if (!rects.length) return false;
    // 以原文第一个文字节点的首行为准（图标、徽章的盒子高度与文字不同，不能拿来比）
    const walker = document.createTreeWalker(src, NodeFilter.SHOW_TEXT, {
      acceptNode: function (t) { return !node.contains(t) && t.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    const first = walker.nextNode();
    if (!first) return false;
    const range = document.createRange();
    range.selectNodeContents(first);
    const line = range.getClientRects()[0];
    if (!line) return false;
    // 必须与原文首行同一行：换到下面、或被绝对定位的下拉层等挤到上面，都算放不下
    return rects[rects.length - 1].bottom > line.bottom + 2 || rects[0].top < line.top - 2 || isClipped(node, src);
  }

  function isClamped(cs) {
    if (!cs) return false;
    const c = cs.webkitLineClamp || cs.WebkitLineClamp;
    return !!c && c !== 'none';
  }

  function isOurs(n) {
    return n && n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-wpt');
  }

  /*
   * 文字真正的样式来源：沿着「承载大部分文字」的子元素向下找。
   * 例：<td><span class="titleline"><a>标题</a><span class="site">(域名)</span></span></td>
   * 视觉主体是 <a> 的黑色标题，而不是外层的灰色 —— 译文应当像标题，而不是像旁注。
   */
  function typographySource(el) {
    let cur = el;
    for (let depth = 0; depth < 4; depth++) {
      const total = visualLength(cur.textContent);
      if (!total) return cur;
      let direct = 0, best = null, bestLen = 0;
      const kids = cur.childNodes || [];
      for (let i = 0; i < kids.length; i++) {
        const n = kids[i];
        if (n.nodeType === 3) { direct += visualLength(n.nodeValue && n.nodeValue.trim()); continue; }
        if (n.nodeType !== 1 || isOurs(n)) continue;
        const len = visualLength(n.textContent);
        if (len > bestLen) { best = n; bestLen = len; }
      }
      if (!best || direct > total * 0.4 || bestLen < total * 0.6) return cur;
      cur = best;
    }
    return cur;
  }

  /* 横排容器里承载主要文本（≥60%）的子元素 */
  function dominantChild(el, text) {
    const total = visualLength(text);
    if (!total) return null;
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (isOurs(k)) continue;
      if (visualLength(k.textContent) >= total * 0.6) return k;
    }
    return null;
  }

  /*
   * 决定译文放在哪里、怎么放（只读，不写 DOM）。
   * 返回 { mode: 'end' | 'anchor' | 'inline' | 'sibling', target, typo }
   *   target —— end/inline：追加到其内部；anchor：插在 unit.anchorNode 之后；sibling：插在其后
   *   typo   —— 需要显式复制排版属性的来源元素；null 表示直接继承
   */
  function plan(unit, onlyTranslation) {
    const el = unit.el;
    const text = unit.text || '';
    const short = text.indexOf('\n') < 0 && visualLength(text) <= SHORT_TEXT;
    if (unit.kind === 'partial') {
      const a = unit.anchorNode;
      // 夹在块之间的一小段行内文字（标签、徽章）：译文紧跟在同一行，不单独占一行
      return { mode: a && a.parentNode === el ? 'anchor' : 'end', target: el, typo: null, only: !!onlyTranslation,
        inline: short && !onlyTranslation };
    }
    const cs = css(el);
    const parent = el.parentElement;
    const pcs = parent ? css(parent) : null;

    // 横排导航 / 按钮 / 标签：行内追加，保持原有行高
    // 横向导航条里的短标签（下拉按钮、带图标的菜单项）：块级译文会错位成单独一行，一律行内；
    // nav 标记交给内容脚本在渲染后复查，不在同一行或被截就撤掉，宁缺毋乱
    const nav = short && !onlyTranslation && inHorizontalNav(el);
    if (short && (nav || isRowFlow(pcs) || (cs && (cs.whiteSpace === 'nowrap' || /^inline/.test(cs.display || ''))))) {
      return { mode: 'inline', target: el, typo: null, only: !!onlyTranslation, nav: nav };
    }
    // 文字在一个行内块（按钮、下拉触发器、胶囊标签）里：译文跟在它右边，而不是掉到下一行
    if (short && !onlyTranslation) {
      const dom = dominantChild(el, text);
      const dcs = dom ? css(dom) : null;
      if (dcs && /^inline-(block|flex|grid)$/.test(dcs.display)) return { mode: 'inline', target: el, typo: null, only: false };
    }
    const src = typographySource(el);
    const inner = src !== el ? src : null;
    if (onlyTranslation) return { mode: 'end', target: el, typo: inner, only: true };

    if (isRowFlow(cs)) {
      const dom = dominantChild(el, text);
      if (dom) return { mode: 'end', target: dom, typo: null };
      if (parent && RIGID_PARENT.has(parent.tagName)) return { mode: 'end', target: el, typo: inner };
      return { mode: 'sibling', target: el, typo: src };
    }
    if (isClamped(cs) && parent && !RIGID_PARENT.has(parent.tagName)) {
      return { mode: 'sibling', target: el, typo: src };
    }
    return { mode: 'end', target: el, typo: inner };
  }

  /* 旧接口：返回 'end' | 'sibling'（'anchor'/'inline' 归入 'end'） */
  function chooseInsertMode(el, forceSibling, unit) {
    const p = plan(unit || { el: el, kind: 'full', text: el.textContent || '' }, !!forceSibling);
    return p.mode === 'sibling' ? 'sibling' : 'end';
  }

  /* 从原文复制排版属性（仅在译文无法继承时使用） */
  function copyTypography(src, dst) {
    const cs = css(src);
    if (!cs) return;
    const s = dst.style;
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontWeight = cs.fontWeight;
    s.fontStyle = cs.fontStyle;
    s.fontVariant = cs.fontVariant;
    s.fontStretch = cs.fontStretch;
    s.fontFeatureSettings = cs.fontFeatureSettings;
    s.lineHeight = cs.lineHeight;
    s.letterSpacing = cs.letterSpacing;
    s.wordSpacing = cs.wordSpacing;
    s.textTransform = cs.textTransform;
    s.textIndent = cs.textIndent;
    s.color = cs.color;
    s.textAlign = cs.textAlign;
    s.direction = cs.direction;
    s.textShadow = cs.textShadow === 'none' ? 'none' : cs.textShadow;
  }

  /* 标记样式：全部由 currentColor 派生，跟随网站配色 / 深色模式 */
  function applyMark(node, style, inline) {
    const s = node.style;
    switch (style) {
      case 'underline':
        s.textDecorationLine = 'underline';
        s.textDecorationStyle = 'dashed';
        s.textDecorationColor = 'color-mix(in srgb, currentColor 38%, transparent)';
        s.textDecorationThickness = '1px';
        s.textUnderlineOffset = '0.28em';
        break;
      case 'border':
        s.borderInlineStart = '2px solid color-mix(in srgb, currentColor 28%, transparent)';
        s.paddingInlineStart = inline ? '0.4em' : '0.75em';
        break;
      case 'background':
        s.backgroundColor = 'color-mix(in srgb, currentColor 7%, transparent)';
        s.borderRadius = '0.3em';
        s.padding = inline ? '0 0.3em' : '0.2em 0.45em';
        s.boxDecorationBreak = 'clone';
        s.webkitBoxDecorationBreak = 'clone';
        break;
      case 'dim':
        s.opacity = '0.72';
        break;
      default:
        break;
    }
  }

  /*
   * 创建译文节点。p 为 plan() 结果；缺省时按「独立块 + 复制排版」处理（兼容旧调用）。
   */
  function create(srcEl, text, settings, p) {
    const pl = p || { mode: 'sibling', target: srcEl, typo: srcEl };
    const inline = pl.mode === 'inline' || !!pl.inline;
    const node = document.createElement(TAG);
    node.className = 'wpt-translation';
    node.setAttribute('data-wpt', '1');
    node.setAttribute('dir', 'auto');
    node.setAttribute('translate', 'no');
    if (settings && settings.targetLang) node.setAttribute('lang', settings.targetLang);
    const s = node.style;
    s.display = inline ? 'inline' : 'block';
    // 仅译文：原文已隐藏，译文独占位置，不再需要与原文之间的间隔
    s.margin = pl.only ? '0' : inline ? '0 0 0 0.4em' : '0.25em 0 0 0';
    s.padding = '0';
    s.border = '0';
    s.backgroundColor = 'transparent';
    s.boxSizing = 'border-box';
    s.maxWidth = '100%';
    s.whiteSpace = inline ? 'normal' : 'pre-wrap';
    s.overflowWrap = 'break-word';
    s.wordBreak = 'break-word';
    s.unicodeBidi = 'isolate';
    s.float = 'none';
    s.position = 'static';
    if (pl.typo) copyTypography(pl.typo, node);
    if (pl.mode === 'sibling' && pl.target) {
      // 译文在原文之外：用负 margin 抵消原文下边距（折叠或不折叠结果相同），再把下边距还给下一段
      const cs = css(pl.target);
      const mb = cs && cs.marginBottom && cs.marginBottom !== 'auto' ? cs.marginBottom : '0px';
      s.marginTop = 'calc(0.25em - ' + mb + ')';
      s.marginBottom = mb;
    }
    if (pl.lines) {
      s.display = '-webkit-box';
      s.webkitBoxOrient = 'vertical';
      s.webkitLineClamp = String(pl.lines);
      s.overflow = 'hidden';
    }
    applyMark(node, settings ? settings.markStyle : 'none', inline);
    node.textContent = text;
    return node;
  }

  /*
   * 插入译文。第三个参数可以是 plan() 结果，也可以是布尔值 forceSibling（旧接口）。
   * 返回实际使用的方式：'anchor' | 'end' | 'inline' | 'sibling'，失败返回 null。
   */
  function insert(node, unit, p) {
    const el = unit.el;
    if (!el || !el.isConnected) return null;
    const pl = p && typeof p === 'object' ? p : plan(unit, !!p);
    if (pl.mode === 'anchor') {
      const a = unit.anchorNode;
      if (a && a.parentNode) { inheritSlot(node, a); a.parentNode.insertBefore(node, a.nextSibling); return 'anchor'; }
      el.appendChild(node);
      return 'end';
    }
    const target = pl.target && pl.target.isConnected !== false ? pl.target : el;
    if (pl.mode === 'sibling') {
      const parent = target.parentNode;
      if (!parent) return null;
      inheritSlot(node, target);
      // 同一容器里多段都放到容器之后：排在已放过去的译文后面，保持阅读顺序
      let ref = target.nextSibling;
      if (pl.stack) while (ref && isOurs(ref)) ref = ref.nextSibling;
      parent.insertBefore(node, ref);
      return 'sibling';
    }
    // 追加进影子宿主：宿主的子节点只有分配到 slot 才显示，跟随最后一个子元素进同一个 slot
    if (target.shadowRoot || (DOM_API && target.tagName.indexOf('-') > 0)) inheritSlot(node, lastLightChild(target));
    target.appendChild(node);
    return pl.mode === 'inline' ? 'inline' : 'end';
  }

  const DOM_API = globalThis.chrome && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function'
    ? chrome.dom.openOrClosedShadowRoot : null;
  function lastLightChild(el) {
    for (let c = el.lastElementChild; c; c = c.previousElementSibling) if (!isOurs(c)) return c;
    return null;
  }

  /* 原文是投影进具名 slot 的宿主子元素时，译文必须进同一个 slot，否则不会显示 */
  function inheritSlot(node, ref) {
    const slot = ref && ref.nodeType === 1 ? ref.getAttribute('slot') : null;
    if (slot) node.setAttribute('slot', slot);
  }

  /*
   * 译文是否「放不下」：原文在某个祖先的范围内，译文却超出该祖先底边。
   * 正常流里的块级子元素超出祖先，说明祖先高度是定死的——
   *   overflow 非 visible：译文被截掉（横向导航条、限高卡片）；
   *   overflow visible：译文溢出去压在后面的内容上（如维基百科横幅里定高的副标题）。
   * 原文本身也在范围之外的（可滚动侧栏里靠下的条目）只是需要滚动，不算。
   */
  function isClipped(node, src) {
    return !!clipBox(node, src);
  }

  /* 同上，返回让译文放不下的那个定高祖先 */
  function clipBox(node, src) {
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !src || !src.getBoundingClientRect) return null;
    const sr = src.getBoundingClientRect();
    let floating = false;
    for (let a = composedParent(node), d = 0; a && d < 12; a = composedParent(a), d++) {
      if (a === document.body || a === document.documentElement) break;
      const cs = css(a);
      if (!cs || cs.display === 'contents' || /^inline/.test(cs.display)) continue;
      // 浮层（绝对 / 固定定位）之外的祖先不随它撑高：只有真正裁切内容的才算
      if (floating && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (cs.position === 'absolute' && absLabelOverflow(a, cs, ar, node)) return a;
      if (sr.top >= ar.bottom - 2) return null;
      if (r.bottom > ar.bottom + 2) return a;
      if (cs.position === 'absolute' || cs.position === 'fixed') floating = true;
    }
    return null;
  }

  /*
   * 绝对定位的小标签（GitHub 贡献图的 Mon / Wed / Fri：贴在 11px 高的表格行上、bottom 锚定）：
   * 译文换行后标签向上或向下长出锚点格子、或在同一行向右伸出去，压到相邻的行和格子上；正常流里的溢出检查看不出来。
   * 只认「标签与锚点重叠、文字很短、去掉译文时并不超出」的情形，本来就比锚点大的下拉菜单、浮层卡片不受影响。
   */
  function absLabelOverflow(a, cs, ar, node) {
    const op = a.offsetParent;
    if (!op || op === document.body || visualLength(a.textContent) > SHORT_TEXT * 2) return false;
    const or = op.getBoundingClientRect();
    const tv = Math.max(4, (parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.3) / 2);
    const out = function (b) {
      return b.top < or.bottom - 2 && b.bottom > or.top + 2 &&
        (b.top < or.top - tv || b.bottom > or.bottom + tv || b.left < or.left - 4 || b.right > or.right + 4);
    };
    if (!out(ar)) return false;
    const prev = node.style.display;
    node.style.display = 'none';
    const before = a.getBoundingClientRect();
    node.style.display = prev;
    return !out(before);
  }

  /*
   * 长段落放不下（限高的摘要预览、line-clamp 卡片）：把译文放到定高容器之后，
   * 并截成与原文露出部分相同的行数 —— 读者看到的是「原文预览 + 译文预览」，而不是没有译文。
   * 只在容器像一块「预览」时这样做：不太高、文字不多、父元素按块排布（放进 flex/grid 行会多出一格）。
   */
  const PREVIEW_MAX_TEXT = 3000;
  const INTERACTIVE_SEL = 'a,button,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
  function afterClipPlan(unit, box, allowShort) {
    const el = unit.el;
    const text = unit.text || '';
    if (!allowShort && text.indexOf('\n') < 0 && visualLength(text) <= SHORT_TEXT) return null;     // 短标签先试行内
    const parent = box && composedParent(box);
    if (!parent || parent === document.documentElement || !el || !box.contains(el)) return null;
    // 链接、按钮里的短文案搬到外面就脱离了原来的可点区域，宁可不显示
    if (allowShort && (box.closest(INTERACTIVE_SEL) || el.closest(INTERACTIVE_SEL))) return null;
    if (RIGID_PARENT.has(parent.tagName) || isRowFlow(css(parent)) || inHorizontalNav(box)) return null;
    const bcs = css(box);
    if (bcs && (bcs.position === 'absolute' || bcs.position === 'fixed')) return null;   // 浮在别处的盒子，放其后会落到不相干的位置
    const br = box.getBoundingClientRect();
    if (br.height > Math.max(240, (globalThis.innerHeight || 800) * 0.5)) return null;
    if (visualLength(box.textContent) > PREVIEW_MAX_TEXT) return null;
    const src = typographySource(el);
    let lines = 0;
    if (bcs && !(bcs.overflowY === 'visible' && bcs.overflowX === 'visible')) {
      const scs = css(src);
      const fs = scs ? parseFloat(scs.fontSize) || 16 : 16;
      const lh = scs ? parseFloat(scs.lineHeight) || fs * 1.4 : fs * 1.4;
      const shown = br.bottom - el.getBoundingClientRect().top;
      lines = Math.max(2, Math.min(8, Math.round(shown / lh)));
    }
    return { mode: 'sibling', target: box, typo: src, only: false, stack: true, lines: lines };
  }

  function composedParent(n) {
    const p = n.parentNode;
    if (p && p.nodeType === 11 && p.host) return p.host;
    return p && p.nodeType === 1 ? p : null;
  }

  /* ---------------- 仅译文：隐藏 / 还原原文节点 ---------------- */
  function hideOriginal(unit, node) {
    const el = unit.el;
    if (!el) return null;
    const list = unit.kind === 'partial' && unit.nodes ? unit.nodes : Array.prototype.slice.call(el.childNodes);
    const saved = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!n || n === node || n.parentNode !== el) continue;
      if (n.nodeType === 3) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        saved.push([n, 't', n.nodeValue]);
        n.nodeValue = '';
      } else if (n.nodeType === 1 && !isOurs(n)) {
        saved.push([n, 'e', n.style.display]);
        n.style.display = 'none';
      }
    }
    return saved;
  }

  function showOriginal(saved) {
    if (!saved) return;
    for (let i = 0; i < saved.length; i++) {
      const n = saved[i][0];
      if (saved[i][1] === 't') {
        // 页面框架若已写入新文本，则不覆盖
        if (n.nodeValue === '') n.nodeValue = saved[i][2];
      } else {
        try { n.style.display = saved[i][2]; } catch (e) {}
      }
    }
  }

  /* ---------------- 动效 ---------------- */
  function reducedMotion() {
    try { return !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  /* 加载指示：一个跟随文字颜色的细圈，放在原文末尾，译文到达时原地替换 */
  function createLoader() {
    const n = document.createElement(TAG);
    n.className = 'wpt-loading';
    n.setAttribute('data-wpt', '1');
    n.setAttribute('aria-hidden', 'true');
    const s = n.style;
    s.display = 'inline-block';
    s.width = '0.72em';
    s.height = '0.72em';
    s.margin = '0 0 0 0.45em';
    s.padding = '0';
    s.verticalAlign = '-0.06em';
    s.border = '0.11em solid color-mix(in srgb, currentColor 22%, transparent)';
    s.borderTopColor = 'color-mix(in srgb, currentColor 70%, transparent)';
    s.borderRadius = '50%';
    s.boxSizing = 'border-box';
    s.opacity = '0';
    s.pointerEvents = 'none';
    if (typeof n.animate === 'function') {
      try {
        n.animate([{ opacity: 0 }, { opacity: 0.8 }], { duration: 260, delay: 120, fill: 'forwards', easing: 'ease-out' });
        if (!reducedMotion()) n.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: 850, iterations: Infinity });
      } catch (e) { s.opacity = '0.8'; }
    } else s.opacity = '0.8';
    return n;
  }

  function insertLoader(loader, unit, p) {
    if (!p || p.mode === 'sibling') return false;
    return !!insert(loader, unit, { mode: p.mode === 'anchor' ? 'anchor' : 'inline', target: p.target });
  }

  /* 入场：轻微上浮 + 淡入 + 去模糊；delay 用于同一批次内按阅读顺序错峰 */
  function animate(node, delay) {
    if (!node || typeof node.animate !== 'function' || reducedMotion()) return;
    try {
      node.animate(
        [
          { opacity: 0, transform: 'translateY(0.35em)', filter: 'blur(2px)' },
          { opacity: 1, transform: 'none', filter: 'none' }
        ],
        { duration: 380, delay: delay || 0, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' }
      );
    } catch (e) {}
  }

  NS.Renderer = {
    TAG: TAG,
    plan: plan,
    create: create,
    insert: insert,
    animate: animate,
    createLoader: createLoader,
    insertLoader: insertLoader,
    isClipped: isClipped,
    clipBox: clipBox,
    afterClipPlan: afterClipPlan,
    navMisfit: navMisfit,
    hideOriginal: hideOriginal,
    showOriginal: showOriginal,
    copyTypography: copyTypography,
    chooseInsertMode: chooseInsertMode,
    typographySource: typographySource,
    reducedMotion: reducedMotion
  };
})();
