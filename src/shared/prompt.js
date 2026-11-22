/*
 * 提示词构造 与 模型返回解析。
 * 批量协议：每段一行「N|文本」，段内换行写作 <br>。
 *   比旧的 <t id="N">文本</t> 标签协议省 token：真实 DeepSeek 实测输入 -20%、输出 -26%，格式遵循率相同（240/240）；
 *   原文也不必再做 XML 转义。解析仍兼容标签格式（模型偶尔沿用旧格式时不至于整批失败）。
 * 解析失败时引擎会自动降级为逐条重译，保证结果最终完整。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.prompt) return;

  function targetName(settings) {
    return NS.langName(settings.targetLang, true);
  }

  function sourceName(settings) {
    if (!settings.sourceLang || settings.sourceLang === 'auto') return 'auto-detect';
    return NS.langName(settings.sourceLang, true);
  }

  /*
   * 系统提示词随每个批次重复发送，是固定开销：保持精简（约 200 token）。
   */
  function buildSystem(settings) {
    const target = targetName(settings);
    const lines = [
      'Translate web-page text segments into ' + target + '. Source language: ' + sourceName(settings) + '.',
      'Input: one segment per line, formatted as N|text. "<br>" marks a line break inside a segment.',
      'Rules:',
      '1. Output ONLY lines formatted as N|translation: exactly one line per input line, same N, same order. Never merge, split, reorder, add or drop lines. No other text, no code fences.',
      '2. Translate naturally and faithfully, as a native ' + target + ' writer. Keep tone and every <br>. Never summarize, explain or censor.',
      '3. Keep placeholders like ⟦0⟧ exactly as-is.',
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

  /* 段内换行 -> <br>，保证一段只占一行 */
  function encode(text) {
    return String(text).replace(/\r?\n/g, '<br>');
  }

  /* items: [{ id: number, text: string }]（text 已完成占位符保护，未编码） */
  function buildUser(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(items[i].id + '|' + encode(items[i].text));
    return out.join('\n');
  }

  function cleanValue(v) {
    return String(v == null ? '' : v)
      .replace(/\s*<br\s*\/?>\s*/gi, '\n')
      .replace(/^[ \t]+|[ \t]+$/gm, '').trim();
  }

  function stripFences(text) {
    return text.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```\s*$/, '');
  }

  /* 旧标签协议：标准闭合标签；忘记闭合时按开标签切分。值需 XML 反转义 */
  function parseTags(text, out) {
    const tagVal = function (v) {
      return cleanValue(NS.util.unescapeXml(String(v).replace(/<\s*\/?\s*t\b[^>]*>/gi, '')));
    };
    const re = /<\s*t\s+id\s*=\s*["']?\s*(\d+)\s*["']?\s*>([\s\S]*?)<\s*\/\s*t\s*>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = Number(m[1]);
      if (!out.has(id)) out.set(id, tagVal(m[2]));
    }
    if (out.size) return out;
    const re2 = /<\s*t\s+id\s*=\s*["']?\s*(\d+)\s*["']?\s*>/gi;
    const marks = [];
    while ((m = re2.exec(text)) !== null) marks.push({ id: Number(m[1]), start: re2.lastIndex });
    for (let i = 0; i < marks.length; i++) {
      let end = text.length;
      if (i + 1 < marks.length) {
        const cut = text.lastIndexOf('<', marks[i + 1].start - 1);
        if (cut > marks[i].start) end = cut;
      }
      out.set(marks[i].id, tagVal(text.slice(marks[i].start, end)));
    }
    return out;
  }

  /*
   * 解析模型返回 -> Map<number, string>
   * 行协议：以「N|」开头的行开始一段；不以它开头的非空行视为上一段的续行（模型偶尔把 <br> 写成真换行）。
   * 同一编号重复出现时以第一次为准。
   */
  const LINE_RE = /^\s*(\d+)\s*\|\s?(.*)$/;
  function parse(raw) {
    const out = new Map();
    if (raw == null) return out;
    const text = stripFences(String(raw).trim());
    if (!text) return out;
    if (/<\s*t\s+id\s*=/i.test(text)) return parseTags(text, out);

    const parts = new Map();
    let cur = null;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = LINE_RE.exec(lines[i]);
      if (m) {
        const id = Number(m[1]);
        if (parts.has(id)) { cur = null; continue; }
        cur = id;
        parts.set(id, [m[2]]);
      } else if (cur != null && lines[i].trim()) {
        parts.get(cur).push(lines[i]);
      }
    }
    parts.forEach(function (v, id) { out.set(id, cleanValue(v.join('\n'))); });
    return out;
  }

  /*
   * 本页术语表：每批请求互相独立，模型看不到别的批次怎么译，同一术语会一会儿译成「状态」、一会儿保留 state。
   * 翻译开始时先用一个很小的请求定下这些术语的译法，之后每批只附上本批出现的那几条。
   */
  function glossarySystem(settings) {
    const target = targetName(settings);
    return [
      'You fix the terminology for translating one web page into ' + target + '.',
      'Input: one candidate term per line, formatted as term — sample sentence from the page.',
      'Keep only real domain terms, names of concepts or features that must read the same everywhere; skip ordinary words whose translation depends on context.',
      'For each kept term output one line: term|rendering. rendering = how ' + target + ' technical writing normally renders it' +
        ' (keep it in English if that is the norm, e.g. API, class or product names). No other text.'
    ].join('\n');
  }

  function glossaryUser(terms) {
    return terms.map(function (t) { return t.term + ' — ' + String(t.sample || '').replace(/[\r\n]+/g, ' ').slice(0, 140); }).join('\n');
  }

  /* 只收候选里有的术语（防止模型自己加词）；返回 [{ term, to, re }] */
  function parseGlossary(raw, terms) {
    const wanted = new Map(terms.map(function (t) { return [t.term.toLowerCase(), t.term]; }));
    const out = [];
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      const m = /^\s*([^|]{1,60}?)\s*\|\s*(.{1,60}?)\s*$/.exec(line);
      if (!m) return;
      const term = wanted.get(m[1].toLowerCase());
      if (!term || !m[2] || m[2] === '-' || out.some(function (e) { return e.term === term; })) return;
      const pat = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
      out.push({ term: term, to: m[2], re: new RegExp('(^|[^\\p{L}\\p{N}])' + pat + '(?=$|[^\\p{L}\\p{N}])', 'iu') });
    });
    return out;
  }

  function glossarySection(entries) {
    return '\n\nPage glossary — render these terms exactly like this in every segment:\n' +
      entries.map(function (e) { return e.term + ' → ' + e.to; }).join('\n');
  }

  /* 供「测试连接」使用的极简请求 */
  function buildTestMessages() {
    return {
      system: 'You are a translation engine. Reply with the translation only, no explanation, no quotes.',
      user: '1|Hello, world.'
    };
  }

  NS.prompt = { buildSystem: buildSystem, buildUser: buildUser, encode: encode, parse: parse, targetName: targetName, sourceName: sourceName, buildTestMessages: buildTestMessages,
    glossarySystem: glossarySystem, glossaryUser: glossaryUser, parseGlossary: parseGlossary, glossarySection: glossarySection };
})();
