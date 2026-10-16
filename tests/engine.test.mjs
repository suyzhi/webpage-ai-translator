/*
 * 集成测试：用假的 chrome API 与假的 fetch 驱动完整后台链路
 * （importScripts 装载 -> 缓存 -> 去重 -> 批量 -> 并发 -> 重试 -> 拆分自愈 -> 致命错误快停；
 *   以及自动翻译内容脚本按设置 / 网站规则的动态注册、快捷键 / 右键菜单的注入与消息）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- chrome API 打桩 ---------------- */
function stubChrome() {
  const store = new Map();
  const listeners = { message: [], connect: [], installed: [], changed: [], command: [], menu: [] };
  const normalizeKeys = (keys) => {
    if (keys == null) return Array.from(store.keys());
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys);
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of normalizeKeys(keys)) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (obj) => { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
        remove: async (keys) => { for (const k of normalizeKeys(keys)) store.delete(k); }
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      getPlatformInfo: () => {},
      openOptionsPage: () => {},
      lastError: undefined
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    scripting: {
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      executeScript: async () => []
    },
    tabs: { sendMessage: async () => { throw new Error('no receiver'); }, query: async () => [] },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: () => {},
      onClicked: { addListener: (fn) => listeners.menu.push(fn) }
    }
  };
  return { store, listeners };
}

const { store, listeners } = stubChrome();
globalThis.importScripts = function () {};     // 后台用 importScripts，测试里手动按序装载

function load(...files) {
  for (const f of files) {
    const p = path.join(ROOT, f);
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  }
  return globalThis.WPT;
}

const WPT = load(
  'src/shared/constants.js',
  'src/shared/util.js',
  'src/shared/settings.js',
  'src/shared/prompt.js',
  'src/background/providers.js',
  'src/background/cache.js',
  'src/background/engine.js',
  'src/background/service-worker.js'      // 后台整体可正常装载
);

/* ---------------- fetch 打桩：一个"听话的模型" ---------------- */
function makeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (init.signal && init.signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const body = init.body ? JSON.parse(init.body) : {};
    const call = { url, body, headers: init.headers };
    calls.push(call);
    const out = await handler(call, calls.length);
    if (out && out.__httpError) {
      return {
        ok: false,
        status: out.__httpError,
        headers: { get: (k) => (out.headers && out.headers[k]) || null },
        text: async () => JSON.stringify({ error: { message: out.message || 'error' } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: out.content } }] })
    };
  };
  return calls;
}

/* 从请求体里取出批量片段，返回 [{id, text}] */
function segmentsOf(call) {
  const user = call.body.messages.find((m) => m.role === 'user').content;
  const out = [];
  const re = /<t id="(\d+)">([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(user)) !== null) out.push({ id: Number(m[1]), text: m[2] });
  return out;
}

function echoTranslator(prefix) {
  return (call) => ({
    content: segmentsOf(call).map((s) => '<t id="' + s.id + '">' + (prefix || '\u8bd1') + '|' + s.text + '</t>').join('\n')
  });
}

const BASE_SETTINGS = WPT.settings.normalize({
  provider: 'openai',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  targetLang: 'zh-CN',
  concurrency: 4,
  batchChars: 400,
  batchItems: 3,
  firstBatchChars: 200,
  maxRetries: 1,
  useCache: true
});

function runEngine(settings, items, hooks) {
  const cache = new WPT.TranslationCache();
  return cache.load(1000).then(() => {
    const results = [];
    const engine = new WPT.Engine(Object.assign({
      settings,
      cache,
      onResults: (entries) => entries.forEach((e) => results.push(e))
    }, hooks || {}));
    return engine.run(items).then((stats) => ({ results, stats, engine, cache }));
  });
}

/* ---------------- 用例 ---------------- */

test('后台模块整体可装载', () => {
  assert.ok(WPT.Engine && WPT.TranslationCache && WPT.providers && WPT.settings && WPT.prompt);
  assert.equal(WPT.CONTENT_FILES.includes('src/shared/settings.js'), true);
  for (const f of WPT.CONTENT_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), '内容脚本文件存在：' + f);
  }
});

test('manifest 引用的文件全部存在且版本一致', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(mf.manifest_version, 3);
  assert.equal(mf.version, WPT.VERSION);
  const files = [mf.background.service_worker, mf.action.default_popup, mf.options_ui.page];
  mf.icons && Object.values(mf.icons).forEach((f) => files.push(f));
  mf.action.default_icon && Object.values(mf.action.default_icon).forEach((f) => files.push(f));
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), '存在：' + f);
  assert.ok(mf.host_permissions.includes('<all_urls>'));
});

