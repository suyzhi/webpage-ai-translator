/*
 * AI 供应商适配层：OpenAI 兼容协议 + Anthropic Messages 协议。
 * 统一负责：超时、中断、HTTP 错误分类（可重试 / 致命 / 可拆分）。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.providers) return;
  const U = NS.util;

  function makeError(status, detail, headers) {
    const err = new Error('HTTP ' + status + (detail ? ': ' + U.truncate(detail, 400) : ''));
    err.status = status;
    err.detail = detail || '';
    err.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    err.fatal = status === 401 || status === 403 || status === 404 || status === 422;
    err.split = status === 400 || status === 413;   // 常见于上下文过长 -> 拆分后重试
    const ra = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (ra) {
      const sec = Number(ra);
      if (isFinite(sec)) err.retryAfterMs = Math.min(60000, sec * 1000);
      else {
        const d = Date.parse(ra);
        if (!isNaN(d)) err.retryAfterMs = Math.max(0, Math.min(60000, d - Date.now()));
      }
    }
    return err;
  }

  /*
   * 超时覆盖「连接 + 响应头 + 读取响应体」全过程：
   * 高并发下网关常常先回响应头再卡住响应体，只对 fetch() 计时会让该请求永久占用一个并发名额。
   */
  async function doFetch(url, init, settings, outerSignal, onChunk) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onOuterAbort = function () { try { ctrl.abort(U.abortError()); } catch (e) {} };
    if (outerSignal) {
      if (outerSignal.aborted) throw U.abortError();
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, settings.timeoutMs);
    // 与中止信号赛跑：即便底层 fetch / 响应体读取不响应 signal，超时与取消也一定生效
    const aborted = new Promise(function (resolve, reject) {
      if (ctrl.signal.aborted) return reject(U.abortError());
      ctrl.signal.addEventListener('abort', function () { reject(U.abortError()); }, { once: true });
    });
    aborted.catch(function () {});
    let stage = 'connect';
    try {
      const res = await Promise.race([fetch(url, Object.assign({}, init, { signal: ctrl.signal, cache: 'no-store' })), aborted]);
      stage = 'body';
      const text = await Promise.race([onChunk && res.ok && res.body ? readStream(res.body, onChunk) : res.text(), aborted]);
      return { ok: res.ok, status: res.status, headers: res.headers, text: text };
    } catch (e) {
      if (outerSignal && outerSignal.aborted) throw U.abortError();
      if (timedOut) {
        const err = new Error('请求超时（' + Math.round(settings.timeoutMs / 1000) + ' 秒' + (stage === 'body' ? '，读取响应体' : '') + '）');
        err.name = 'TimeoutError';
        err.retryable = true;
        err.url = url;
        throw err;
      }
      if (U.isAbort(e)) throw e;
      const err = new Error('网络错误：' + ((e && e.message) || String(e)));
      err.name = 'TypeError';
      err.retryable = true;
      err.network = true;
      err.url = url;
      throw err;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  /* 逐块读取响应体：每块解码后交给 onChunk，同时拼出完整文本（错误分类、非流式回退都要用） */
  async function readStream(body, onChunk) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let all = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const piece = decoder.decode(r.value, { stream: true });
      all += piece;
      try { onChunk(piece); } catch (e) { /* 回调异常不影响读取 */ }
    }
    return all + decoder.decode();
  }

  function readBody(res) {
    const text = res.text || '';
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { text: text, json: json };
  }

  function extractError(json, text) {
    if (json && json.error) {
      if (typeof json.error === 'string') return json.error;
      if (json.error.message) return json.error.message;
    }
    if (json && json.message) return String(json.message);
    return U.truncate(text || '', 400);
  }

  /*
   * 省 token 的请求参数（OpenAI 兼容协议）：
   *  - max_tokens：模型偶发「复读」时，没有上限会一直生成到服务端默认上限（常见 4K~8K）全额计费。
   *    OpenAI 推理模型（o1/o3/o4/gpt-5）只接受 max_completion_tokens 且其中含思考 token，
   *    设上限反而会截断正文，所以对它们不设。
   *  - 关闭思考：Qwen3 / GLM-4.5+ 等混合推理模型在部分平台上默认开启思考，
   *    翻译不需要推理，思考 token 往往是正文的数倍。参数名各家不同，只对已知平台发送，
   *    避免严格校验参数的服务端返回 400。
   */
  const OPENAI_REASONING_RE = /^(?:openai\/)?(?:o\d|gpt-5)/i;

  function applyTokenControls(body, settings, messages) {
    const model = String(settings.model || '');
    if (messages.maxTokens && !OPENAI_REASONING_RE.test(model)) body.max_tokens = messages.maxTokens;
    let host = '';
    try { host = new URL(settings.baseUrl).hostname; } catch (e) {}
    if (/(^|\.)(dashscope\.aliyuncs\.com|siliconflow\.cn|siliconflow\.com)$/i.test(host) && /qwen3/i.test(model)) {
      body.enable_thinking = false;
    } else if (/(^|\.)bigmodel\.cn$/i.test(host) && /^glm-(?:4\.[5-9]|[5-9])/i.test(model)) {
      body.thinking = { type: 'disabled' };
    } else if (/(^|\.)deepseek\.com$/i.test(host) && !NS.isReasoningModel(model)) {
      // DeepSeek V4 系列（含 deepseek-chat 别名）默认开启思考：实测 8 段批次思考占输出 55%，关闭后输出 token 减半、更快
      body.thinking = { type: 'disabled' };
    }
  }

  /*
   * 统一用量口径：input = 全部输入 token（含命中缓存部分），cached = 命中提示词缓存的部分，output = 输出（含思考）。
   * DeepSeek: prompt_cache_hit_tokens；OpenAI: prompt_tokens_details.cached_tokens；
   * Anthropic: input_tokens 不含缓存读写，需相加。
   */
  function openaiUsage(u) {
    if (!u) return null;
    const details = u.prompt_tokens_details || {};
    return {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cached: u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (details.cached_tokens || 0)
    };
  }

  function anthropicUsage(u) {
    if (!u) return null;
    const read = u.cache_read_input_tokens || 0;
    return { input: (u.input_tokens || 0) + read + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: read };
  }

  /*
   * 流式输出：译文逐段落地，读者不必等整批（真实 6 站：段等待 P50 4.4 s → 见 docs/metrics.md）。
   * 只对确认支持 stream + stream_options 的平台开启，避免严格校验参数的服务端返回 400；
   * settings.streaming 可强制开关（测试用）。
   */
  function canStream(settings) {
    if (settings.streaming != null) return !!settings.streaming;
    let host = '';
    try { host = new URL(settings.baseUrl).hostname; } catch (e) { return false; }
    return /(^|\.)(deepseek\.com|openai\.com|openrouter\.ai)$/i.test(host);
  }

  /* SSE：累计 delta.content / reasoning_content，结束后拼成与非流式相同的响应结构 */
  function sseReader(onPartial) {
    let buf = '';
    let content = '';
    let reasoning = '';
    let usage = null;
    let error = null;
    let events = 0;
    function line(raw) {
      const s = raw.trim();
      if (s.indexOf('data:') !== 0) return;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch (e) { return; }
      events++;
      if (j.error) error = j.error;
      if (j.usage) usage = j.usage;
      const c = j.choices && j.choices[0];
      const d = c && (c.delta || c.message);
      if (!d) return;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        try { onPartial(content); } catch (e) { /* 忽略 */ }
      }
    }
    return {
      push: function (piece) {
        buf += piece;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      },
      finish: function () {
        if (buf) { line(buf); buf = ''; }
        if (!events) return null;
        if (error && !content) return { error: error };
        return { choices: [{ message: { content: content, reasoning_content: reasoning } }], usage: usage };
      }
    };
  }

  /* ---------------- OpenAI 兼容 (/chat/completions) ---------------- */
  async function callOpenAI(settings, messages, signal, meta) {
    const url = U.joinUrl(settings.baseUrl, '/chat/completions');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = 'Bearer ' + settings.apiKey;

    const body = {
      model: settings.model,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user }
      ],
      temperature: settings.temperature,
      stream: false
    };
    applyTokenControls(body, settings, messages);
    const sse = typeof messages.onPartial === 'function' && canStream(settings) ? sseReader(messages.onPartial) : null;
    if (sse) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    const res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, settings, signal, sse ? sse.push : null);
    const parsed = readBody(res);
    if (!res.ok) throw makeError(res.status, extractError(parsed.json, parsed.text), res.headers);
    // 服务端忽略 stream 参数时仍是普通 JSON，照常解析
    const data = parsed.json || (sse ? sse.finish() : null);
    if (!data) throw makeError(502, '返回内容不是合法 JSON：' + U.truncate(parsed.text, 200), res.headers);
    if (data.error && !data.choices) throw makeError(502, extractError(data, ''), res.headers);
    if (meta) meta.usage = openaiUsage(data.usage);
    const choice = data.choices && data.choices[0];
    const msg = choice && (choice.message || choice.delta || choice);
    let content = msg && msg.content;
    if (Array.isArray(content)) content = content.map(function (p) { return (p && p.text) || ''; }).join('');
    // 只有思考过程、没有正文：推理模型（或思考耗尽了输出上限）。把思考当译文只会解析失败、反复重试烧 token，
    // 直接按致命错误停下并提示换模型。
    if ((typeof content !== 'string' || !content) && msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
      const err = new Error('模型只返回了思考过程、没有译文：请改用非推理模型（如 deepseek-flash），推理模型翻译费用高数倍');
      err.fatal = true;
      throw err;
    }
    if (typeof content !== 'string') {
      const err = new Error('模型未返回文本内容（请检查模型名是否为对话模型）：' + U.truncate(JSON.stringify(data), 200));
      err.retryable = true;
      throw err;
    }
    return content;
  }

  /* ---------------- Anthropic (/messages) ---------------- */
  async function callAnthropic(settings, messages, signal, meta) {
    const url = U.joinUrl(settings.baseUrl, '/messages');
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': settings.apiKey || ''
    };
    const body = {
      model: settings.model,
      max_tokens: messages.maxTokens || 4096,
      temperature: settings.temperature,
      system: messages.system,
      messages: [{ role: 'user', content: messages.user }]
    };
    const res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, settings, signal);
    const parsed = readBody(res);
    if (!res.ok) throw makeError(res.status, extractError(parsed.json, parsed.text), res.headers);
    const data = parsed.json;
    if (!data || !Array.isArray(data.content)) {
      const err = new Error('Anthropic 返回格式异常：' + U.truncate(parsed.text, 200));
      err.retryable = true;
      throw err;
    }
    if (meta) meta.usage = anthropicUsage(data.usage);
    const text = data.content.filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('');
    return text;
  }

  /* meta（可选）：调用成功后写入 meta.usage = { input, output, cached } */
  async function call(settings, messages, signal, meta) {
    if (!settings.baseUrl) {
      const err = new Error('尚未配置接口地址 (Base URL)');
      err.fatal = true;
      throw err;
    }
    if (!settings.model) {
      const err = new Error('尚未配置模型名称');
      err.fatal = true;
      throw err;
    }
    if (settings.provider === 'anthropic') return callAnthropic(settings, messages, signal, meta);
    return callOpenAI(settings, messages, signal, meta);
  }

  /* 用于「测试连接」：发送最小请求 */
  async function probe(settings, signal) {
    const t = NS.prompt.buildTestMessages();
    const started = Date.now();
    const meta = {};
    const out = await call(settings, { system: t.system, user: t.user, maxTokens: 64 }, signal, meta);
    return { text: NS.prompt.parse(out).get(1) || out.trim(), ms: Date.now() - started, usage: meta.usage || null };
  }

  function estimateMaxTokens(userText) {
    return Math.max(1024, Math.min(8192, Math.round(userText.length * 2.2) + 512));
  }

  NS.providers = { call: call, probe: probe, estimateMaxTokens: estimateMaxTokens, makeError: makeError };
})();
