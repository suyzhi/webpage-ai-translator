/*
 * 渲染与插入位置算法测试（用最小假 DOM 驱动，无需浏览器）
 * 这是「译文出现在原文下方且排版一致」这一核心承诺的直接验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 最小假 DOM ---------------- */
function el(tag, computed) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    parentNode: null,
    parentElement: null,
    childNodes: [],
    style: {},
    className: '',
    textContent: '',
    isConnected: true,
    attrs: {},
    _computed: computed || { display: 'block' },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      c.parentElement = this;
      return c;
    },
    insertBefore(c, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      c.parentElement = this;
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      c.parentElement = null;
      return c;
    }
  };
  Object.defineProperty(node, 'nextSibling', {
    get() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.childNodes.indexOf(this);
      return p.childNodes[i + 1] || null;
    }
  });
  Object.defineProperty(node, 'children', { get() { return this.childNodes.filter((c) => c.tagName); } });
  return node;
}

globalThis.document = {
  createElement: (tag) => el(tag),
  createTextNode: (t) => ({ nodeType: 3, nodeValue: t, parentNode: null })
};
globalThis.getComputedStyle = (node) => node._computed || { display: 'block' };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src/content/render.js'), 'utf8'), { filename: 'render.js' });
const R = globalThis.WPT.Renderer;

function attach(parent, child) { parent.appendChild(child); return child; }

/* ---------------- 插入位置决策 ---------------- */
const P = (text) => 'x'.repeat(0) + (text || 'A reasonably long paragraph of text that is clearly not a short label.');
const unitOf = (node, text) => ({ el: node, kind: 'full', text: P(text), anchorNode: null });
function txt(parent, t) { const n = document.createTextNode(t); parent.appendChild(n); return n; }

test('plan：普通段落 -> 放进原文内部末尾，直接继承排版（间距、边框、背景都归原文）', () => {
  const parent = el('div');
  const p = attach(parent, el('p'));
  txt(p, 'Hello world');
  const pl = R.plan(unitOf(p));
  assert.equal(pl.mode, 'end');
  assert.equal(pl.target, p);
  assert.equal(pl.typo, null, '同一元素内无需复制排版');
  assert.equal(R.chooseInsertMode(p), 'end');
});

test('plan：横排 flex 父级里的短标签（导航 / 按钮）-> 行内追加，不撑高导航栏', () => {
  const nav = el('nav', { display: 'flex', flexDirection: 'row' });
  const a = attach(nav, el('a', { display: 'block' }));
  assert.equal(R.plan(unitOf(a, 'Pricing')).mode, 'inline');
  // 纵向 flex 不算横排：仍然整块放在下方
  const col = el('div', { display: 'flex', flexDirection: 'column' });
  const b = attach(col, el('a', { display: 'block' }));
  assert.equal(R.plan(unitOf(b, 'Pricing')).mode, 'end');
  // 长文本即使在横排里也不走行内
  const c = attach(nav, el('p', { display: 'block' }));
  assert.equal(R.plan(unitOf(c)).mode, 'end');
});

test('plan：源元素自身横排且有承载主要文本的子元素 -> 放进该子元素', () => {
  const parent = el('div');
  const box = attach(parent, el('div', { display: 'flex', flexDirection: 'row' }));
  attach(box, el('i'));
  const span = attach(box, el('span'));
  span.textContent = P();
  const pl = R.plan(unitOf(box));
  assert.equal(pl.mode, 'end');
  assert.equal(pl.target, span);
});

test('plan：横排容器且无主体子元素 -> 兄弟节点 + 复制排版；刚性父级除外', () => {
  const parent = el('div');
  const box = attach(parent, el('div', { display: 'grid', gridTemplateColumns: '100px 200px' }));
  const a = attach(box, el('span')); a.textContent = 'left half of text';
  const b = attach(box, el('span')); b.textContent = 'right half of text';
  const pl = R.plan(unitOf(box, 'left half of text right half of text and more words'));
  assert.equal(pl.mode, 'sibling');
  assert.equal(pl.typo, box);
  assert.equal(R.chooseInsertMode(box), 'sibling');

  const ul = el('ul');
  const li = attach(ul, el('li', { display: 'flex', flexDirection: 'row' }));
  const x = attach(li, el('span')); x.textContent = 'first part of item';
  const y = attach(li, el('span')); y.textContent = 'second part of it';
  assert.equal(R.plan(unitOf(li, 'first part of item second part of it, long enough')).mode, 'end', 'ul 里不能插兄弟节点');
});

