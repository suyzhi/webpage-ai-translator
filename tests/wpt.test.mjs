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
  'src/shared/site-rules.js',
  'src/shared/concurrency.js',
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
  for (const t of ['2 days ago', 'Who to follow', 'email me at @home please']) {
    assert.equal(U.isTranslatable(t, s), true, t);
  }
});

test('isTranslatable：日历刻度与人人认得的界面词不翻（GitHub 贡献图「Jan 1月」「More 较多」）', () => {
  const s = { minTextLength: 2, skipTargetLang: true, targetLang: 'zh-CN' };
  for (const t of ['Jan', 'Mon', 'Wed', 'Oct 18, 2026', 'October 2026', 'Mon, 5 Oct', 'Mon 10:30 AM', 'Sept. 3',
    'More', 'Less', 'Sign in', 'Show more', 'Read more \u2192', 'See all \u203a']) {
    assert.equal(U.isTranslatable(t, s), false, t);
  }
  for (const t of ['Monday blues are real', 'January sales start now', 'More than a feeling', 'Sign in to continue', 'Less is more',
    'March Madness', 'Mon Amour', 'Dec 2026 release notes', 'Sat on the mat', 'Today', 'Learn how we count contributions']) {
    assert.equal(U.isTranslatable(t, s), true, t);
  }
});

