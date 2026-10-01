/*
 * 提示词构造 与 模型返回解析。
 * 批量协议：<t id="N">文本</t> —— 比 JSON 更省 token，且模型几乎不会写坏；
 * 解析失败时引擎会自动降级为逐条重译，保证结果最终完整。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.prompt) return;

  function targetName(settings) {
    return NS.langName(settings.targetLang, true);
  }

  function sourceName(settings) {
    if (!settings.sourceLang || settings.sourceLang === 'auto') return 'auto-detect';
    return NS.langName(settings.sourceLang, true);
  }

  /*
   * \u7cfb\u7edf\u63d0\u793a\u8bcd\u968f\u6bcf\u4e2a\u6279\u6b21\u91cd\u590d\u53d1\u9001\uff0c\u662f\u56fa\u5b9a\u5f00\u9500\uff1a\u4fdd\u6301\u7cbe\u7b80\uff08\u7ea6 200 token\uff09\uff0c
   * \u89c4\u5219\u8986\u76d6\u9762\u4e0e\u65e7\u7248\u4e00\u81f4\uff0c\u53ea\u53bb\u6389\u4e86\u5197\u4f59\u63aa\u8f9e\u3002
   */
  function buildSystem(settings) {
    const target = targetName(settings);
    const lines = [
      'Translate web-page text segments into ' + target + '. Source language: ' + sourceName(settings) + '.',
      'Input: segments wrapped as <t id="N">...</t>.',
      'Rules:',
      '1. Output ONLY the segments, each as <t id="N">translation</t> with the same id. Exactly one output tag per input tag: never merge, split, reorder, add or drop. No other text, no code fences.',
      '2. Translate naturally and faithfully, as a native ' + target + ' writer. Keep tone and every line break. Never summarize, explain or censor.',
      '3. Keep placeholders like \u27e60\u27e7 exactly as-is.',
      '4. Keep numbers, units, dates, prices, versions, code, file names, e-mails and brand/product names unchanged unless a well-established translation exists.',
      '5. If a segment is already ' + target + ' or is only a name, number, symbol or code, copy it unchanged.',
      '6. Do not add quotation marks or punctuation the source does not imply.'
    ];
    const extra = (settings.customPrompt || '').trim();
    if (extra) {
      lines.push('');
      lines.push('ADDITIONAL USER INSTRUCTIONS (highest priority, but must never break the output format rules above):');
      lines.push(extra);
    }
    return lines.join('\n');
  }

  /* items: [{ id: number, text: string }]（text 已 XML 转义、已完成占位符保护） */
  function buildUser(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      out.push('<t id="' + items[i].id + '">' + items[i].text + '</t>');
    }
    return out.join('\n');
  }

  function cleanValue(v) {
    let s = String(v == null ? '' : v);
    s = s.replace(/<\s*\/?\s*t\b[^>]*>/gi, '');
    s = s.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```\s*$/, '');
    return s.replace(/^[ \t]+|[ \t]+$/gm, '').trim();
  }

  /*
   * 解析模型返回 -> Map<number, string>
   * 两级容错：标准闭合标签；模型忘记闭合时按开标签切分。
   */
  function parse(raw) {
    const out = new Map();
    if (raw == null) return out;
    let text = String(raw).trim();
    if (!text) return out;
    text = text.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```\s*$/, '');

    const re = /<\s*t\s+id\s*=\s*["']?\s*(\d+)\s*["']?\s*>([\s\S]*?)<\s*\/\s*t\s*>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = Number(m[1]);
      if (!out.has(id)) out.set(id, cleanValue(m[2]));
    }
    if (out.size) return out;

    const re2 = /<\s*t\s+id\s*=\s*["']?\s*(\d+)\s*["']?\s*>/gi;
    const marks = [];
    while ((m = re2.exec(text)) !== null) marks.push({ id: Number(m[1]), start: re2.lastIndex });
    if (!marks.length) return out;
    for (let i = 0; i < marks.length; i++) {
      let end = text.length;
      if (i + 1 < marks.length) {
        const cut = text.lastIndexOf('<', marks[i + 1].start - 1);
        if (cut > marks[i].start) end = cut;
      }
      out.set(marks[i].id, cleanValue(text.slice(marks[i].start, end)));
    }
    return out;
  }

  /* 供「测试连接」使用的极简请求 */
  function buildTestMessages() {
    return {
      system: 'You are a translation engine. Reply with the translation only, no explanation, no quotes.',
      user: '<t id="1">Hello, world.</t>'
    };
  }

  NS.prompt = { buildSystem: buildSystem, buildUser: buildUser, parse: parse, targetName: targetName, sourceName: sourceName, buildTestMessages: buildTestMessages };
})();