test('plan：多行截断（line-clamp）的元素 -> 放到外面，避免译文被裁掉', () => {
  const parent = el('div');
  const p = attach(parent, el('p', { display: '-webkit-box', webkitLineClamp: '2' }));
  assert.equal(R.plan(unitOf(p)).mode, 'sibling');
});

test('plan：仅译文模式始终放在内部（原文随后被隐藏），列表 / 表格同样适用', () => {
  const parent = el('div', { display: 'flex' });
  const p = attach(parent, el('p'));
  assert.equal(R.plan(unitOf(p), true).mode, 'end');
  const tr = el('tr');
  const td = attach(tr, el('td'));
  assert.equal(R.plan(unitOf(td), true).mode, 'end');
  const grid = attach(el('div'), el('div', { display: 'grid', gridTemplateColumns: '1fr 1fr' }));
  assert.equal(R.plan(unitOf(grid), true).mode, 'end');
});

test('plan：混合元素用锚点；锚点已被移走则追加到末尾', () => {
  const block = el('div');
  const a = attach(block, el('a'));
  assert.equal(R.plan({ el: block, kind: 'partial', anchorNode: a, text: 'x' }).mode, 'anchor');
  block.removeChild(a);
  assert.equal(R.plan({ el: block, kind: 'partial', anchorNode: a, text: 'x' }).mode, 'end');
});

test('typographySource：取承载大部分文字的子元素（标题链接），而不是灰色旁注', () => {
  const td = el('td');
  const line = attach(td, el('span'));
  const a = attach(line, el('a')); a.textContent = 'RSS Feeds for Last.fm';
  const site = attach(line, el('span')); site.textContent = ' (xiffy.nl)';
  line.textContent = a.textContent + site.textContent;
  td.textContent = line.textContent;
  assert.equal(R.typographySource(td), a);
});

test('typographySource：单一包裹元素时取最内层，否则取自身', () => {
  const td = el('td');
  const span = attach(td, el('span'));
  const b = attach(span, el('b'));
  txt(b, 'Text');
  b.textContent = span.textContent = td.textContent = 'Text';
  assert.equal(R.typographySource(td), b);
  txt(td, 'loose text that dominates');
  td.textContent = 'Text loose text that dominates';
  assert.equal(R.typographySource(td), td);
});

/* ---------------- 排版复制 ---------------- */
test('create：逐条复制原文排版属性，保证字体字号一致', () => {
  const src = el('p', {
    display: 'block',
    fontFamily: '"Noto Sans", Arial, sans-serif',
    fontSize: '19.2px',
    fontWeight: '700',
    fontStyle: 'italic',
    fontVariant: 'normal',
    fontStretch: 'normal',
    fontFeatureSettings: 'normal',
    lineHeight: '28.8px',
    letterSpacing: '0.5px',
    wordSpacing: 'normal',
    textTransform: 'lowercase',
    textIndent: '12px',
    color: 'rgb(185, 28, 28)',
    textAlign: 'right',
    direction: 'ltr',
    textShadow: 'none'
  });
  const node = R.create(src, '\u8bd1\u6587\u5185\u5bb9', { markStyle: 'none' });

  assert.equal(node.style.fontFamily, '"Noto Sans", Arial, sans-serif');
  assert.equal(node.style.fontSize, '19.2px');
  assert.equal(node.style.fontWeight, '700');
  assert.equal(node.style.fontStyle, 'italic');
  assert.equal(node.style.lineHeight, '28.8px');
  assert.equal(node.style.letterSpacing, '0.5px');
  assert.equal(node.style.color, 'rgb(185, 28, 28)');
  assert.equal(node.style.textAlign, 'right');
  assert.equal(node.style.textIndent, '12px');
  assert.equal(node.style.textTransform, 'lowercase');

  // 布局必须重置，否则会被页面样式污染
  assert.equal(node.style.display, 'block');
  assert.equal(node.style.padding, '0');
  assert.equal(node.style.border, '0');
  assert.equal(node.style.backgroundColor, 'transparent');
  assert.equal(node.style.whiteSpace, 'pre-wrap');
  assert.equal(node.style.unicodeBidi, 'isolate');

  assert.equal(node.getAttribute('data-wpt'), '1');
  assert.equal(node.getAttribute('dir'), 'auto');
  assert.equal(node.textContent, '\u8bd1\u6587\u5185\u5bb9');
});