test('pickTerms：挑多段反复出现的术语，单复数只留一个，月份和停用词不算', () => {
  const texts = ['Attach a shadow root to the host element.', 'The shadow root holds the shadow tree.', 'Each shadow root is private.',
    'Components render UI.', 'A component returns markup.', 'Reuse components freely.', 'One component per file.', 'Small components win.', 'Name the component.', 'Released in March 2024.', 'March 2025 update.', 'Since March.'];
  const t = U.pickTerms(texts, 8).map((x) => x.term.toLowerCase());
  assert.ok(t.includes('shadow root'), JSON.stringify(t));
  assert.equal(t.filter((x) => /^components?$/.test(x)).length, 1, JSON.stringify(t));
  assert.ok(!t.some((x) => /march/.test(x)), JSON.stringify(t));
  assert.deepEqual(U.pickTerms(texts, 8, 4), []);
  assert.ok(U.pickTerms(texts, 8)[0].sample.length <= 90);
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

test('settings.normalize 清洗网站规则：主机名规范化、丢弃无效项、去重', () => {
  const s = WPT.settings.normalize({
    siteRules: {
      'Example.COM': 'always',
      'https://news.example.org/path?q=1': 'never',
      'localhost:8080': 'always',
      '*.wild.dev': 'never',
      'bad value.com': 'always',
      'a*b.com': 'never',
      'http://': 'never',
      '[::1]': 'always',
      'ok.test': 'sometimes',
      'example.com': 'never'            // 与第一项规范化后重复：后者覆盖前者
    }
  });
  assert.deepEqual(s.siteRules, {
    'example.com': 'never',
    'news.example.org': 'never',
    'localhost': 'always',
    'wild.dev': 'never'
  });
  assert.deepEqual(WPT.settings.normalize({}).siteRules, {});
  assert.deepEqual(WPT.settings.normalize({ siteRules: null }).siteRules, {});
  assert.deepEqual(WPT.settings.normalize({ siteRules: ['example.com'] }).siteRules, {});
  assert.deepEqual(WPT.settings.normalize({ siteRules: 'example.com' }).siteRules, {});
});

test('settings.normalize 网站规则数量有上限，已有规则不被挤掉', () => {
  const raw = {};
  for (let i = 0; i < WPT.SITE_RULES_MAX + 20; i++) raw['site' + i + '.com'] = 'never';
  raw['site0.com'] = 'always';         // 已有主机的更新不占新名额
  const rules = WPT.settings.normalize({ siteRules: raw }).siteRules;
  assert.equal(Object.keys(rules).length, WPT.SITE_RULES_MAX);
  assert.equal(rules['site0.com'], 'always');
  assert.equal(rules['site' + (WPT.SITE_RULES_MAX - 1) + '.com'], 'never');
  assert.equal(rules['site' + WPT.SITE_RULES_MAX + '.com'], undefined);
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
  // DeepSeek：余额不足 402、模型名写错 400（列出可用模型）都应是致命错误，并给出可操作的中文提示
  const broke = WPT.providers.makeError(402, '{"error":{"message":"Insufficient Balance"}}');
  assert.equal(broke.fatal, true);
  assert.match(U.describeError(broke), /余额不足.*充值/);
  const typo = WPT.providers.makeError(400, '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-flsh. (request_id: x)"}}');
  assert.equal(typo.fatal, true);
  assert.equal(typo.split, false);
  assert.match(U.describeError(typo), /模型名有误.*deepseek-flash, deepseek-v4-pro/);
  // 真正的上下文过长仍然拆分重试
  const long = WPT.providers.makeError(400, 'This model\'s maximum context length is 65536 tokens');
  assert.equal(long.split, true);
  assert.equal(long.fatal, false);
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

/* ---------------- 网站规则 ---------------- */
test('normalizeHost 提取主机名，拒绝无法识别的输入', () => {
  assert.equal(U.normalizeHost('  WWW.Example.COM  '), 'www.example.com');
  assert.equal(U.normalizeHost('https://user:pw@Docs.Example.com:8443/a/b?c#d'), 'docs.example.com');
  assert.equal(U.normalizeHost('//cdn.example.com/x.js'), 'cdn.example.com');
  assert.equal(U.normalizeHost('*.example.com'), 'example.com');
  assert.equal(U.normalizeHost('*://Example.com/*'), 'example.com', '粘贴匹配模式');
  assert.equal(U.normalizeHost('https://*.example.com/*'), 'example.com');
  assert.equal(U.normalizeHost('example.com.'), 'example.com');
  assert.equal(U.normalizeHost('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(U.normalizeHost('192.168.1.10'), '192.168.1.10');
  assert.equal(U.normalizeHost('my_site.example.com'), 'my_site.example.com');
  for (const bad of ['', null, undefined, '*', '*.', 'a.*.com', 'exa*mple.com', '[::1]', 'http://[::1]:8080/',
    'has space.com', 'about:blank', 'chrome://extensions', 'ftp://example.com', 'file:///C:/a.html',
    '-lead.com', 'trail-.com', 'a..b.com', '__proto__', 'x'.repeat(64) + '.com']) {
    assert.equal(U.normalizeHost(bad), '', '应拒绝：' + bad);
  }
});

test('siteRuleFor 子域名继承，最具体的规则优先', () => {
  const rules = { 'example.com': 'never', 'b.example.com': 'always', 'cn': 'never', '10.0.0.1': 'always' };
  assert.equal(U.siteRuleFor('example.com', rules), 'never');
  assert.equal(U.siteRuleFor('www.example.com', rules), 'never');
  assert.equal(U.siteRuleFor('b.example.com', rules), 'always');
  assert.equal(U.siteRuleFor('a.b.example.com', rules), 'always');
  assert.equal(U.siteRuleFor('A.B.Example.COM.', rules), 'always');
  assert.equal(U.siteRuleFor('notexample.com', rules), null, '不能按字符串后缀误匹配');
  assert.equal(U.siteRuleFor('news.example.cn', rules), 'never');
  assert.equal(U.siteRuleFor('10.0.0.1', rules), 'always');
  assert.equal(U.siteRuleFor('other.org', rules), null);
  assert.equal(U.siteRuleFor('', rules), null);
  assert.equal(U.siteRuleFor('constructor', rules), null, '不能命中原型链上的属性');
  assert.equal(U.siteRuleFor('example.com', null), null);
  assert.deepEqual(U.matchSiteRule('x.a.b.example.com', rules), { host: 'b.example.com', rule: 'always' });
});

test('autoStartFor 优先级：从不翻译 > 总是翻译 / 全局自动翻译', () => {
  const rules = { 'never.com': 'never', 'always.com': 'always' };
  const on = { autoTranslate: true, siteRules: rules };
  const off = { autoTranslate: false, siteRules: rules };
  assert.equal(U.autoStartFor(on, 'www.never.com'), false);
  assert.equal(U.autoStartFor(on, 'always.com'), true);
  assert.equal(U.autoStartFor(on, 'other.com'), true);
  assert.equal(U.autoStartFor(off, 'never.com'), false);
  assert.equal(U.autoStartFor(off, 'docs.always.com'), true);
  assert.equal(U.autoStartFor(off, 'other.com'), false);
  assert.equal(U.autoStartFor(off, ''), false);
  assert.equal(U.autoStartFor(null, 'other.com'), false);
});

const ALL_PAGES = ['http://*/*', 'https://*/*'];
/* Chrome 匹配模式的保守子集：一个无效模式会让 registerContentScripts 整体失败 */
const VALID_PATTERN = /^(\*:\/\/(\*\.)?[a-z0-9]([a-z0-9_.-]*[a-z0-9])?\/\*|https?:\/\/\*\/\*)$/;

test('autoRegistrationFor：自动翻译开启 -> 全部页面并排除「从不翻译」', () => {
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: true }), { matches: ALL_PAGES });
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: true, siteRules: { 'example.cn': 'never', 'keep.com': 'always' } }), {
    matches: ALL_PAGES,
    excludeMatches: ['*://example.cn/*', '*://*.example.cn/*']
  });
  // IP 地址没有子域名
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: true, siteRules: { '10.0.0.1': 'never' } }).excludeMatches, ['*://10.0.0.1/*']);
});

