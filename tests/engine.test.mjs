/*
 * 集成测试：用假的 chrome API 与假的 fetch 驱动完整后台链路
 * （importScripts 装载 -> 缓存 -> 去重 -> 批量 -> 并发 -> 重试 -> 拆分自愈 -> 致命错误快停）
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
  return user.split('\n').map((line) => {
    const m = /^(\d+)\|(.*)$/.exec(line);
    return { id: Number(m[1]), text: m[2] };
  });
}

function echoTranslator(prefix) {
  return (call) => ({
    content: segmentsOf(call).map((s) => s.id + '|' + (prefix || '\u8bd1') + '|' + s.text).join('\n')
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
      return { content: segs[0].id + '|\u8bd1|' + segs[0].text };
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

test('engine + cache：不同目标语言使用不同缓存键', async () => {
  const calls = makeFetch(echoTranslator());
  const items = [{ id: 1, text: 'Shared sentence' }];
  await runEngine(BASE_SETTINGS, items);
  const after = calls.length;
  await runEngine(WPT.settings.normalize(Object.assign({}, BASE_SETTINGS, { targetLang: 'ja' })), items);
  assert.ok(calls.length > after, '换目标语言必须重新请求');
});

/* ---------------- 高并发：共享限流 / 增量追加 / 不放大请求 ---------------- */
const isolated = (name, extra) => WPT.settings.normalize(Object.assign({}, BASE_SETTINGS, { baseUrl: 'https://' + name + '.test/v1' }, extra || {}));

test('限流器：AIMD —— 429 并发减半并冷却，连续成功后逐步恢复到上限', async () => {
  const l = new WPT.util.Limiter(8);
  l.onRateLimit(0);
  assert.equal(l.limit, 4);
  l.onRateLimit(0);
  assert.equal(l.limit, 2);
  for (let i = 0; i < 2; i++) l.onSuccess();
  assert.equal(l.limit, 3);
  for (let i = 0; i < 50; i++) l.onSuccess();
  assert.equal(l.limit, 8, '最终恢复到上限');
  l.setMax(3);
  assert.equal(l.limit, 3, '调低上限立即生效');
});

test('限流器：排队的等待者可被中止，不会泄漏名额', async () => {
  const l = new WPT.util.Limiter(1);
  await l.acquire();
  const ctrl = new AbortController();
  const waiting = l.acquire(ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, (e) => e.name === 'AbortError');
  l.release();
  assert.equal(l.active, 0);
  assert.equal(l.queue.length, 0);
});

test('高并发：多个标签页（引擎）共享同一密钥的并发上限，而不是各自一份', async () => {
  let inflight = 0, peak = 0;
  makeFetch(async (c) => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 15));
    inflight--;
    return echoTranslator()(c);
  });
  const settings = isolated('shared', { concurrency: 2, batchItems: 1, useCache: false });
  const mk = (tab) => Array.from({ length: 6 }, (_, i) => ({ id: i + 1, text: 'Tab ' + tab + ' paragraph ' + i }));
  const outs = await Promise.all([runEngine(settings, mk('A')), runEngine(settings, mk('B')), runEngine(settings, mk('C'))]);
  for (const o of outs) assert.equal(o.results.length, 6);
  assert.ok(peak <= 2, '三个引擎合计并发不应超过 2，实际峰值 ' + peak);
});

test('高并发：持续 429 不拆分批次、不放大请求量，最终标记失败并上报 id', async () => {
  const calls = makeFetch(() => ({ __httpError: 429, message: 'rate limited', headers: { 'retry-after': '0' } }));
  const settings = isolated('storm', { batchItems: 4, maxRetries: 1, useCache: false });
  const items = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, text: 'Rate limited paragraph ' + i }));
  const { stats, engine } = await runEngine(settings, items);
  assert.equal(stats.failed, 4);
  assert.deepEqual(engine.failedIds.slice().sort(), [1, 2, 3, 4]);
  assert.ok(calls.every((c) => segmentsOf(c).length === 4), '限流时不应二分拆分');
  assert.ok(calls.length <= 1 + 1 + 4, '请求数应有上限，实际 ' + calls.length);
});

test('高并发：5xx 不拆分（避免对过载服务成倍加压）', async () => {
  const calls = makeFetch(() => ({ __httpError: 503, message: 'overloaded' }));
  const settings = isolated('overload', { batchItems: 4, maxRetries: 0, useCache: false });
  const items = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, text: 'Overloaded paragraph ' + i }));
  const { stats } = await runEngine(settings, items);
  assert.equal(stats.failed, 4);
  assert.equal(calls.length, 1);
});