test('引擎：批量翻译并保留占位符', async () => {
  makeFetch(echoTranslator('\u8bd1'));
  const items = [
    { id: 1, text: 'Hello world' },
    { id: 2, text: 'Visit https://example.com/a?b=1 for details' },
    { id: 3, text: 'Good morning' }
  ];
  const { results, stats } = await runEngine(BASE_SETTINGS, items);
  const map = new Map(results);
  assert.equal(map.size, 3);
  assert.equal(map.get(1), '\u8bd1|Hello world');
  assert.ok(map.get(2).includes('https://example.com/a?b=1'), 'URL 必须原样保留：' + map.get(2));
  assert.equal(map.get(3), '\u8bd1|Good morning');
  assert.equal(stats.failed, 0);
  assert.ok(stats.batches >= 1);
});

test('引擎：相同文本去重，只发一次', async () => {
  const calls = makeFetch(echoTranslator());
  const items = [{ id: 1, text: 'Duplicate text' }, { id: 2, text: 'Duplicate text' }, { id: 3, text: 'Duplicate text' }];
  const { results } = await runEngine(BASE_SETTINGS, items);
  assert.equal(results.length, 3, '三个 id 都应回填');
  const uniqueTexts = new Set();
  for (const c of calls) for (const s of segmentsOf(c)) uniqueTexts.add(s.text);
  assert.equal(uniqueTexts.size, 1, '相同文本只应请求一次');
});

test('引擎：缓存命中不发请求', async () => {
  const calls = makeFetch(echoTranslator());
  const items = [{ id: 1, text: 'Cache me' }, { id: 2, text: 'Cache me too' }];
  const first = await runEngine(BASE_SETTINGS, items);
  assert.equal(first.stats.cached, 0);
  const callsAfterFirst = calls.length;
  const second = await runEngine(BASE_SETTINGS, items);
  assert.equal(calls.length, callsAfterFirst, '第二次不应产生新的请求');
  assert.equal(second.stats.cached, 2);
  assert.equal(second.results.length, 2);
});

test('引擎：模型返回缺片段时自动补翻，不丢内容', async () => {
  let call = 0;
  makeFetch((c) => {
    call++;
    const segs = segmentsOf(c);
    if (call === 1) {
      // 第一次只返回一半，模拟模型偷懒
      return { content: '<t id="' + segs[0].id + '">\u8bd1|' + segs[0].text + '</t>' };
    }
    return echoTranslator()(c);
  });
  const items = [{ id: 1, text: 'Alpha text one' }, { id: 2, text: 'Beta text two' }];
  const { results, stats } = await runEngine(BASE_SETTINGS, items);
  assert.equal(results.length, 2);
  assert.equal(stats.failed, 0);
  assert.ok(call >= 2, '应当对缺失片段再发一次请求');
});

test('引擎：返回内容无法解析时二分拆分成逐条重译', async () => {
  let call = 0;
  makeFetch((c) => {
    call++;
    const segs = segmentsOf(c);
    if (segs.length > 1) return { content: 'Sorry, I cannot do that.' };
    return echoTranslator()(c);
  });
  const items = [{ id: 1, text: 'First long paragraph here' }, { id: 2, text: 'Second long paragraph here' }];
  const { results, stats } = await runEngine(BASE_SETTINGS, items);
  assert.equal(stats.failed, 0, '拆分为单条后应全部成功');
  assert.equal(results.length, 2);
  assert.ok(call > 2, '应当发生拆分重试');
});

test('引擎：HTTP 429 退避重试后成功', async () => {
  let call = 0;
  makeFetch((c) => {
    call++;
    if (call === 1) return { __httpError: 429, message: 'rate limited', headers: { 'retry-after': '0' } };
    return echoTranslator()(c);
  });
  const { results, stats } = await runEngine(BASE_SETTINGS, [{ id: 1, text: 'Retry me please' }]);
  assert.equal(stats.failed, 0);
  assert.equal(results.length, 1);
  assert.equal(call, 2);
});

test('引擎：HTTP 400 上下文超限时拆分成功', async () => {
  let call = 0;
  makeFetch((c) => {
    call++;
    const segs = segmentsOf(c);
    if (segs.length > 1) return { __httpError: 400, message: 'context length exceeded' };
    return echoTranslator()(c);
  });
  const items = [{ id: 1, text: 'A fairly long sentence to translate' }, { id: 2, text: 'Another fairly long sentence' }];
  const { results, stats } = await runEngine(BASE_SETTINGS, items);
  assert.equal(stats.failed, 0);
  assert.equal(results.length, 2);
});