test('autoRegistrationFor：自动翻译关闭 -> 只匹配「总是翻译」，没有则不注册', () => {
  assert.equal(U.autoRegistrationFor({ autoTranslate: false }), null);
  assert.equal(U.autoRegistrationFor({ autoTranslate: false, siteRules: { 'example.cn': 'never' } }), null);
  assert.equal(U.autoRegistrationFor(null), null);
  assert.deepEqual(U.autoRegistrationFor({ siteRules: { 'news.example.com': 'always', 'other.org': 'never' } }), {
    matches: ['*://news.example.com/*', '*://*.news.example.com/*']
  });
  // 「总是翻译」范围内的「从不翻译」子域名需要排除
  assert.deepEqual(U.autoRegistrationFor({ siteRules: { 'example.com': 'always', 'ads.example.com': 'never' } }), {
    matches: ['*://example.com/*', '*://*.example.com/*'],
    excludeMatches: ['*://ads.example.com/*', '*://*.ads.example.com/*']
  });
});

test('autoRegistrationFor：「从不翻译」下有「总是翻译」子域名时只排除自身', () => {
  const rules = { 'example.com': 'never', 'docs.example.com': 'always' };
  // 若排除 *.example.com，docs.example.com 也会被排除，违背「最具体的规则优先」
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: true, siteRules: rules }), {
    matches: ALL_PAGES,
    excludeMatches: ['*://example.com/*']
  });
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: false, siteRules: rules }), {
    matches: ['*://docs.example.com/*', '*://*.docs.example.com/*']
  });
});

test('autoRegistrationFor：脏数据也不会生成无效的匹配模式', () => {
  const dirty = {
    'https://Mixed.Case.com/path': 'always', '*.wild.org': 'never', 'bad host.com': 'always', 'a*b.com': 'never',
    '[::1]': 'always', 'about:blank': 'never', 'bücher.de': 'always', 'localhost:3000': 'always', '': 'always'
  };
  for (const auto of [true, false]) {
    const reg = U.autoRegistrationFor({ autoTranslate: auto, siteRules: dirty });
    const all = reg.matches.concat(reg.excludeMatches || []);
    assert.ok(all.length > 0);
    for (const p of all) assert.match(p, VALID_PATTERN);
  }
  assert.deepEqual(U.autoRegistrationFor({ siteRules: dirty }).matches, [
    '*://mixed.case.com/*', '*://*.mixed.case.com/*',
    '*://xn--bcher-kva.de/*', '*://*.xn--bcher-kva.de/*',
    '*://localhost/*', '*://*.localhost/*'
  ]);
  assert.equal(U.autoRegistrationFor({ siteRules: 'garbage' }), null);
  assert.deepEqual(U.autoRegistrationFor({ autoTranslate: true, siteRules: [1, 2] }), { matches: ALL_PAGES });
});