test('增量追加：运行中 add() 新段落，不中止在途请求；同文副本合并分发；只结束一次', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = makeFetch(async (c) => { await gate; return echoTranslator()(c); });
  const settings = isolated('incremental', { useCache: false });
  const cache = new WPT.TranslationCache();
  await cache.load(1000);
  const results = [];
  const engine = new WPT.Engine({ settings, cache, onResults: (e) => e.forEach((x) => results.push(x)) });
  const done = engine.run([{ id: 1, text: 'First paragraph' }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.add([{ id: 2, text: 'First paragraph' }, { id: 3, text: 'Second paragraph' }]), true);
  release();
  const stats = await done;
  assert.equal(engine.finished, true);
  assert.equal(engine.add([{ id: 9, text: 'late' }]), false, '结束后不再接收');
  assert.deepEqual(results.map((r) => r[0]).sort(), [1, 2, 3]);
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 3);
  const segs = calls.flatMap(segmentsOf).map((s) => s.text);
  assert.equal(segs.filter((t) => t === 'First paragraph').length, 1, '在途文本不重复请求');
});

test('stop()：取消后 idle 仍会结算，不会挂起', async () => {
  makeFetch(() => new Promise(() => {}));
  const settings = isolated('cancel', { useCache: false });
  const cache = new WPT.TranslationCache();
  await cache.load(1000);
  const engine = new WPT.Engine({ settings, cache });
  const done = engine.run([{ id: 1, text: 'Never answered' }]);
  await new Promise((r) => setTimeout(r, 10));
  engine.stop();
  const stats = await done;
  assert.equal(stats.done, stats.total);
});

test('providers：响应头已到但响应体卡住时也会超时，不会永久占用并发名额', async () => {
  globalThis.fetch = async (url, init) => ({
    ok: true, status: 200, headers: { get: () => null },
    text: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  const settings = Object.assign({}, isolated('stall'), { timeoutMs: 120 });
  const t0 = Date.now();
  await assert.rejects(WPT.providers.call(settings, { system: 's', user: 'u' }), (e) => e.name === 'TimeoutError' && e.retryable);
  assert.ok(Date.now() - t0 < 2000);
});

/* ---------------- 省 token ---------------- */
test('省 token：每个请求内的片段编号从 1 开始，不随任务流水号增长', async () => {
  const calls = makeFetch(echoTranslator());
  const items = Array.from({ length: 9 }, (_, i) => ({ id: 100 + i, text: 'Numbered paragraph ' + i }));
  const { results } = await runEngine(isolated('localids', { useCache: false }), items);
  assert.equal(results.length, 9);
  for (const c of calls) assert.deepEqual(segmentsOf(c).map((s) => s.id), segmentsOf(c).map((_, i) => i + 1));
  const map = new Map(results);
  assert.equal(map.get(108), '译|Numbered paragraph 8', '编号映射回正确的段落');
});

test('省 token：增量任务（quickStart=false）不再切小首批', async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, text: 'Incremental paragraph number ' + i + ' with some words' }));
  const settings = isolated('incr', { useCache: false, batchItems: 60, batchChars: 4000, firstBatchChars: 100 });
  const quick = makeFetch(echoTranslator());
  await runEngine(settings, items);
  const lazy = makeFetch(echoTranslator());
  await runEngine(settings, items, { quickStart: false });
  assert.ok(quick.length > 1, '用户发起的首轮：首批切小');
  assert.equal(lazy.length, 1, '增量：整批一次发送');
});

test('省 token：OpenAI 兼容请求带 max_tokens（推理模型除外），已知平台关闭思考', async () => {
  const calls = makeFetch(() => ({ content: '1|x' }));
  const msg = { system: 's', user: 'u', maxTokens: 1234 };
  await WPT.providers.call(isolated('mt', { model: 'deepseek-chat' }), msg);
  await WPT.providers.call(isolated('mt', { model: 'gpt-5-mini' }), msg);
  await WPT.providers.call(Object.assign({}, BASE_SETTINGS, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' }), msg);
  await WPT.providers.call(Object.assign({}, BASE_SETTINGS, { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' }), msg);
  assert.equal(calls[0].body.max_tokens, 1234);
  assert.equal(calls[0].body.enable_thinking, undefined, '未知平台不发额外参数');
  assert.equal(calls[1].body.max_tokens, undefined, 'gpt-5 / o 系列不设上限');
  assert.equal(calls[2].body.enable_thinking, false);
  assert.deepEqual(calls[3].body.thinking, { type: 'disabled' });

  const ds = Object.assign({}, BASE_SETTINGS, { baseUrl: 'https://api.deepseek.com/v1' });
  await WPT.providers.call(Object.assign({}, ds, { model: 'deepseek-flash' }), msg);
  await WPT.providers.call(Object.assign({}, ds, { model: 'deepseek-reasoner' }), msg);
  assert.deepEqual(calls[4].body.thinking, { type: 'disabled' }, 'DeepSeek V4 默认思考，翻译时关闭');
  assert.equal(calls[5].body.thinking, undefined, '用户明确选了推理模型时不干预');
});

test('省 token：只返回思考过程的推理模型按致命错误停止，不反复重试', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Let me think...' } }], usage: { prompt_tokens: 100, completion_tokens: 900 } }) };
  };
  const errors = [];
  const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, text: 'Reasoning paragraph ' + i }));
  const { stats } = await runEngine(isolated('reasoner', { useCache: false, batchItems: 60, batchChars: 4000 }), items, { onFatal: (e) => errors.push(e), quickStart: false });
  assert.equal(calls.length, 1, '致命错误后不再发请求');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /非推理模型/);
  assert.equal(stats.usage.output, 900, '已花掉的 token 仍计入用量');
});

