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

  async function doFetch(url, init, settings, outerSignal) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onOuterAbort = function () { try { ctrl.abort(U.abortError()); } catch (e) {} };
    if (outerSignal) {
      if (outerSignal.aborted) throw U.abortError();
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, settings.timeoutMs);
    try {
      return await fetch(url, Object.assign({}, init, { signal: ctrl.signal, cache: 'no-store' }));
    } catch (e) {
      if (outerSignal && outerSignal.aborted) throw U.abortError();
      if (timedOut) {
        const err = new Error('请求超时（' + Math.round(settings.timeoutMs / 1000) + ' 秒）');
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

  async function readBody(res) {
    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
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

  /* ---------------- OpenAI 兼容 (/chat/completions) ---------------- */
  async function callOpenAI(settings, messages, signal) {
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
    // 注意：不发送 max_tokens —— 部分新模型（o1/gpt-5 等）只接受 max_completion_tokens，
    // 发送旧字段会直接 400。让服务端使用默认上限更兼容。

    const res = await doFetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, settings, signal);
    const parsed = await readBody(res);
    if (!res.ok) throw makeError(res.status, extractError(parsed.json, parsed.text), res.headers);
    const data = parsed.json;
    if (!data) throw makeError(502, '返回内容不是合法 JSON：' + U.truncate(parsed.text, 200), res.headers);
    const choice = data.choices && data.choices[0];
    const msg = choice && (choice.message || choice.delta || choice);
    let content = msg && msg.content;
    if (Array.isArray(content)) content = content.map(function (p) { return (p && p.text) || ''; }).join('');
    if (typeof content !== 'string' || !content) {
      if (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) content = msg.reasoning_content;
    }
    if (typeof content !== 'string') {
      const err = new Error('模型未返回文本内容（请检查模型名是否为对话模型）：' + U.truncate(JSON.stringify(data), 200));
      err.retryable = true;
      throw err;
    }
    return content;
  }

  /* ---------------- Anthropic (/messages) ---------------- */
  async function callAnthropic(settings, messages, signal) {
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
    const parsed = await readBody(res);
    if (!res.ok) throw makeError(res.status, extractError(parsed.json, parsed.text), res.headers);
    const data = parsed.json;
    if (!data || !Array.isArray(data.content)) {
      const err = new Error('Anthropic 返回格式异常：' + U.truncate(parsed.text, 200));
      err.retryable = true;
      throw err;
    }
    const text = data.content.filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('');
    return text;
  }

  async function call(settings, messages, signal) {
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
    if (settings.provider === 'anthropic') return callAnthropic(settings, messages, signal);
    return callOpenAI(settings, messages, signal);
  }

  /* 用于「测试连接」：发送最小请求 */
  async function probe(settings, signal) {
    const t = NS.prompt.buildTestMessages();
    const started = Date.now();
    const out = await call(settings, { system: t.system, user: t.user, maxTokens: 64 }, signal);
    return { text: out.trim(), ms: Date.now() - started };
  }

  function estimateMaxTokens(userText) {
    return Math.max(1024, Math.min(8192, Math.round(userText.length * 2.2) + 512));
  }

  NS.providers = { call: call, probe: probe, estimateMaxTokens: estimateMaxTokens, makeError: makeError };
})();
