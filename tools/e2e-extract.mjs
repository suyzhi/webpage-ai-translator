#!/usr/bin/env node
/*
 * 抽取阶段压力测试（零依赖）：在真实无头浏览器里加载 extract.js，对
 *  1) demo/test-page.html 的真实结构；
 *  2) 合成的大规模段落页（500 / 2000 / 5000 / 6000）；
 *  3) 隐藏元素 / translate=no / .notranslate / 已是目标语言 等边界；
 * 逐项断言抽取结果，并报告耗时以确认复杂度线性。
 *
 * 用法：node tools/e2e-extract.mjs
 * 退出码：0 通过；1 断言失败；2 未找到浏览器。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { freePort, waitFor, httpJson, launchBrowser, killTree, spawnMockServer } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = !!process.env.WPT_E2E_KEEP;
const log = (...args) => console.log('[extract]', ...args);
const sleep = (ms) => delay(ms);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

const SOURCES = [
  'src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js',
  'src/content/extract.js', 'src/content/render.js'
].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));

async function inject(cdp, session) {
  for (const src of SOURCES) await cdp.evalIn(session, src);
}

const HEAD = '(function(){ const NS = globalThis.WPT; if (!NS || !NS.Extractor) return { error: "extract.js 未加载" }; ';

async function main() {
  const mockPort = await freePort();
  const MOCK = 'http://127.0.0.1:' + mockPort;
  let mock = null;
  let browser = null;
  let exitCode = 0;

  try {
    mock = spawnMockServer({ root: ROOT, port: mockPort });
    await waitFor('静态服务就绪', async () => { await httpJson(MOCK + '/__stats'); return true; }, 15000, 150);

    browser = await launchBrowser({ profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-extract-')), extensionDebug: false });
    const cdp = browser.cdp;
    log('浏览器：' + browser.browserPath);

    const page = await cdp.send('Target.createTarget', { url: MOCK + '/demo/test-page.html' });
    const session = (await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, session);
    await waitFor('测试页加载', async () => (await cdp.evalIn(session, 'document.readyState')) === 'complete', 20000);
    await inject(cdp, session);

    // 1) 真实压力页：结构正确性
    const real = await cdp.evalIn(session, HEAD +
      'const s = NS.settings.forContent(NS.settings.normalize({ targetLang: "zh-CN" }));' +
      'const t0 = performance.now(); const units = NS.Extractor.collect(document.body, s); const ms = performance.now() - t0;' +
      'const texts = units.map(function(u){ return u.text; });' +
      'const ids = units.map(function(u){ return u.id; });' +
      'const norm = texts.every(function(t){ return t === t.trim() && t.length > 0 && !/ {2,}/.test(t); });' +
      'const ordered = NS.Extractor.byViewportPriority(units.slice());' +
      'return { count: units.length, ms: Math.round(ms * 100) / 100, norm: norm, uniqueIds: new Set(ids).size === ids.length,' +
      ' sameSet: ordered.length === units.length && new Set(ordered.map(function(u){ return u.id; })).size === ids.length,' +
      ' hasCode: texts.some(function(t){ return t.indexOf("function translate(items") >= 0; }),' +
      ' hasNoTranslate: texts.some(function(t){ return t.indexOf("translate=") >= 0; }),' +
      ' hasNotranslateClass: texts.some(function(t){ return t.indexOf("notranslate") >= 0; }),' +
      ' hasChinese: texts.some(function(t){ return t.indexOf("这段文字已经是中文了") >= 0; }),' +
      ' hasTable: texts.some(function(t){ return t.indexOf("Raise it if your provider") >= 0; }),' +
      ' hasInlineCodeSentence: texts.some(function(t){ return t.indexOf("Inline code such as") >= 0; }),' +
      ' hasList: texts.some(function(t){ return t.indexOf("de-duplicated") >= 0; }),' +
      ' sample: texts.slice(0, 5) }; })()');
    check('压力页抽取不为空', real.count > 0, 'count=' + real.count);
    check('压力页抽取无异常', !real.error, real.error);
    check('单元文本均已规范化', real.norm);
    check('单元 id 唯一', real.uniqueIds);
    check('视口排序不丢单元', real.sameSet);
    check('代码块被跳过', !real.hasCode);
    check('translate=no 被跳过', !real.hasNoTranslate);
    check('.notranslate 被跳过', !real.hasNotranslateClass);
    check('已是目标语言被跳过', !real.hasChinese);
    check('表格单元格被抽取', real.hasTable);
    check('行内 code 句子被抽取', real.hasInlineCodeSentence);
    check('列表项被抽取', real.hasList);
    log('压力页：' + real.count + ' 单元，' + real.ms + 'ms；样例=' + JSON.stringify(real.sample));

    // 2) 合成规模：线性度与上限
    const scale = {};
    for (const n of [500, 2000, 5000, 6000]) {
      scale[n] = await cdp.evalIn(session, HEAD +
        'const n = ' + n + '; const frag = document.createDocumentFragment();' +
        'for (let i = 0; i < n; i++) { const p = document.createElement("p"); p.textContent = "Paragraph number " + i + " with enough English words to be translated."; frag.appendChild(p); }' +
        'document.body.textContent = ""; document.body.appendChild(frag);' +
        'const t0 = performance.now(); const units = NS.Extractor.collect(document.body, NS.settings.forContent(NS.settings.normalize({ targetLang: "zh-CN" })));' +
        'const ms = performance.now() - t0;' +
        'return { n: n, count: units.length, ms: ms, perUnitUs: units.length ? ms * 1000 / units.length : 0 }; })()');
      log('规模 ' + n + '：抽取 ' + scale[n].count + ' 单元，' + Math.round(scale[n].ms) + 'ms（' + Math.round(scale[n].perUnitUs) + 'µs/单元）');
    }
    check('500 段全部抽取', scale[500].count === 500, 'count=' + scale[500].count);
    check('2000 段全部抽取', scale[2000].count === 2000, 'count=' + scale[2000].count);
    check('5000 段全部抽取', scale[5000].count === 5000, 'count=' + scale[5000].count);
    check('超出上限时封顶 MAX_UNITS=5000', scale[6000].count === 5000, 'count=' + scale[6000].count);
    const growth = scale[5000].ms / Math.max(0.5, scale[500].ms);
    check('耗时随规模近似线性（5000/500 < 30x）', growth < 30, growth.toFixed(1) + 'x');

    // 3) 边界结构
    const edgeHtml = '<div style="display:none"><p>Hidden paragraph must not appear.</p></div>'
      + '<p>Visible paragraph one.</p>'
      + '<p style="visibility:hidden">Invisible paragraph must not appear.</p>'
      + '<p translate="no">Skipped by translate attr.</p>'
      + '<p class="notranslate">Skipped by class.</p>'
      + '<div><span>Inline only sentence that should merge into its block.</span></div>'
      + '<p>Same text.</p><p>Same text.</p>'
      + '<main style="display:contents"><div style="display:contents"><p>Paragraph inside display contents wrappers.</p></div></main>'
      + '<blockquote class="abstract mathjax">Abstract with a lowercase mathjax marker class.</blockquote>'
      + '<div class="MathJax_Display">display math block must be skipped</div>'
      + '<a href="#c" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Skip to main content</a>'
      + '<button><span style="position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden">Main menu</span>☰</button>'
      + '<span style="position:absolute;clip-path:inset(50%)">Screen reader only label</span>'
      + '<div style="position:absolute;left:0;top:0;width:300px">Absolutely positioned but visible caption text.</div>'
      + '<p>Docs prose: close tags like <code>&lt;br /&gt;</code> and wrap siblings in <code>&lt;div&gt;</code>, <code>&lt;/div&gt;</code> or a <code>&lt;slot&gt;</code>.</p>'
      + '<div>&lt;div class="row"&gt;&lt;span&gt;Serialized markup&lt;/span&gt;&lt;/div&gt;</div>'
      + '<p>Collapsed source newline,\n\nstill one visual line.</p>'
      + '<p style="white-space:pre-line">Kept newline first line\nsecond line.</p>'
      + '<div class="highlight highlight-source-js"><div>const answer = computeTheValue(input);</div></div>'
      + '<ul><li class="community-highlight-card"><h2>Monthly current events megathread for readers</h2></li></ul>'
      + '<p>Use the operators <code class="docutils literal notranslate"><span class="pre">+</span></code>, <code class="notranslate">-</code> and <span translate="no">*</span> for arithmetic.</p>'
      + '<p><span class="notranslate">BrandOnlyName Widget</span></p>'
      + '<a href="#" style="display:block;font-size:0">Zero size card title<span style="font-size:14px"> but this child is readable</span></a>'
      + '<ul style="font-size:0"><li style="display:inline-block;font-size:16px">Inline block reset item text</li></ul>'
      + '<dialog open><p>Open dialog modal text must be extracted.</p></dialog>'
      + '<dialog><p>Closed dialog text must stay hidden.</p></dialog>'
      + '<div class="highlight"><p>Editorial highlight callout without pre block.</p></div>'
      + '<article class="has-katex"><p>Article wrapped with has-katex class.</p></article>'
      + '<h2 style="display:flex;align-items:center;gap:6px"><span>●</span>Flex Heading</h2>';
    const edge = await cdp.evalIn(session, HEAD +
      'document.body.textContent = ""; document.body.innerHTML = ' + JSON.stringify(edgeHtml) + ';' +
      'const units = NS.Extractor.collect(document.body, NS.settings.forContent(NS.settings.normalize({ targetLang: "zh-CN" })));' +
      'const texts = units.map(function(u){ return u.text; });' +
      'return { count: units.length, texts: texts,' +
      ' hasHidden: texts.some(function(t){ return t.indexOf("Hidden paragraph") >= 0; }),' +
      ' hasInvisible: texts.some(function(t){ return t.indexOf("Invisible paragraph") >= 0; }),' +
      ' hasSkipped: texts.some(function(t){ return t.indexOf("Skipped by") >= 0; }),' +
      ' hasVisible: texts.some(function(t){ return t.indexOf("Visible paragraph one") >= 0; }),' +
      ' hasInlineOnly: texts.some(function(t){ return t.indexOf("Inline only sentence") >= 0; }),' +
      ' duplicateKept: texts.filter(function(t){ return t === "Same text."; }).length,' +
      ' hasContents: texts.some(function(t){ return t.indexOf("inside display contents") >= 0; }),' +
      ' contentsRendered: NS.Extractor.isRendered(document.querySelector("main")),' +
      ' hasMathjaxMarker: texts.some(function(t){ return t.indexOf("lowercase mathjax marker") >= 0; }),' +
      ' hasMathDisplay: texts.some(function(t){ return t.indexOf("display math block") >= 0; }),' +
      ' hasSrOnly: texts.some(function(t){ return /Skip to main|Main menu|Screen reader only/.test(t); }),' +
      ' hasAbsCaption: texts.some(function(t){ return t.indexOf("Absolutely positioned but visible") >= 0; }),' +
      ' hasDocsProse: texts.some(function(t){ return t.indexOf("Docs prose") >= 0; }),' +
      ' hasSerialized: texts.some(function(t){ return t.indexOf("Serialized markup") >= 0; }),' +
      ' collapsedNl: texts.filter(function(t){ return t.indexOf("Collapsed source newline") >= 0; })[0],' +
      ' keptNl: texts.filter(function(t){ return t.indexOf("Kept newline") >= 0; })[0],' +
      ' hasHlCode: texts.some(function(t){ return t.indexOf("computeTheValue") >= 0; }),' +
      ' hasHlCard: texts.some(function(t){ return t.indexOf("Monthly current events") >= 0; }),' +
      ' ops: texts.filter(function(t){ return t.indexOf("Use the operators") >= 0; })[0],' +
      ' hasBrandOnly: texts.some(function(t){ return t.indexOf("BrandOnlyName") >= 0; }),' +
      ' hasOpenDialog: texts.some(function(t){ return t.indexOf("Open dialog modal") >= 0; }),' +
      ' hasClosedDialog: texts.some(function(t){ return t.indexOf("Closed dialog text") >= 0; }),' +
      ' hasEditorialHl: texts.some(function(t){ return t.indexOf("Editorial highlight callout") >= 0; }),' +
      ' hasKatexWrap: texts.some(function(t){ return t.indexOf("Article wrapped with has-katex") >= 0; }),' +
      ' hasFlexHeading: texts.some(function(t){ return t.indexOf("Flex Heading") >= 0; }),' +
      ' zero: texts.filter(function(t){ return /Zero size card|child is readable|Inline block reset/.test(t); }) }; })()');
    check('display:none 被跳过', !edge.hasHidden, JSON.stringify(edge.texts));
    check('visibility:hidden 被跳过', !edge.hasInvisible);
    check('translate=no / .notranslate 被跳过', !edge.hasSkipped);
    check('可见段落被保留', edge.hasVisible);
    check('纯行内块被合并抽取', edge.hasInlineOnly);
    check('抽取阶段保留重复文本（由引擎去重）', edge.duplicateKept === 2, 'dup=' + edge.duplicateKept);
    check('display:contents 包装层内的段落被抽取', edge.hasContents);
    check('display:contents 节点视为已渲染（增量扫描）', edge.contentsRendered);
    check('小写 mathjax 标记类的块被抽取（arXiv 摘要）', edge.hasMathjaxMarker);
    check('MathJax_Display 公式块被跳过', !edge.hasMathDisplay);
    check('仅屏幕阅读器可见的文字（clip / clip-path / 1px）被跳过', !edge.hasSrOnly, JSON.stringify(edge.texts));
    check('普通的绝对定位文字照常抽取', edge.hasAbsCaption);
    check('讲解 HTML 标签的正文（标签写在 <code> 里）照常抽取', edge.hasDocsProse, JSON.stringify(edge.texts));
    check('裸露的序列化 HTML 仍被跳过', !edge.hasSerialized);
    check('代码高亮容器（.highlight）被跳过，类名里只是含 highlight 的正文卡片照常抽取', !edge.hasHlCode && edge.hasHlCard, JSON.stringify(edge.texts));
    check('句中的 notranslate 行内片段（Sphinx 行内代码）原样保留在句子里', edge.ops === 'Use the operators +, - and * for arithmetic.', JSON.stringify(edge.ops));
    check('整块只有 notranslate 片段时不送翻', !edge.hasBrandOnly);
    check('字号为 0 的文字不送翻，子元素重设字号的照常抽取', edge.zero.length === 2 && !edge.zero.some(function (t) { return /Zero size/.test(t); }) &&
      edge.zero.some(function (t) { return /child is readable/.test(t); }) && edge.zero.some(function (t) { return /Inline block reset/.test(t); }), JSON.stringify(edge.zero));
    check('源码换行在 white-space:normal 下按空格处理，pre-line 下保留', edge.collapsedNl === 'Collapsed source newline, still one visual line.' &&
      edge.keptNl === 'Kept newline first line\nsecond line.', JSON.stringify([edge.collapsedNl, edge.keptNl]));
    check('打开的 <dialog open> 正常抽取，关闭的 <dialog> 跳过', edge.hasOpenDialog && !edge.hasClosedDialog);
    check('非代码 .highlight 提示框、.has-katex 外壳、横排 flex 标题均正常抽取', edge.hasEditorialHl && edge.hasKatexWrap && edge.hasFlexHeading);

    // 4) Shadow DOM：open 影子根、嵌套影子根、具名 slot 投影的宿主子元素
    const shadow = await cdp.evalIn(session, HEAD +
      'document.body.textContent = "";' +
      'const a = document.createElement("x-card"); document.body.appendChild(a);' +
      'a.attachShadow({ mode: "open" }).innerHTML = "<div><h2>Heading inside an open shadow root</h2><p>Paragraph inside the shadow tree.</p><x-inner></x-inner><slot name=desc></slot></div>";' +
      'a.shadowRoot.querySelector("x-inner").attachShadow({ mode: "open" }).innerHTML = "<p>Deeply nested shadow paragraph.</p>";' +
      'a.innerHTML = "<p slot=desc>Slotted light paragraph text.</p><p>Unassigned light child is not rendered.</p>";' +
      'const p = document.createElement("p"); p.innerHTML = "Updated <x-time>fallback</x-time> by Alice, please <x-link>click here</x-link> now."; document.body.appendChild(p);' +
      'p.querySelector("x-time").attachShadow({ mode: "open" }).textContent = "7 minutes ago";' +
      'p.querySelector("x-link").attachShadow({ mode: "open" }).innerHTML = "<a href=#><slot></slot></a>";' +
      'const units = NS.Extractor.collect(document.body, NS.settings.forContent(NS.settings.normalize({ targetLang: "zh-CN" })));' +
      'const texts = units.map(function(u){ return u.text; });' +
      'const slotted = units.find(function(u){ return u.text.indexOf("Slotted light") >= 0; });' +
      'let projected = false;' +
      'if (slotted) { const n = NS.Renderer.create(slotted.el, "译文", null, { mode: "sibling", target: slotted.el, typo: slotted.el });' +
      '  NS.Renderer.insert(n, slotted, { mode: "sibling", target: slotted.el }); projected = !!n.assignedSlot && n.getClientRects().length > 0; }' +
      'return { texts: texts, roots: units.shadowRoots.length,' +
      ' heading: texts.some(function(t){ return t.indexOf("Heading inside an open shadow") >= 0; }),' +
      ' nested: texts.some(function(t){ return t.indexOf("Deeply nested shadow") >= 0; }),' +
      ' inlineHost: texts.indexOf("Updated 7 minutes ago by Alice, please click here now.") >= 0,' +
      ' slotted: !!slotted, unassigned: texts.some(function(t){ return t.indexOf("Unassigned light child") >= 0; }), projected: projected }; })()');
    check('open 影子根内的标题 / 段落被抽取', shadow.heading, JSON.stringify(shadow.texts));
    check('嵌套影子根内的段落被抽取', shadow.nested);
    check('句中的行内组件：读影子文本与 slot 投影，整句不被拆开', shadow.inlineHost);
    check('影子 / slot 内容不重复抽取', shadow.texts.length === 5, shadow.texts.length + ' 个单元');
    check('具名 slot 投影的宿主子元素被抽取', shadow.slotted);
    check('未分配到 slot 的宿主子元素（不显示）被跳过', !shadow.unassigned);
    check('途经的影子根被上报（供内容脚本观察变化）', shadow.roots === 2, 'roots=' + shadow.roots + '（行内宿主的影子文本并入句子，不单独上报）');
    check('slot 内原文的译文继承 slot、能正常显示', shadow.projected);
    log('边界用例：' + edge.count + ' 单元，' + JSON.stringify(edge.texts));
  } catch (err) {
    check('抽取测试抛出异常', false, err && err.message);
    console.error('[extract] 失败：' + (err && err.stack ? err.stack : err));
    if (browser && browser.stderr.length) console.error('[extract] 浏览器日志尾部：\n' + browser.stderr.join('').slice(-1200));
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) {}
      killTree(browser.proc);
      if (!KEEP) { try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch (e) {} }
    }
    if (mock) killTree(mock);
    await sleep(250);
  }

  for (const c of checks) console.log((c.ok ? '  ok  ' : ' FAIL ') + c.name + (c.detail ? '  -> ' + c.detail : ''));
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.error('[extract] ' + failed + '/' + checks.length + ' 项断言失败'); exitCode = 1; }
  else log('全部通过：' + checks.length + ' 项断言');
  return exitCode;
}

main().then((code) => process.exit(code)).catch((err) => {
  if (err && err.code === 'NO_BROWSER') { console.error(err.message); process.exit(2); }
  console.error(err);
  process.exit(1);
});
