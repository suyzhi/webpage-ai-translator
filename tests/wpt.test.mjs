/*
 * 核心算法单元测试（零依赖，node --test tests/）
 * 覆盖：文本规范化、缓存键、占位符保护、语言判定、批量打包、并发池、LRU、提示词与解析、错误分类。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  'src/shared/prompt.js',
  'src/shared/settings.js',
  'src/background/providers.js'
);
const U = WPT.util;

/* ---------------- 文本规范化 ---------------- */
test('normalizeText 折叠空白并保留换行', () => {
  assert.equal(U.normalizeText('  hello   world  '), 'hello world');
  assert.equal(U.normalizeText('a\u00a0b'), 'a b');
  assert.equal(U.normalizeText('line1\n\n\n\nline2'), 'line1\n\nline2');
  assert.equal(U.normalizeText('  x \n y  '), 'x\ny');
  assert.equal(U.normalizeText(null), '');
});

test('visualLength 对中日韩字符计 2', () => {
  assert.equal(U.visualLength('abcd'), 4);
  assert.equal(U.visualLength('中文'), 4);
  assert.equal(U.visualLength('a中'), 3);
});

/* ---------------- 缓存键 ---------------- */
test('hashText 稳定、定长、可区分', () => {
  const a = U.hashText('hello world');
  assert.equal(a.length, 16);
  assert.equal(a, U.hashText('hello world'));
  assert.notEqual(a, U.hashText('hello worle'));
  assert.match(a, /^[0-9a-f]{16}$/);
});

/* ---------------- XML 转义 ---------------- */
test('escapeXml / unescapeXml 往返一致', () => {
  const raw = '<a href="x">Tom & Jerry</a> \'q\'';
  assert.equal(U.unescapeXml(U.escapeXml(raw)), raw);
});

/* ---------------- 占位符保护 ---------------- */
test('protectTokens 保护 URL / 邮箱 / 模板变量', () => {
  const src = 'Visit https://example.com/a?b=1&c=2 or mail me at a.b+c@example.com, user {name} pays ${amount}.';
  const { text, tokens } = U.protectTokens(src);
  assert.ok(!text.includes('http'));
  assert.ok(!text.includes('@example.com'));
  assert.ok(tokens.length >= 3);
  const restored = U.restoreTokens(text, tokens);
  assert.equal(restored, src);
});

test('restoreTokens 容错模型改写的中括号', () => {
  const src = 'See https://example.com/docs now.';
  const { text, tokens } = U.protectTokens(src);
  const mangled = text.replace(/\u27e6(\d+)\u27e7/g, '[$1]');
  assert.equal(U.restoreTokens(mangled, tokens), src);
});

test('ensureTokensPreserved 补回被模型吞掉的占位符', () => {
  const src = 'Read https://example.com/docs and https://example.com/api';
  const { text, tokens } = U.protectTokens(src);
  const out = U.restoreTokens(U.ensureTokensPreserved(text, '\u8bf7\u9605\u8bfb\u6587\u6863', tokens), tokens);
  assert.ok(out.includes('https://example.com/docs'));
  assert.ok(out.includes('https://example.com/api'));
});

/* ---------------- 语言判定 ---------------- */
test('isProbablyTargetLang 只对可脚本判定的语言生效', () => {
  assert.equal(U.isProbablyTargetLang('\u8fd9\u662f\u4e00\u6bb5\u4e2d\u6587', 'zh-CN'), true);
  assert.equal(U.isProbablyTargetLang('This is English', 'zh-CN'), false);
  assert.equal(U.isProbablyTargetLang('This is English', 'en'), false);          // 拉丁语系不做判定
  assert.equal(U.isProbablyTargetLang('\u3053\u308c\u306f\u65e5\u672c\u8a9e\u3067\u3059', 'ja'), true);
  assert.equal(U.isProbablyTargetLang('\u8fd9\u662f\u4e2d\u6587', 'ja'), false);       // 纯汉字不能当成日文
  assert.equal(U.isProbablyTargetLang('\uc548\ub155\ud558\uc138\uc694', 'ko'), true);
});