test('省 token：超时不原样重发整批，而是直接拆小', async () => {
  let n = 0;
  const calls = makeFetch((call) => {
    n++;
    if (n === 1) return new Promise(() => {});           // 第一次（整批）卡住直到超时
    return echoTranslator()(call);
  });
  const items = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, text: 'Slow paragraph ' + i }));
  const settings = Object.assign({}, isolated('timeout-split', { useCache: false, batchItems: 60, batchChars: 4000, maxRetries: 2 }), { timeoutMs: 120 });
  const { results } = await runEngine(settings, items);
  assert.equal(results.length, 4);
  assert.equal(segmentsOf(calls[0]).length, 4);
  assert.ok(calls.slice(1).every((c) => segmentsOf(c).length <= 2), '超时后拆半：' + calls.map((c) => segmentsOf(c).length));
  assert.equal(calls.length, 3, '1 次超时 + 2 个半批，而不是整批重试 2 次');
});

test('用量统计：解析 OpenAI / DeepSeek / Anthropic 的 usage 并在引擎中累计', async () => {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isAnth = /\/messages$/.test(url);
    const segs = isAnth ? body.messages[0].content : body.messages[1].content;
    const payload = isAnth
      ? { content: [{ type: 'text', text: segs }], usage: { input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 7 } }
      : { choices: [{ message: { content: segs } }], usage: { prompt_tokens: 40, completion_tokens: 7, prompt_cache_hit_tokens: 30 } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  };
  const seen = [];
  const one = [{ id: 1, text: 'Usage paragraph' }];
  const a = await runEngine(isolated('usage-oa', { useCache: false }), one, { onUsage: (u) => seen.push(u) });
  const b = await runEngine(Object.assign({}, isolated('usage-an', { useCache: false }), { provider: 'anthropic' }), one);
  assert.deepEqual(a.stats.usage, { input: 40, output: 7, cached: 30 });
  assert.deepEqual(b.stats.usage, { input: 40, output: 7, cached: 30 }, 'Anthropic 输入 = input + 缓存读取');
  assert.equal(seen.length, 1);
});

test('升级迁移：旧设置一次性升级批次大小并清空旧缓存，密钥保留；只执行一次', async () => {
  const regs = [];
  chrome.scripting.registerContentScripts = async (list) => { regs.push(...list); };
  store.set(WPT.SETTINGS_KEY, { apiKey: 'sk-keep', batchChars: 1200, batchItems: 16, autoTranslate: true, autoSites: ['example.com'], neverSites: ['ads.example.com'] });
  store.set(WPT.CACHE_PREFIX + 'old', '旧译文');
  store.set(WPT.CACHE_META_KEY, { v: 1, order: [[WPT.CACHE_PREFIX + 'old', 3]] });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  listeners.installed.forEach((fn) => fn({ reason: 'update' }));
  await settle();
  const s = store.get(WPT.SETTINGS_KEY);
  assert.equal(s.settingsRev, WPT.SETTINGS_REV);
  assert.equal(s.batchChars, WPT.DEFAULT_SETTINGS.batchChars);
  assert.equal(s.apiKey, 'sk-keep');
  assert.equal(store.has(WPT.CACHE_PREFIX + 'old'), false, '旧缓存已清空');
  // 自动翻译只注册到名单内的网站
  const reg = regs[regs.length - 1];
  assert.deepEqual(reg.matches, ['*://example.com/*', '*://*.example.com/*']);
  assert.deepEqual(reg.excludeMatches, ['*://ads.example.com/*', '*://*.ads.example.com/*']);
  // 已迁移：再次触发不会清缓存
  store.set(WPT.CACHE_PREFIX + 'new', '新译文');
  listeners.installed.forEach((fn) => fn({ reason: 'update' }));
  await settle();
  assert.equal(store.has(WPT.CACHE_PREFIX + 'new'), true, '迁移只执行一次');
});
