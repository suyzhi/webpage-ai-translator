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
  createTextNode: (t) => ({ nodeType: 3, nodeValue: t })
};
globalThis.getComputedStyle = (node) => node._computed || { display: 'block' };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src/content/render.js'), 'utf8'), { filename: 'render.js' });
const R = globalThis.WPT.Renderer;

function attach(parent, child) { parent.appendChild(child); return child; }

/* ---------------- 插入位置决策 ---------------- */
test('chooseInsertMode：普通块级段落 -> 兄弟节点（正好在原文下方）', () => {
  const parent = el('div');
  const p = attach(parent, el('p'));
  assert.equal(R.chooseInsertMode(p), 'sibling');
});

test('chooseInsertMode：父级是 flex/grid -> 追加到内部（不产生多余 flex item）', () => {
  const parent = el('div', { display: 'flex' });
  const p = attach(parent, el('p'));
  assert.equal(R.chooseInsertMode(p), 'end');

  const g = el('div', { display: 'grid' });
  const q = attach(g, el('p'));
  assert.equal(R.chooseInsertMode(q), 'end');
});

test('chooseInsertMode：源元素自身是 flex 容器 -> 兄弟节点（不能塞进去当 flex item）', () => {
  const parent = el('div');
  const box = attach(parent, el('div', { display: 'flex' }));
  assert.equal(R.chooseInsertMode(box), 'sibling');
});

test('chooseInsertMode：列表 / 表格结构 -> 追加到内部', () => {
  const ul = el('ul');
  const li = attach(ul, el('li'));
  assert.equal(R.chooseInsertMode(li), 'end');

  const tr = el('tr');
  const td = attach(tr, el('td'));
  assert.equal(R.chooseInsertMode(td), 'end');

  const table = el('table');
  const row = attach(table, el('tr'));
  assert.equal(R.chooseInsertMode(row), 'end');
});

test('chooseInsertMode：仅译文模式优先兄弟节点，但刚性结构仍追加内部', () => {
  const parent = el('div', { display: 'flex' });
  const p = attach(parent, el('p'));
  assert.equal(R.chooseInsertMode(p, true), 'sibling', '仅译文模式希望译文独立于原文之外');

  const table = el('table');
  const row = attach(table, el('tr'));
  assert.equal(R.chooseInsertMode(row, true), 'end', '表格行不能插兄弟节点');

  const tr = el('tr');
  const td = attach(tr, el('td'));
  assert.equal(R.chooseInsertMode(td, true), 'end');
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

test('create：标记样式不改变字体字号', () => {
  const base = { display: 'block', fontFamily: 'Arial', fontSize: '16px', color: 'rgb(0,0,0)', textShadow: 'none' };
  const plain = R.create(el('p', base), 'x', { markStyle: 'none' });
  const border = R.create(el('p', base), 'x', { markStyle: 'border' });
  assert.equal(plain.style.borderLeft, undefined);
  assert.match(border.style.borderLeft, /3px solid/);
  assert.equal(border.style.fontFamily, 'Arial');
  assert.equal(border.style.fontSize, '16px');
});

/* ---------------- 实际插入 ---------------- */
test('insert：兄弟插入恰好落在原文元素之后', () => {
  const parent = el('div');
  const before = attach(parent, el('p'));
  const src = attach(parent, el('p'));
  const after = attach(parent, el('p'));
  const unit = { el: src, kind: 'full', anchorNode: null };
  const node = el('span');

  const mode = R.insert(node, unit);
  assert.equal(mode, 'sibling');
  assert.deepEqual(parent.childNodes.map((c) => c === node ? 'NEW' : (c === before ? 'before' : c === src ? 'src' : 'after')),
    ['before', 'src', 'NEW', 'after']);
});

test('insert：追加模式把译文放在原文元素内部末尾', () => {
  const parent = el('div', { display: 'flex' });
  const src = attach(parent, el('p'));
  const node = el('span');
  const mode = R.insert(node, { el: src, kind: 'full', anchorNode: null });
  assert.equal(mode, 'end');
  assert.equal(src.childNodes[src.childNodes.length - 1], node);
});

test('insert：混合元素的插入锚点生效（正好在行内文字之后）', () => {
  const block = el('div');
  const inlineA = attach(block, el('span'));
  const inlineB = attach(block, el('a'));
  const blockKid = attach(block, el('p'));
  const node = el('span');

  const mode = R.insert(node, { el: block, kind: 'partial', anchorNode: inlineB });
  assert.equal(mode, 'anchor');
  assert.deepEqual(block.childNodes, [inlineA, inlineB, node, blockKid]);
});

test('insert：源元素已从文档移除时返回 null，不会抛错', () => {
  const parent = el('div');
  const src = attach(parent, el('p'));
  src.isConnected = false;
  assert.equal(R.insert(el('span'), { el: src, kind: 'full', anchorNode: null }), null);
});
