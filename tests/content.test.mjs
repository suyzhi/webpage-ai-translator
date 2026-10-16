/*
 * 内容脚本启动判定测试：每个用例在独立的 vm 上下文里装载 content.js（假 chrome / 假 DOM），
 * 覆盖：自动翻译按网站规则启动、自动翻译找不到内容时静默、手动翻译不受「从不翻译」限制、
 * 手动注入时自动与手动同时触发只启动一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js'];
const read = (f) => [fs.readFileSync(path.join(ROOT, f), 'utf8'), path.join(ROOT, f)];

/* 计时器 unref，避免心跳 / 提示自动隐藏的定时器拖住测试进程 */
const unref = (fn) => (...args) => { const t = fn(...args); if (t && t.unref) t.unref(); return t; };

function fakeNode() {
  return {
    style: {}, dataset: {}, textContent: '', className: '', isConnected: true,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, appendChild(c) { return c; }
  };
}

/* 装载一个页面：host 为页面主机名，settings 为已保存的设置，units 为抽取器返回的段落 */
function loadPage({ host, settings, units }) {
  const page = { collects: 0, toasts: [], rafs: [], ports: [], onMessage: null };

  // 页面内提示（shadow DOM）：记录每次显示的文字
  const shadow = {};
  const root = {
    innerHTML: '',
    querySelector(sel) {
      if (!shadow[sel]) {
        const n = fakeNode();
        if (sel === '.t') Object.defineProperty(n, 'textContent', { set(v) { page.toasts.push(v); }, get() { return ''; } });
        if (sel === '.bar') n.firstChild = fakeNode();
        shadow[sel] = n;
      }
      return shadow[sel];
    }
  };
  const document = {
    title: '',
    body: fakeNode(),
    documentElement: fakeNode(),
    createElement() { const n = fakeNode(); n.attachShadow = () => root; return n; }
  };
  const chrome = {
    storage: {
      local: { get: async (key) => ({ [key]: settings }) },
      onChanged: { addListener() {} }
    },
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => { page.onMessage = fn; } },
      connect: () => {
        const port = {
          messages: [],
          postMessage(m) { port.messages.push(m); },
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
          disconnect() {}
        };
        page.ports.push(port);
        return port;
      }
    }
  };

  const ctx = vm.createContext({
    chrome, document, console, URL,
    location: { hostname: host },
    setTimeout: unref(setTimeout), clearTimeout,
    setInterval: unref(setInterval), clearInterval,
    requestAnimationFrame: (cb) => { page.rafs.push(cb); return page.rafs.length; },
    cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} }
  });
  for (const f of SHARED) { const [code, filename] = read(f); vm.runInContext(code, ctx, { filename }); }
  ctx.WPT.Extractor = {
    collect: () => { page.collects++; return (units || []).map((u) => Object.assign({}, u)); },
    byViewportPriority: (u) => u,
    isHardSkip: () => false
  };
  const [code, filename] = read('src/content/content.js');
  vm.runInContext(code, ctx, { filename });

  page.state = () => ctx.WPT.Content.state;
  page.send = (msg) => page.onMessage(msg, {}, () => {});
  return page;
}

/* 跑完异步启动流程：等待设置读取并手动推进 requestAnimationFrame */
async function settle(page) {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 2));
    page.rafs.splice(0).forEach((cb) => cb());
  }
}

const UNITS = [{ id: 1, el: fakeNode(), text: 'Hello world', kind: 'full', anchorNode: null }];
const NOTHING = '未找到可翻译的内容';

test('自动翻译：页面没有可翻译内容时静默结束，不弹错误提示', async () => {
  const page = loadPage({ host: 'news.example.cn', settings: { autoTranslate: true }, units: [] });
  await settle(page);
  assert.equal(page.collects, 1, '应当自动开始扫描');
  assert.deepEqual(page.toasts, [], '自动翻译不应出现任何提示');
  assert.equal(page.state().status, 'idle');
});

test('自动翻译：父域名设为「从不翻译」时不启动', async () => {
  const page = loadPage({ host: 'news.example.cn', settings: { autoTranslate: true, siteRules: { 'example.cn': 'never' } }, units: UNITS });
  await settle(page);
  assert.equal(page.collects, 0);
  assert.equal(page.ports.length, 0);
});

test('自动翻译关闭时：「总是翻译」的网站自动启动，其余网站不启动', async () => {
  const settings = { autoTranslate: false, siteRules: { 'example.com': 'always' } };
  const page = loadPage({ host: 'docs.example.com', settings, units: UNITS });
  await settle(page);
  assert.equal(page.collects, 1);
  assert.equal(page.ports.length, 1);
  assert.equal(page.ports[0].messages[0].type, 'wpt:start');
  assert.equal(page.ports[0].messages[0].items.length, 1);

  const other = loadPage({ host: 'other.org', settings, units: UNITS });
  await settle(other);
  assert.equal(other.collects, 0);
});

test('手动翻译：不受「从不翻译」限制；找不到内容时照常提示', async () => {
  const page = loadPage({ host: 'example.cn', settings: { autoTranslate: true, siteRules: { 'example.cn': 'never' } }, units: UNITS });
  await settle(page);
  assert.equal(page.collects, 0);
  page.send({ type: 'wpt:start' });
  await settle(page);
  assert.equal(page.collects, 1);
  assert.equal(page.ports.length, 1);

  const empty = loadPage({ host: 'example.org', settings: { autoTranslate: false }, units: [] });
  empty.send({ type: 'wpt:start' });
  await settle(empty);
  assert.ok(empty.toasts.includes(NOTHING), '手动翻译应提示：' + empty.toasts.join(' / '));
});

test('手动注入时自动与手动同时触发：只扫描一次，按手动处理', async () => {
  // 手动请求先到：自动启动被合并
  const a = loadPage({ host: 'example.org', settings: { autoTranslate: true }, units: [] });
  a.send({ type: 'wpt:start' });
  await settle(a);
  assert.equal(a.collects, 1);
  assert.ok(a.toasts.includes(NOTHING));

  // 自动启动已在扫描中，手动请求随后到达
  const b = loadPage({ host: 'example.org', settings: { autoTranslate: true }, units: [] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(b.state().status, 'scanning');
  b.send({ type: 'wpt:start' });
  await settle(b);
  assert.equal(b.collects, 1);
  assert.ok(b.toasts.includes(NOTHING), '手动请求接管后应恢复提示');
});