test('isTranslatable 过滤无效片段', () => {
  const s = { minTextLength: 2, skipTargetLang: true, targetLang: 'zh-CN' };
  assert.equal(U.isTranslatable('Hello world', s), true);
  assert.equal(U.isTranslatable('a', s), false);
  assert.equal(U.isTranslatable('12345', s), false);
  assert.equal(U.isTranslatable('1,234.56 +12% (99)', s), false);
  assert.equal(U.isTranslatable('https://example.com/a/b', s), false);
  assert.equal(U.isTranslatable('a@b.com', s), false);
  assert.equal(U.isTranslatable('\u8fd9\u5df2\u7ecf\u662f\u4e2d\u6587\u4e86', s), false);
});

test('isTranslatable：社交媒体里的标识、计数、时间不送去翻译', () => {
  const s = { minTextLength: 2, skipTargetLang: true, targetLang: 'zh-CN' };
  for (const t of ['@Arnau_fnv', '@Arnau_fnv @Arnau_fn', '@zaijiang@me.ns.ci', 'Mastodon @Mastodon', 'Ea Nasir V de Ur @Arnau_fnv', '#WednesdayWisdom', '$EDEL', '#AI · #LLM',
    '27\u4e07', '3h', '1.2K', '2-1', '0:01', '4,931', 'v2']) {
    assert.equal(U.isTranslatable(t, s), false, t);
  }
  for (const t of ['Show more', '2 days ago', 'Who to follow', 'email me at @home please']) {
    assert.equal(U.isTranslatable(t, s), true, t);
  }
});

test('isProbablyTargetLang：中文句子夹英文术语仍判为中文，英文句子夹个别汉字仍判为外文', () => {
  assert.equal(U.isProbablyTargetLang('OpenAI \u53d1\u5e03 GPT \u6a21\u578b', 'zh-CN'), true);
  assert.equal(U.isProbablyTargetLang('\u6211\u7ed9\u5404\u79cd AI \u63d0\u51fa\u4e86\u4ee5\u4e0b\u63d0\u793a', 'zh-CN'), true);
  assert.equal(U.isProbablyTargetLang('I really love visiting \u5317\u4eac in the spring', 'zh-CN'), false);
});

test('sameText：模型原样返回（忽略大小写、空白、标点）视为无需显示', () => {
  assert.equal(U.sameText('Ea Nasir V de Ur', 'Ea Nasir V de Ur'), true);
  assert.equal(U.sameText('NFL', 'nfl.'), true);
  assert.equal(U.sameText('Chris Ilitch', '\u514b\u91cc\u65af\u00b7\u4f0a\u5229\u5947'), false);
  assert.equal(U.sameText('', ''), false);
});

test('baseLang：语言代码归一（含 CLD 旧代码）', () => {
  assert.equal(U.baseLang('zh-CN'), 'zh');
  assert.equal(U.baseLang('pt-BR'), 'pt');
  assert.equal(U.baseLang('iw'), 'he');
  assert.equal(U.baseLang('nb'), 'no');
  assert.equal(U.baseLang('EN_us'), 'en');
});

/* ---------------- 批量打包 ---------------- */
test('planBatches 贪心装箱且首批更小', () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ id: i, text: 'x'.repeat(100) });
  const batches = U.planBatches(items, { maxChars: 500, maxItems: 100, firstBatchChars: 200 });
  assert.ok(batches.length >= 3);
  const flat = batches.flat();
  assert.equal(flat.length, 10);
  assert.deepEqual(flat.map((i) => i.id), items.map((i) => i.id));
  assert.ok(batches[0].length < batches[1].length, '首批应更小以加快首屏');
  for (const b of batches) {
    const chars = b.reduce((n, it) => n + it.text.length + 22, 0);
    assert.ok(chars <= 500 + 122, '单批不应明显超限');
  }
});

test('planBatches 遵守 maxItems 上限', () => {
  const items = [];
  for (let i = 0; i < 7; i++) items.push({ id: i, text: 'hi' });
  const batches = U.planBatches(items, { maxChars: 100000, maxItems: 3, firstBatchChars: 100000 });
  assert.deepEqual(batches.map((b) => b.length), [3, 3, 1]);
});

