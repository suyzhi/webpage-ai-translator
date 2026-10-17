/*
 * 覆盖率评测探针：在页面（每个 frame 的隔离世界）里运行，与 extract.js 一起注入。
 *
 * 基准（oracle）与抽取器相互独立：
 *   - 遍历组合树：普通子节点 + open shadowRoot；iframe 由评测脚本按 frame 分别测量；
 *   - 只收「用户真能看见」的文本节点：Range 有尺寸、元素 checkVisibility（含 opacity）通过；
 *   - 排除代码 / 输入控件 / 已是目标语言（中文）/ 作者明确声明不翻译的小块；
 *   - 权重 = 字母数（中日韩记 2，与 U.visualLength 口径一致）。
 * 覆盖 = 文本节点落在某个翻译单元里（full 单元的元素子树，或 partial 单元的行内节点）。
 * 未覆盖的部分按祖先链诊断原因，便于定位抽取器的盲区。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT;
  const EXCL = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'CODE', 'PRE',
    'KBD', 'SAMP', 'SVG', 'MATH', 'HEAD', 'TITLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED']);
  const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const KANA_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const HAN_G = /\p{Script=Han}/gu;
  const LETTER_G = /\p{L}/gu;
  const OPT_OUT_CLASS_RE = /(^|[-_\s])(notranslate|no-?translate|skiptranslate)([-_\s]|$)/i;
  const CONTROL_ROLES = new Set(['button', 'tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio', 'link']);
  const BODY_MIN = 40;          // 块级文本权重 ≥ 40 视为「正文」（约一句英文 / 20 个汉字）

  function weight(s) {
    let w = 0;
    for (const ch of s) if (/\p{L}/u.test(ch)) w += WIDE.test(ch) ? 2 : 1;
    return w;
  }

  function isTargetLang(s) {
    if (KANA_HANGUL.test(s)) return false;
    const letters = (s.match(LETTER_G) || []).length;
    if (!letters) return true;
    return (s.match(HAN_G) || []).length / letters >= 0.5;
  }

  const csCache = new Map();
  function cs(el) {
    let v = csCache.get(el);
    if (!v) { v = getComputedStyle(el); csCache.set(el, v); }
    return v;
  }
  const visCache = new Map();
  function visible(el) {
    let v = visCache.get(el);
    if (v === undefined) {
      try { v = el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (e) { v = el.getClientRects().length > 0; }
      visCache.set(el, v);
    }
    return v;
  }

  function lightParent(n) {
    const p = n.parentNode;
    return p && p.nodeType === 1 ? p : null;
  }
  function composedParent(n) {
    const p = n.parentNode;
    if (!p) return null;
    if (p.nodeType === 11 && p.host) return p.host;
    return p.nodeType === 1 ? p : null;
  }

  function blockOf(el) {
    for (let c = el; c; c = composedParent(c)) {
      const d = cs(c).display;
      if (d.indexOf('inline') !== 0 && d !== 'contents') return c;
    }
    return el;
  }

  function optedOut(el) {
    for (let c = el; c; c = composedParent(c)) {
      const cls = typeof c.className === 'string' ? c.className : '';
      if ((c.getAttribute('translate') === 'no' || OPT_OUT_CLASS_RE.test(cls)) &&
          (c.textContent || '').length <= 600) return true;
    }
    return false;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    if (cls) s += '.' + cls;
    const root = el.getRootNode();
    if (root && root.host) s = describe(root.host) + ' ▸shadow▸ ' + s;
    return s.slice(0, 120);
  }

  let diagDetail = '';           // diagnose 找到的具体祖先及其样式，便于定位规则误伤
  function diagnose(textNode, inShadow, frameCovered, units, capHit) {
    if (!frameCovered) return 'iframe';
    if (inShadow) return 'shadow-dom';
    const X = NS.Extractor;
    let depth = 0;
    let control = false;
    for (let a = lightParent(textNode); a && a !== document.documentElement; a = lightParent(a)) {
      depth++;
      if (a.tagName === 'DIALOG') return 'dialog';
      if (X.isHardSkip(a)) {
        if (a.getAttribute('translate') === 'no' || OPT_OUT_CLASS_RE.test(typeof a.className === 'string' ? a.className : '')) return 'opt-out-shell';
        if (a.isContentEditable) return 'contenteditable';
        return 'hard-skip:' + a.tagName.toLowerCase();
      }
      if (a !== document.body && !X.isVisible(a)) {
        const s = cs(a);
        diagDetail = describe(a) + ' {display:' + s.display + '; opacity:' + s.opacity + '; overflow:' + s.overflow +
          '; visibility:' + s.visibility + '; content-visibility:' + s.contentVisibility + '; rects:' + a.getClientRects().length + '}';
        return 'visibility-heuristic';
      }
      const role = a.getAttribute('role');
      if (a.tagName === 'BUTTON' || (role && CONTROL_ROLES.has(role))) control = true;
    }
    if (depth > 80) return 'depth-limit';
    if (capHit) return 'unit-cap';
    if (control) return 'short-control';
    return 'filtered-other';
  }

  function measure(opts) {
    const o = opts || {};
    const t0 = performance.now();
    const settings = NS.settings.forContent(NS.settings.normalize({ targetLang: 'zh-CN' }));
    const runExtractor = o.runExtractor !== false;

    // 1) 抽取器
    let units = [];
    let collectMs = 0;
    if (runExtractor && document.body) {
      const c0 = performance.now();
      units = NS.Extractor.collect(document.body, settings);
      collectMs = performance.now() - c0;
    }
    const fullSet = new Set();
    const nodeSet = new Set();
    for (const u of units) {
      if (u.kind === 'partial' && u.nodes) for (const n of u.nodes) nodeSet.add(n);
      else fullSet.add(u.el);
    }
    const capHit = units.length >= 5000;
    function covered(t) {
      if (nodeSet.has(t)) return true;
      // 沿组合树向上：行内宿主的影子文本并入了外层句子的单元
      for (let a = t.parentNode; a; a = a.parentNode) {
        if (a.nodeType === 11 && a.host) a = a.host;
        if (a.nodeType !== 1) break;
        if (fullSet.has(a) || nodeSet.has(a)) return true;
      }
      return false;
    }

    // 2) 基准遍历（组合树）
    const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
    const range = document.createRange();
    const blocks = new Map();     // block -> { w, cw, text, reasons: Map }
    let optOutW = 0;
    let shadowRoots = 0;
    const stack = document.body ? [[document.body, false]] : [];
    while (stack.length) {
      const [node, inShadow] = stack.pop();
      if (node.nodeType === 1) {
        if (EXCL.has(node.tagName)) continue;
        if (node.shadowRoot) {
          shadowRoots++;
          const kids = node.shadowRoot.childNodes;
          for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], true]);
        }
        const kids = node.childNodes;
        for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], inShadow]);
        continue;
      }
      if (node.nodeType !== 3) continue;
      const s = node.nodeValue;
      if (!s || !/\p{L}/u.test(s)) continue;
      const el = composedParent(node);
      if (!el || el.isContentEditable || !visible(el)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 4 || r.right + scrollX <= 0 || r.left + scrollX >= docW || r.bottom + scrollY <= 0) continue;
      if (isTargetLang(s)) continue;
      const w = weight(s);
      if (!w) continue;
      if (optedOut(el)) { optOutW += w; continue; }
      const blk = blockOf(el);
      let b = blocks.get(blk);
      if (!b) { b = { w: 0, cw: 0, text: '', reasons: new Map() }; blocks.set(blk, b); }
      b.w += w;
      if (b.text.length < 160) b.text += s.replace(/\s+/g, ' ');
      if (o.frameCovered !== false && covered(node)) b.cw += w;
      else {
        diagDetail = '';
        const why = diagnose(node, inShadow, o.frameCovered !== false, units, capHit);
        b.reasons.set(why, (b.reasons.get(why) || 0) + w);
        if (diagDetail) b.detail = diagDetail;
      }
    }

    // 3) 汇总
    const total = { all: 0, allC: 0, body: 0, bodyC: 0 };
    const reasons = {};
    for (const [blk, b] of blocks) {
      const isBody = b.w >= BODY_MIN;
      total.all += b.w; total.allC += b.cw;
      if (isBody) { total.body += b.w; total.bodyC += b.cw; }
      for (const [why, w] of b.reasons) {
        const r = reasons[why] || (reasons[why] = { w: 0, bodyW: 0, samples: [] });
        r.w += w;
        if (isBody) r.bodyW += w;
        r.samples.push({ w: w, where: describe(blk), text: b.text.trim().slice(0, 120), detail: b.detail });
      }
    }
    for (const k in reasons) {
      reasons[k].samples.sort(function (a, b) { return b.w - a.w; });
      reasons[k].samples = reasons[k].samples.slice(0, 4);
    }

    // 4) 单元质量
    const U = NS.util;
    let frag = 0, long = 0, junk = 0, chars = 0;
    for (const u of units) {
      const vl = U.visualLength(u.text);
      chars += u.text.length;
      if (vl < 8) frag++;
      if (u.text.length > 1500) long++;
      const letters = (u.text.match(LETTER_G) || []).length;
      if (letters / Math.max(1, u.text.length) < 0.3) junk++;
    }

    // 5) 属性文本（placeholder / alt / title / aria-label），目前抽取器不处理
    let attrs = 0;
    const attrEls = document.querySelectorAll('[placeholder],img[alt],[title],[aria-label]');
    for (let i = 0; i < attrEls.length && i < 3000; i++) {
      const el = attrEls[i];
      if (!visible(el)) continue;
      for (const name of ['placeholder', 'alt', 'title', 'aria-label']) {
        const v = el.getAttribute(name);
        if (v && weight(v) >= 4 && !isTargetLang(v)) { attrs++; break; }
      }
    }

    return {
      url: location.href,
      title: document.title,
      viewport: [innerWidth, innerHeight],
      units: units.length,
      unitChars: chars,
      collectMs: Math.round(collectMs * 10) / 10,
      measureMs: Math.round(performance.now() - t0),
      oracle: total,
      optOutW: optOutW,
      shadowRoots: shadowRoots,
      reasons: reasons,
      quality: { frag: frag, long: long, junk: junk },
      attrs: attrs,
      // 视口优先顺序的单元文本：供 tools/eval-cost.mjs 离线重放批量 / token 开销
      texts: o.dumpTexts ? NS.Extractor.byViewportPriority(units.slice()).map(function (u) { return u.text; }) : undefined
    };
  }

  globalThis.WPT_EVAL = { measure: measure };
})();