test('create：内部放置时不写死排版（继承原文，网站切换主题也同步），并带语言与防二次翻译标记', () => {
  const src = el('p', { display: 'block', fontFamily: 'Georgia', fontSize: '18px', color: 'rgb(1, 2, 3)' });
  const node = R.create(src, '译文', { markStyle: 'none', targetLang: 'zh-CN' }, { mode: 'end', target: src, typo: null });
  assert.equal(node.style.fontFamily, undefined);
  assert.equal(node.style.color, undefined);
  assert.equal(node.style.display, 'block');
  assert.equal(node.getAttribute('lang'), 'zh-CN');
  assert.equal(node.getAttribute('translate'), 'no');
  assert.equal(node.className, 'wpt-translation');

  const inl = R.create(src, '定价', {}, { mode: 'inline', target: src, typo: null });
  assert.equal(inl.style.display, 'inline');
  assert.equal(inl.style.whiteSpace, 'normal');
});

test('create：兄弟放置时用负 margin 抵消原文下边距，并把下边距还给下一段', () => {
  const src = el('p', { display: 'block', marginBottom: '20px', fontSize: '16px' });
  const node = R.create(src, '译文', {}, { mode: 'sibling', target: src, typo: src });
  assert.equal(node.style.marginTop, 'calc(0.25em - 20px)');
  assert.equal(node.style.marginBottom, '20px');
  assert.equal(node.style.fontSize, '16px');
});

test('create：标记样式基于 currentColor（适配网站配色），且不改变字体字号', () => {
  const base = { display: 'block', fontFamily: 'Arial', fontSize: '16px', color: 'rgb(0,0,0)', textShadow: 'none' };
  const plain = R.create(el('p', base), 'x', { markStyle: 'none' });
  const border = R.create(el('p', base), 'x', { markStyle: 'border' });
  const bg = R.create(el('p', base), 'x', { markStyle: 'background' });
  const dim = R.create(el('p', base), 'x', { markStyle: 'dim' });
  assert.equal(plain.style.borderInlineStart, undefined);
  assert.match(border.style.borderInlineStart, /currentColor/);
  assert.match(bg.style.backgroundColor, /currentColor/);
  assert.equal(dim.style.opacity, '0.72');
  assert.equal(border.style.fontFamily, 'Arial');
  assert.equal(border.style.fontSize, '16px');
});

/* ---------------- 实际插入 ---------------- */
test('insert：默认放在原文元素内部末尾', () => {
  const parent = el('div');
  const src = attach(parent, el('p'));
  const t = txt(src, 'Hello');
  const node = el('span');
  const unit = unitOf(src);
  assert.equal(R.insert(node, unit, R.plan(unit)), 'end');
  assert.deepEqual(src.childNodes, [t, node]);
});

test('insert：兄弟插入恰好落在原文元素之后', () => {
  const parent = el('div');
  const before = attach(parent, el('p'));
  const src = attach(parent, el('p'));
  const after = attach(parent, el('p'));
  const node = el('span');
  const mode = R.insert(node, unitOf(src), { mode: 'sibling', target: src });
  assert.equal(mode, 'sibling');
  assert.deepEqual(parent.childNodes.map((c) => c === node ? 'NEW' : (c === before ? 'before' : c === src ? 'src' : 'after')),
    ['before', 'src', 'NEW', 'after']);
});

test('insert：主体子元素模式把译文放进该子元素', () => {
  const box = attach(el('div'), el('div', { display: 'flex' }));
  const icon = attach(box, el('i'));
  const span = attach(box, el('span'));
  const node = el('span');
  assert.equal(R.insert(node, unitOf(box), { mode: 'end', target: span }), 'end');
  assert.deepEqual(box.childNodes, [icon, span]);
  assert.equal(span.childNodes[0], node);
});

test('insert：混合元素的插入锚点生效（正好在行内文字之后）', () => {
  const block = el('div');
  const inlineA = attach(block, el('span'));
  const inlineB = attach(block, el('a'));
  const blockKid = attach(block, el('p'));
  const node = el('span');
  const unit = { el: block, kind: 'partial', anchorNode: inlineB, text: 'x' };
  assert.equal(R.insert(node, unit, R.plan(unit)), 'anchor');
  assert.deepEqual(block.childNodes, [inlineA, inlineB, node, blockKid]);
});

test('insert：源元素已从文档移除时返回 null，不会抛错', () => {
  const parent = el('div');
  const src = attach(parent, el('p'));
  src.isConnected = false;
  assert.equal(R.insert(el('span'), unitOf(src), false), null);
});