/* ---------------- 设置迁移与推理模型识别 ---------------- */
test('settings：旧版默认批次大小一次性迁移，用户自定义值与已迁移的设置不动', () => {
  const S = WPT.settings;
  const old = S.normalize({ batchChars: 1200, batchItems: 16 });
  assert.equal(old.batchChars, 5000);
  assert.equal(old.batchItems, 64);
  const prev = S.normalize({ batchChars: 2000, batchItems: 24, settingsRev: 3 });
  assert.equal(prev.batchChars, 5000, '上一版默认值同样升级');
  assert.equal(prev.batchItems, 64);
  assert.equal(S.normalize({ batchChars: 2000, batchItems: 24, settingsRev: 4 }).batchChars, 2000, '新版里用户主动设成 2000 应保留');
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

test('settings：兼容迁移旧版 autoSites / neverSites 到 siteRules', () => {
  const S = WPT.settings;
  const onlyList = S.normalize({ autoTranslate: true, autoSites: ['https://Example.com/path', '*.foo.org'], neverSites: ['ads.example.com'], settingsRev: 5 });
  assert.equal(onlyList.autoTranslate, false, '旧版 autoSites 非空表示仅翻这些站点，迁移后关闭全局开关');
  assert.deepEqual(onlyList.siteRules, { 'example.com': 'always', 'foo.org': 'always', 'ads.example.com': 'never' });
  assert.equal(onlyList.autoSites, undefined);
  assert.equal(onlyList.neverSites, undefined);

  const allButNever = S.normalize({ autoTranslate: true, autoSites: [], neverSites: ['bilibili.com'], settingsRev: 5 });
  assert.equal(allButNever.autoTranslate, true, '旧版 autoSites 为空时保留全站自动翻译');
  assert.deepEqual(allButNever.siteRules, { 'bilibili.com': 'never' });

  const offWithList = S.normalize({ autoTranslate: false, autoSites: ['a.com'], neverSites: ['b.com'], settingsRev: 5 });
  assert.equal(offWithList.autoTranslate, false);
  assert.deepEqual(offWithList.siteRules, { 'b.com': 'never' }, '旧版总开关关闭时 autoSites 不应自动激活');
});

test('isReasoningModel：识别推理模型，不误伤普通对话模型', () => {
  for (const m of ['deepseek-reasoner', 'deepseek-r1', 'o3-mini', 'openai/o1', 'gpt-5', 'qwq-32b', 'qwen3-235b-a22b-thinking-2507']) assert.equal(WPT.isReasoningModel(m), true, m);
  for (const m of ['deepseek-chat', 'gpt-4o-mini', 'gpt-5-chat-latest', 'claude-3-5-haiku-latest', 'glm-4-flash', 'llama-3.3-70b-versatile', '']) assert.equal(WPT.isReasoningModel(m), false, m);
});

test('hasTargetScript：校验非拉丁目标语言的书写系统，避免错误 lang 属性误杀英文', () => {
  assert.equal(U.hasTargetScript('Hello world from an English article', 'zh-CN'), false);
  assert.equal(U.hasTargetScript('今天天气真好', 'zh-CN'), true);
  assert.equal(U.hasTargetScript('OpenAI 发布新模型', 'zh-CN'), true);
  assert.equal(U.hasTargetScript('Hello world', 'ja'), false);
  assert.equal(U.hasTargetScript('東京の天気', 'ja'), true);
  assert.equal(U.hasTargetScript('Hello world', 'ko'), false);
  assert.equal(U.hasTargetScript('안녕하세요', 'ko'), true);
  assert.equal(U.hasTargetScript('Bonjour le monde', 'en'), true, '拉丁语系目标不做脚本排除');
});

test('isLocalUrl / fmtTokens：共享辅助函数', () => {
  for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://0.0.0.0:8000', 'http://[::1]:8080/v1', 'https://localhost']) {
    assert.equal(U.isLocalUrl(ok), true, ok);
  }
  for (const bad of ['https://api.deepseek.com/v1', 'http://localhost.evil.com/v1', 'http://127.0.0.1.evil.com', '', null]) {
    assert.equal(U.isLocalUrl(bad), false, String(bad));
  }
  assert.equal(U.fmtTokens(0), '0');
  assert.equal(U.fmtTokens(999), '999');
  assert.equal(U.fmtTokens(1250), '1.3K');
  assert.equal(U.fmtTokens(12500), '13K');
  assert.equal(U.fmtTokens(1500000), '1.50M');
});

test('模块拆分与消息常量：siteRules / concurrency / MSG 完整暴露', () => {
  assert.equal(WPT.siteRules.normalizeHost, U.normalizeHost);
  assert.equal(WPT.siteRules.autoRegistrationFor, U.autoRegistrationFor);
  assert.equal(WPT.concurrency.runPool, U.runPool);
  assert.equal(WPT.concurrency.Limiter, U.Limiter);
  assert.equal(WPT.concurrency.LRUCache, U.LRUCache);
  for (const k of ['STATE', 'STATE_CHANGED', 'FRAMES', 'FRAME_CMD', 'FRAME_STATUS', 'OPEN_OPTIONS']) {
    assert.match(WPT.MSG[k], /^wpt:/, 'MSG.' + k);
  }
});