test('引擎：401 视为致命错误，立即停止并上报', async () => {
  const calls = makeFetch(() => ({ __httpError: 401, message: 'invalid api key' }));
  let fatal = null;
  const items = [];
  for (let i = 0; i < 12; i++) items.push({ id: i + 1, text: 'Paragraph number ' + i + ' with some words' });
  const settings = WPT.settings.normalize(Object.assign({}, BASE_SETTINGS, { batchItems: 2, concurrency: 4, maxRetries: 3 }));
  const out = await runEngine(settings, items, { onFatal: (e) => { fatal = e; } });
  assert.ok(fatal, '应触发致命错误回调');
  assert.equal(fatal.status, 401);
  assert.ok(calls.length <= 4, '致命错误后不应继续发送大量请求，实际 ' + calls.length);
  assert.ok(out.stats.failed > 0);
});

test('引擎：致命错误不会重试（认证错误请求数最少化）', async () => {
  const calls = makeFetch(() => ({ __httpError: 403, message: 'forbidden' }));
  const settings = WPT.settings.normalize(Object.assign({}, BASE_SETTINGS, { maxRetries: 3 }));
  await runEngine(settings, [{ id: 1, text: 'Only one paragraph' }]);
  assert.equal(calls.length, 1);
});

test('引擎：网络错误重试后仍失败则标记失败但不抛出', async () => {
  makeFetch(() => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); });
  const { results, stats } = await runEngine(BASE_SETTINGS, [{ id: 1, text: 'Network down text' }]);
  assert.equal(results.length, 0);
  assert.equal(stats.failed, 1);
  assert.equal(stats.done, stats.total);
});

test('缓存：跨实例持久化（模拟 Service Worker 重启）', async () => {
  const c1 = new WPT.TranslationCache();
  await c1.load(100);
  c1.setMany([['wpt.c.abcdef', '\u4f60\u597d\u4e16\u754c']]);
  await c1.flush();
  const c2 = new WPT.TranslationCache();
  await c2.load(100);
  const got = await c2.getMany(['wpt.c.abcdef']);
  assert.equal(got.get('wpt.c.abcdef'), '\u4f60\u597d\u4e16\u754c');
  assert.ok(c2.stats().entries >= 1, '重启后应能从磁盘元数据恢复索引');
  assert.ok(c2.orderSet.has('wpt.c.abcdef'));
});

test('缓存：超过上限按 LRU 淘汰并同步落盘', async () => {
  const c = new WPT.TranslationCache();
  await c.load(3);
  c.setMany([['wpt.c.1', 'a'], ['wpt.c.2', 'b'], ['wpt.c.3', 'c']]);
  c.setMany([['wpt.c.4', 'd']]);
  await c.flush();
  assert.equal(c.stats().entries, 3);
  const got = await c.getMany(['wpt.c.1', 'wpt.c.4']);
  assert.equal(got.has('wpt.c.1'), false, '最旧的应被淘汰');
  assert.equal(got.get('wpt.c.4'), 'd');
});

test('缓存：清空后彻底删除所有条目', async () => {
  const c = new WPT.TranslationCache();
  await c.load(100);
  c.setMany([['wpt.c.x', '1'], ['wpt.c.y', '2']]);
  await c.flush();
  await c.clear();
  assert.equal(c.stats().entries, 0);
  const left = Array.from(store.keys()).filter((k) => k.startsWith('wpt.c'));
  assert.equal(left.length, 0);
});

/* ---------------- 自动翻译：按设置与网站规则注册内容脚本 ---------------- */
function recordScripting(rejectIf) {
  const rec = { registered: [], attempts: 0, unregistered: 0 };
  chrome.scripting.registerContentScripts = async (scripts) => {
    rec.attempts++;
    if (rejectIf && rejectIf(scripts[0])) throw new Error('Invalid match pattern');
    rec.registered.push(scripts[0]);
  };
  chrome.scripting.unregisterContentScripts = async () => { rec.unregistered++; };
  return rec;
}

/* 模拟一次设置写入：落盘并触发 storage.onChanged，等待后台异步注册完成 */
async function changeSettings(prev, next) {
  const oldValue = WPT.settings.normalize(prev);
  const newValue = WPT.settings.normalize(next);
  store.set(WPT.SETTINGS_KEY, newValue);
  for (const fn of listeners.changed) fn({ [WPT.SETTINGS_KEY]: { oldValue, newValue } }, 'local');
  await new Promise((r) => setTimeout(r, 20));
}