test('planBatches 超长单项单独成批', () => {
  const items = [{ id: 1, text: 'x'.repeat(5000) }, { id: 2, text: 'y' }];
  const batches = U.planBatches(items, { maxChars: 300, maxItems: 10, firstBatchChars: 300 });
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].id, 1);
  assert.equal(batches[1][0].id, 2);
});

/* ---------------- 并发池 ---------------- */
test('runPool 严格限制并发宽度且处理全部任务', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  const items = Array.from({ length: 20 }, (_, i) => i);
  await U.runPool(items, 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    running--;
  });
  assert.equal(seen.length, 20);
  assert.ok(peak <= 4, '并发峰值不应超过限制，实际 ' + peak);
  assert.ok(peak >= 2, '应当真的并行执行');
});

test('runPool 支持 onError 且不中断其余任务', async () => {
  const errors = [];
  const ok = [];
  await U.runPool([1, 2, 3, 4], 2, async (n) => {
    if (n % 2 === 0) throw new Error('boom ' + n);
    ok.push(n);
  }, { onError: (e) => errors.push(e.message) });
  assert.deepEqual(ok.sort(), [1, 3]);
  assert.equal(errors.length, 2);
});

test('runPool 无 onError 时抛出首个错误', async () => {
  await assert.rejects(
    () => U.runPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('bad'); }),
    /bad/
  );
});

