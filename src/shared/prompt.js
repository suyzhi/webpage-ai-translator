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

  function buildSystem(settings) {
    const target = targetName(settings);
    const lines = [
      'You are a professional web-page translator. The user sends text segments extracted from a web page, each wrapped in a tag of the form <t id="N">...</t>.',
      '',
      'TASK: Translate every segment into ' + target + '.',
      '',
      'OUTPUT RULES (follow exactly):',
      '1. Reply with the translated segments ONLY. No preamble, no explanation, no notes, no markdown code fences, no extra text before or after.',
      '2. Reproduce every segment with the same tag name and the same id: <t id="N">translated text</t>.',
      '3. Never renumber, merge, split, reorder, add or drop segments. The output must contain exactly one tag per input tag.',
      '4. Translate naturally and idiomatically, as a native ' + target + ' writer would. Preserve the original meaning, tone, register, formatting and level of detail. Never summarize, explain or censor.',
      '5. Keep placeholders such as \u27e60\u27e7, \u27e61\u27e7 exactly as they are. They stand for URLs, e-mail addresses, code or template variables: never translate, delete, reorder, split or reformat them.',
      '6. Keep numbers, units, dates, times, prices, version numbers, code identifiers, file names and e-mail addresses unchanged.',
      '7. Keep proper nouns, brand names and product names in their original form unless a well-established translation exists.',
      '8. Preserve every line break inside a segment exactly as in the source.',
      '9. If a segment is already in ' + target + ', or contains only a name, number, symbol or code, copy it through unchanged.',
      '10. Do not wrap the translation in quotation marks and do not add punctuation that the source does not imply. Keep the same sentence-final punctuation style as the source.',
      '',
      'Source language: ' + sourceName(settings) + '. Target language: ' + target + '.'
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