test('后台注册：开启自动翻译时排除「从不翻译」的网站', async () => {
  const rec = recordScripting();
  await changeSettings({}, { autoTranslate: true, siteRules: { 'example.cn': 'never' } });
  assert.equal(rec.unregistered, 1, '注册前先注销旧的');
  assert.equal(rec.registered.length, 1);
  const s = rec.registered[0];
  assert.equal(s.id, 'wpt-auto');
  assert.deepEqual(s.js, WPT.CONTENT_FILES);
  assert.deepEqual(s.matches, ['http://*/*', 'https://*/*']);
  assert.deepEqual(s.excludeMatches, ['*://example.cn/*', '*://*.example.cn/*']);
  store.delete(WPT.SETTINGS_KEY);
});

test('后台注册：仅修改网站规则也会重新注册；关闭自动翻译时只匹配「总是翻译」', async () => {
  let rec = recordScripting();
  await changeSettings({ autoTranslate: false }, { autoTranslate: false, siteRules: { 'news.example.com': 'always' } });
  assert.equal(rec.registered.length, 1);
  assert.deepEqual(rec.registered[0].matches, ['*://news.example.com/*', '*://*.news.example.com/*']);
  assert.equal(rec.registered[0].excludeMatches, undefined);

  // 删除最后一条规则：只注销，不再注册（未翻译时零开销）
  rec = recordScripting();
  await changeSettings({ siteRules: { 'news.example.com': 'always' } }, { siteRules: {} });
  assert.equal(rec.unregistered, 1);
  assert.equal(rec.attempts, 0);

  // 与注册无关的设置变化不触发重新注册
  rec = recordScripting();
  await changeSettings({ concurrency: 4 }, { concurrency: 8 });
  assert.equal(rec.unregistered, 0);
  assert.equal(rec.attempts, 0);
  store.delete(WPT.SETTINGS_KEY);
});

test('后台注册：带排除规则的注册失败时退回到不排除（由内容脚本自行判定）', async () => {
  const rec = recordScripting((s) => !!s.excludeMatches);
  await changeSettings({}, { autoTranslate: true, siteRules: { 'example.cn': 'never' } });
  assert.equal(rec.attempts, 2);
  assert.equal(rec.registered.length, 1);
  assert.deepEqual(rec.registered[0].matches, ['http://*/*', 'https://*/*']);
  assert.equal(rec.registered[0].excludeMatches, undefined);
  store.delete(WPT.SETTINGS_KEY);
});

test('快捷键 / 右键菜单：刚注入时发 START（与注入触发的自动翻译合并），已注入时发 TOGGLE', async () => {
  const saved = { query: chrome.tabs.query, send: chrome.tabs.sendMessage, exec: chrome.scripting.executeScript };
  const sent = [];
  const injections = [];
  chrome.tabs.query = (q, cb) => cb([{ id: 7 }]);
  chrome.scripting.executeScript = async (opts) => { injections.push(opts); return []; };
  chrome.tabs.sendMessage = async (tabId, msg) => {
    if (msg.type === WPT.MSG.PING) {
      if (!injections.length) throw new Error('no receiver');
      return { ok: true };
    }
    sent.push([tabId, msg.type]);
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    for (const fn of listeners.command) fn('toggle-translate');
    await settle();
    assert.equal(injections.length, 1);
    assert.equal(injections[0].target.tabId, 7);
    assert.deepEqual(injections[0].files, WPT.CONTENT_FILES);
    assert.deepEqual(sent, [[7, WPT.MSG.START]], '刚注入的页面没有可还原的译文，TOGGLE 会停掉已自动启动的翻译');

    for (const fn of listeners.menu) fn({ menuItemId: 'wpt-toggle' }, { id: 7 });
    await settle();
    assert.equal(injections.length, 1, '已注入时不重复注入');
    assert.deepEqual(sent[1], [7, WPT.MSG.TOGGLE]);
  } finally {
    chrome.tabs.query = saved.query;
    chrome.tabs.sendMessage = saved.send;
    chrome.scripting.executeScript = saved.exec;
  }
});

test('engine + cache：不同目标语言使用不同缓存键', async () => {
  const calls = makeFetch(echoTranslator());
  const items = [{ id: 1, text: 'Shared sentence' }];
  await runEngine(BASE_SETTINGS, items);
  const after = calls.length;
  await runEngine(WPT.settings.normalize(Object.assign({}, BASE_SETTINGS, { targetLang: 'ja' })), items);
  assert.ok(calls.length > after, '换目标语言必须重新请求');
});
