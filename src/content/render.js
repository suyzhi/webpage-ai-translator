/*
 * 译文渲染：
 *   - 字体、字号、字重、行高、颜色、对齐方式等排版属性全部从原文元素 computed style 复制，
 *     保证译文与原文视觉完全一致；
 *   - 译文以块级元素插入到原文段落正下方；
 *   - 插入位置自适应：flex/grid 容器、列表、表格、单元格都有对应策略，不破坏原布局。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Renderer) return;

  const TABLE_STRUCT = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'UL', 'OL', 'DL', 'SELECT', 'MENU']);
  const CELL_LIKE = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'CAPTION', 'SUMMARY']);

  /* 译文与原文视觉一致：逐条复制排版属性 */
  function copyTypography(src, dst) {
    let cs;
    try { cs = getComputedStyle(src); } catch (e) { return; }
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
    s.unicodeBidi = 'isolate';
    s.textShadow = cs.textShadow === 'none' ? 'none' : cs.textShadow;
  }

  function applyMark(node, style) {
    switch (style) {
      case 'underline':
        node.style.textDecorationLine = 'underline';
        node.style.textDecorationColor = 'rgba(99,102,241,0.45)';
        node.style.textDecorationThickness = '1px';
        node.style.textUnderlineOffset = '3px';
        break;
      case 'border':
        node.style.borderLeft = '3px solid rgba(99,102,241,0.55)';
        node.style.paddingLeft = '0.6em';
        break;
      case 'background':
        node.style.backgroundColor = 'rgba(99,102,241,0.08)';
        node.style.borderRadius = '4px';
        node.style.padding = '0.15em 0.4em';
        break;
      default:
        break;
    }
  }

  /*
   * 插入位置策略：
   *  - 源元素自身是 flex/grid 容器 -> 作为兄弟节点插到它后面（不能塞进去当 flex item）
   *  - 父级是 ul/ol/dl/table 等结构化容器 -> 追加到源元素内部
   *  - 源元素是 li/td/th 等 -> 追加到内部
   *  - 父级是 flex/grid -> 追加到源元素内部（否则会多出一个 flex item）
   *  - 其余 -> 作为兄弟节点紧随其后，视觉上正好在原文段落下方
   */
  const RIGID_STRUCT = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'SELECT']);

  function chooseInsertMode(el, forceSibling) {
    const parent0 = el.parentElement;
    if (!parent0) return 'end';

    // 「仅译文」模式希望译文独立于原文之外，以便安全地隐藏原文：
    // 表格/单元格/列表项这类刚性结构仍然只能追加到内部。
    if (forceSibling) {
      if (RIGID_STRUCT.has(parent0.tagName)) return 'end';
      if (CELL_LIKE.has(el.tagName)) return 'end';
      return 'sibling';
    }

    let cs = null, pcs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    const disp = cs ? cs.display : '';
    if (/flex|grid/.test(disp)) return 'sibling';
    if (TABLE_STRUCT.has(parent0.tagName)) return 'end';
    if (CELL_LIKE.has(el.tagName)) return 'end';
    try { pcs = getComputedStyle(parent0); } catch (e) {}
    if (pcs && /flex|grid/.test(pcs.display)) return 'end';
    return 'sibling';
  }

  function create(srcEl, text, settings) {
    const node = document.createElement('span');
    node.className = 'wpt-translation';
    node.setAttribute('data-wpt', '1');
    node.setAttribute('dir', 'auto');
    const s = node.style;
    s.display = 'block';
    s.margin = '0.3em 0 0 0';
    s.padding = '0';
    s.border = '0';
    s.backgroundColor = 'transparent';
    s.boxSizing = 'border-box';
    s.maxWidth = '100%';
    s.whiteSpace = 'pre-wrap';
    s.overflowWrap = 'break-word';
    s.wordBreak = 'break-word';
    if (srcEl) copyTypography(srcEl, node);
    applyMark(node, settings ? settings.markStyle : 'none');
    node.textContent = text;
    return node;
  }

  /* 返回实际使用的插入方式：'anchor' | 'sibling' | 'end'，失败返回 null */
  function insert(node, unit, forceSibling) {
    const el = unit.el;
    if (!el || !el.isConnected) return null;
    if (unit.anchorNode && unit.anchorNode.parentNode) {
      unit.anchorNode.parentNode.insertBefore(node, unit.anchorNode.nextSibling);
      return 'anchor';
    }
    if (unit.kind === 'partial') {
      el.appendChild(node);
      return 'end';
    }
    const mode = chooseInsertMode(el, forceSibling);
    if (mode === 'end') {
      el.appendChild(node);
      return 'end';
    }
    const parent = el.parentNode;
    if (!parent) return null;
    parent.insertBefore(node, el.nextSibling);
    return 'sibling';
  }

  function animate(node) {
    if (!node || typeof node.animate !== 'function') return;
    try {
      node.animate(
        [{ opacity: 0, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 200, easing: 'ease-out' }
      );
    } catch (e) {}
  }

  NS.Renderer = {
    create: create,
    insert: insert,
    animate: animate,
    copyTypography: copyTypography,
    chooseInsertMode: chooseInsertMode
  };
})();