/* ---------------- 仅译文：隐藏与还原原文 ---------------- */
test('hideOriginal / showOriginal：隐藏原文文本与元素，保留译文，可完整还原', () => {
  const li = el('li');
  const t1 = txt(li, 'Read the ');
  const a = attach(li, el('a'));
  a.style.display = 'inline';
  const node = el('span');
  node.setAttribute('data-wpt', '1');
  li.appendChild(node);
  const saved = R.hideOriginal({ el: li, kind: 'full' }, node);
  assert.equal(t1.nodeValue, '');
  assert.equal(a.style.display, 'none');
  assert.equal(node.style.display, undefined, '译文本身不受影响');
  R.showOriginal(saved);
  assert.equal(t1.nodeValue, 'Read the ');
  assert.equal(a.style.display, 'inline');
});

test('showOriginal：页面框架已写入新文本时不覆盖', () => {
  const p = el('p');
  const t = txt(p, 'old');
  const saved = R.hideOriginal({ el: p, kind: 'full' }, null);
  t.nodeValue = 'new text from framework';
  R.showOriginal(saved);
  assert.equal(t.nodeValue, 'new text from framework');
});

test('hideOriginal：混合元素只隐藏行内部分，块级子元素保持可见', () => {
  const div = el('div');
  const t = txt(div, 'Intro text');
  const kid = attach(div, el('p'));
  const saved = R.hideOriginal({ el: div, kind: 'partial', nodes: [t] }, null);
  assert.equal(t.nodeValue, '');
  assert.equal(kid.style.display, undefined);
  R.showOriginal(saved);
  assert.equal(t.nodeValue, 'Intro text');
});

test('plan：行内级元素（按钮组拆出的单个按钮）短文本 -> 行内；仅译文模式不留间隔', () => {
  const p = el('p');
  const btn = attach(p, el('button', { display: 'inline-block' }));
  const pl = R.plan(unitOf(btn, 'Accept all'));
  assert.equal(pl.mode, 'inline');
  const only = R.plan(unitOf(btn, 'Accept all'), true);
  assert.equal(R.create(btn, '接受', {}, only).style.margin, '0');
  const para = attach(el('div'), el('p'));
  assert.equal(R.create(para, '译文', {}, R.plan(unitOf(para), true)).style.margin, '0');
});

test('clipBox：内部可滚动容器（overflow-y:auto）不算定高裁切，overflow:hidden 仍判裁切', () => {
  const scroller = el('main', { display: 'block', overflowX: 'visible', overflowY: 'auto' });
  scroller.scrollHeight = 2000;
  scroller.clientHeight = 800;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 });
  const p = attach(scroller, el('p', { display: 'block' }));
  p.getBoundingClientRect = () => ({ top: 750, bottom: 840, left: 20, right: 900, width: 880, height: 90 });
  const tr = attach(p, el('wpt-t', { display: 'block' }));
  tr.getBoundingClientRect = () => ({ top: 795, bottom: 840, left: 20, right: 900, width: 880, height: 45 });
  assert.equal(R.clipBox(tr, p), null, '滚动容器下方的内容可滚动看到，不应判为裁切');

  scroller._computed.overflowY = 'hidden';
  assert.equal(R.clipBox(tr, p), scroller, 'overflow:hidden 超出底边仍判为裁切');
});

test('plan：font-size:0 容器内含可见字号子元素时复制子元素排版，避免译文不可见', () => {
  const a = el('a', { display: 'block', fontSize: '0px' });
  txt(a, 'Zero size hidden card title text');
  const span = attach(a, el('span', { display: 'inline', fontSize: '15px', color: 'rgb(10, 20, 30)' }));
  span.textContent = 'Visible subtitle';
  a.querySelectorAll = () => [span];
  const pl = R.plan(unitOf(a, 'Visible subtitle that should inherit non-zero font size'));
  assert.equal(pl.typo, span);
});

test('plan：XHTML 小写 tagName（ul / li）同样识别刚性父级', () => {
  const ul = el('ul');
  ul.tagName = 'ul';
  const li = attach(ul, el('li', { display: 'flex', flexDirection: 'row' }));
  li.tagName = 'li';
  const a = attach(li, el('span')); a.textContent = 'first part of item';
  const b = attach(li, el('span')); b.textContent = 'second part of it';
  assert.equal(R.plan(unitOf(li, 'first part of item second part of it, long enough')).mode, 'end');
});