/* ---------------- LRU ---------------- */
test('LRUCache 按最近使用淘汰', () => {
  const c = new U.LRUCache(2);
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.get('a'), 1);         // a 变为最近使用
  c.set('c', 3);                       // 淘汰 b
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

/* ---------------- 提示词 ---------------- */
test('buildSystem 包含目标语言与自定义指令', () => {
  const s = WPT.settings.normalize({ targetLang: 'ja', sourceLang: 'en', customPrompt: '\u4fdd\u7559\u672f\u8bed' });
  const sys = WPT.prompt.buildSystem(s);
  assert.ok(sys.includes('Japanese'));
  assert.ok(sys.includes('English'));
  assert.ok(sys.includes('\u4fdd\u7559\u672f\u8bed'));
  assert.ok(sys.includes('N|text'));
});

test('buildUser 生成行协议：不做 XML 转义，段内换行编码为 <br>', () => {
  const user = WPT.prompt.buildUser([{ id: 1, text: 'Tom & <Jerry>' }, { id: 2, text: 'Line one\nLine two' }]);
  assert.equal(user, '1|Tom & <Jerry>\n2|Line one<br>Line two');
});

test('parse 解析行协议：<br> 还原换行、续行并入上一段、重复编号取第一次', () => {
  const m = WPT.prompt.parse('1|你好<br>世界\n2| A & B \n续行\n2|重复\n3|x|y');
  assert.equal(m.get(1), '你好\n世界');
  assert.equal(m.get(2), 'A & B\n续行');
  assert.equal(m.get(3), 'x|y', '只按第一个竖线切分');
  const fenced = WPT.prompt.parse('```\n1|你好\n2|世界\n```');
  assert.equal(fenced.get(2), '世界');
});

test('parse 兼容旧标签协议（并做 XML 反转义）', () => {
  assert.equal(WPT.prompt.parse('<t id="1">A &amp; B</t>').get(1), 'A & B');
  const m = WPT.prompt.parse('<t id="1">\u4f60\u597d</t>\n<t id="2">\u4e16\u754c</t>');
  assert.equal(m.get(1), '\u4f60\u597d');
  assert.equal(m.get(2), '\u4e16\u754c');
});

test('parse 容忍代码围栏 / 多余前后缀 / 属性引号', () => {
  const raw = 'Here you go:\n\u0060\u0060\u0060\n<t id=1>\u4f60\u597d</t>\n<t id=\'2\'>\u4e16\u754c</t>\n\u0060\u0060\u0060';
  const m = WPT.prompt.parse(raw);
  assert.equal(m.get(1), '\u4f60\u597d');
  assert.equal(m.get(2), '\u4e16\u754c');
});

test('parse 容忍缺失闭合标签', () => {
  const m = WPT.prompt.parse('<t id="1">\u4f60\u597d<t id="2">\u4e16\u754c');
  assert.equal(m.get(1), '\u4f60\u597d');
  assert.equal(m.get(2), '\u4e16\u754c');
});

test('parse 对垃圾输出返回空 Map（触发逐条重译）', () => {
  assert.equal(WPT.prompt.parse('Sorry, I cannot help with that.').size, 0);
  assert.equal(WPT.prompt.parse('').size, 0);
  assert.equal(WPT.prompt.parse(null).size, 0);
});

/* ---------------- URL 拼接与错误分类 ---------------- */
test('joinUrl 兼容各种 Base URL 写法', () => {
  assert.equal(U.joinUrl('https://api.openai.com/v1', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(U.joinUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(U.joinUrl('https://x.dev/v1/chat/completions', '/chat/completions'), 'https://x.dev/v1/chat/completions');
  assert.equal(U.joinUrl('http://localhost:11434/v1', '/chat/completions'), 'http://localhost:11434/v1/chat/completions');
});

test('providers.makeError 正确分类可重试 / 致命 / 可拆分', () => {
  const headers = { get: (k) => (k === 'retry-after' ? '3' : null) };
  const r = WPT.providers.makeError(429, 'slow down', headers);
  assert.equal(r.retryable, true);
  assert.equal(r.fatal, false);
  assert.equal(r.retryAfterMs, 3000);

  const auth = WPT.providers.makeError(401, 'bad key');
  assert.equal(auth.fatal, true);
  assert.equal(auth.retryable, false);

  const tooLong = WPT.providers.makeError(400, 'context length exceeded');
  assert.equal(tooLong.fatal, false);
  assert.equal(tooLong.split, true);

  const server = WPT.providers.makeError(503, 'unavailable');
  assert.equal(server.retryable, true);
});

/* ---------------- 设置规范化 ---------------- */
test('settings.normalize 补齐默认值并夹紧范围', () => {
  const s = WPT.settings.normalize({ concurrency: 999, batchChars: 5, targetLang: 'xx', markStyle: 'nope', displayMode: 'weird' });
  assert.equal(s.concurrency, 32);
  assert.equal(s.batchChars, 200);
  assert.equal(s.targetLang, 'zh-CN');
  assert.equal(s.markStyle, 'none');
  assert.equal(s.displayMode, 'bilingual');
  assert.equal(s.provider, 'openai');
  assert.equal(s.useCache, true);
});

test('settings.normalize 保证首批不超过单批上限', () => {
  const s = WPT.settings.normalize({ batchChars: 300, firstBatchChars: 4000 });
  assert.ok(s.firstBatchChars <= s.batchChars);
});

test('settings.forContent 不泄露密钥', () => {
  const s = WPT.settings.normalize({ apiKey: 'sk-secret' });
  const view = WPT.settings.forContent(s);
  assert.equal(view.apiKey, undefined);
  assert.equal(view.targetLang, 'zh-CN');
});

test('describeError 给出可读中文提示', () => {
  assert.match(U.describeError(WPT.providers.makeError(401, '')), /密钥/);
  assert.match(U.describeError(WPT.providers.makeError(429, '')), /速率/);
  assert.match(U.describeError(WPT.providers.makeError(404, '')), /模型/);
});

/* ---------------- 语言表 ---------------- */
test('语言表结构完整且可查询', () => {
  assert.ok(WPT.LANGUAGES.length > 50);
  for (const l of WPT.LANGUAGES) {
    assert.match(l.code, /^[a-zA-Z-]+$/);
    assert.ok(l.native && l.name && l.script);
  }
  assert.equal(WPT.langName('zh-CN'), 'Chinese (Simplified)');
  assert.match(WPT.langName('ja', true), /Japanese/);
});

test('预设服务商字段完整', () => {
  for (const p of WPT.PRESETS) {
    assert.ok(p.id && p.label);
    assert.ok(p.provider === 'openai' || p.provider === 'anthropic');
  }
  assert.ok(WPT.PRESETS.some((p) => p.baseUrl.includes('deepseek')));
});

/* ---------------- 设置迁移与网站名单 ---------------- */
test('settings：旧版默认批次大小一次性迁移，用户自定义值与已迁移的设置不动', () => {
  const S = WPT.settings;
  const old = S.normalize({ batchChars: 1200, batchItems: 16 });
  assert.equal(old.batchChars, 2000);
  assert.equal(old.batchItems, 24);
  assert.equal(old.settingsRev, WPT.SETTINGS_REV);
  const custom = S.normalize({ batchChars: 1500, batchItems: 10 });
  assert.equal(custom.batchChars, 1500);
  assert.equal(custom.batchItems, 10);
  assert.equal(S.normalize({ batchChars: 1200, batchItems: 16, settingsRev: 2 }).batchChars, 1200, '迁移后用户再改回 1200 应保留');
});

test('settings：DeepSeek 官方的 deepseek-chat 别名迁移为 deepseek-flash，其他平台与已迁移设置不动', () => {
  const S = WPT.settings;
  assert.equal(S.normalize({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', settingsRev: 2 }).model, 'deepseek-flash');
  assert.equal(S.normalize({ baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-chat', settingsRev: 2 }).model, 'deepseek-chat');
  assert.equal(S.normalize({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', settingsRev: 3 }).model, 'deepseek-chat');
  assert.equal(WPT.PRESETS.find((p) => p.id === 'deepseek').model, 'deepseek-flash');
});

test('settings：网站名单规范化与匹配（含子域名）', () => {
  const S = WPT.settings;
  const s = S.normalize({ autoTranslate: true, autoSites: 'https://www.Example.com/path\n*.foo.org, 127.0.0.1:8080\nexample.com', neverSites: ['ads.example.com'] });
  assert.deepEqual(s.autoSites, ['example.com', 'foo.org', '127.0.0.1']);
  assert.equal(S.autoAllowed(s, 'news.example.com'), true);
  assert.equal(S.autoAllowed(s, 'notexample.com'), false, '不能按后缀误匹配');
  assert.equal(S.autoAllowed(s, 'x.ads.example.com'), false, '排除名单优先');
  assert.equal(S.autoAllowed(S.normalize({ autoTranslate: true }), 'any.com'), true, '名单为空 = 所有网站');
  assert.equal(S.autoAllowed(S.normalize({ autoTranslate: false, autoSites: ['a.com'] }), 'a.com'), false, '总开关优先');
});

test('settings：弹出面板「自动翻译此网站」开关不会意外变成全站自动翻译', () => {
  const S = WPT.settings;
  const off = S.normalize({});
  const on = S.normalize(Object.assign({}, off, S.siteAutoPatch(off, 'www.a.com', true)));
  assert.equal(on.autoTranslate, true);
  assert.deepEqual(on.autoSites, ['a.com']);
  const back = S.normalize(Object.assign({}, on, S.siteAutoPatch(on, 'a.com', false)));
  assert.equal(back.autoTranslate, false, '名单清空时关闭总开关，而不是变成所有网站');
  const all = S.normalize({ autoTranslate: true });
  const excl = S.normalize(Object.assign({}, all, S.siteAutoPatch(all, 'b.com', false)));
  assert.equal(S.autoAllowed(excl, 'b.com'), false);
  assert.equal(S.autoAllowed(excl, 'c.com'), true);
});

test('isReasoningModel：识别推理模型，不误伤普通对话模型', () => {
  for (const m of ['deepseek-reasoner', 'deepseek-r1', 'o3-mini', 'openai/o1', 'gpt-5', 'qwq-32b', 'qwen3-235b-a22b-thinking-2507']) assert.equal(WPT.isReasoningModel(m), true, m);
  for (const m of ['deepseek-chat', 'gpt-4o-mini', 'gpt-5-chat-latest', 'claude-3-5-haiku-latest', 'glm-4-flash', 'llama-3.3-70b-versatile', '']) assert.equal(WPT.isReasoningModel(m), false, m);
});
