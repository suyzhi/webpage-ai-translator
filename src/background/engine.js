/*
 * 翻译引擎（后台核心）
 *
 * 关键设计：
 *  1. 去重          —— 页面内相同文本只请求一次，结果广播给所有副本；
 *  2. 缓存          —— hash(系统提示词 + 原文) 为键，命中直接秒回；
 *  3. 批量协议      —— <t id="n">…</t>，一次请求翻译多个段落，显著降低往返开销；
 *  4. 占位符保护    —— URL / 邮箱 / 模板变量先替换为 ⟦n⟧，避免被模型改写；
 *  5. 并发池        —— 并发数可调，指数退避重试，429 尊重 Retry-After；
 *  6. 失败自愈      —— 返回格式错误 / 上下文超限时自动二分拆分，最终退化到逐条翻译，
 *                      保证「要么成功、要么单条失败」，绝不整页失败；
 *  7. 快速失败      —— 401/403/404 判定为致命错误，立即中止全部请求，避免无谓消耗。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Engine) return;
  const U = NS.util;

  const MAX_SPLIT_DEPTH = 3;

  function Engine(opts) {
    const o = opts || {};
    this.settings = o.settings;
    this.cache = o.cache;
    this.onResults = o.onResults || function () {};
    this.onProgress = o.onProgress || function () {};
    this.onFatal = o.onFatal || function () {};
    this.log = o.log || function () {};
    this.ctrl = new AbortController();
    this.signal = this.ctrl.signal;
    this.stopped = false;
    this.fatalError = null;
    this.systemPrompt = NS.prompt.buildSystem(this.settings);
    this.stats = { total: 0, done: 0, cached: 0, failed: 0, requests: 0, batches: 0, startedAt: Date.now() };
  }

  Engine.prototype.stop = function () {
    this.stopped = true;
    try { this.ctrl.abort(U.abortError()); } catch (e) {}
  };

  Engine.prototype.setFatal = function (err) {
    if (!this.fatalError) {
      this.fatalError = err;
      this.log('fatal: ' + (err && err.message));
      try { this.onFatal(err); } catch (e) {}
    }
    this.stopped = true;
    try { this.ctrl.abort(U.abortError()); } catch (e) {}
  };

  /* ---------------- 主流程 ---------------- */
  Engine.prototype.run = async function (items) {
    const self = this;
    const settings = this.settings;
    const list = items || [];
    this.stats.total = list.length;
    if (!list.length) return this.stats;

    // 1) 去重：相同原文只翻译一次
    const uniq = new Map();
    for (let i = 0; i < list.length; i++) {
      const raw = list[i].text;
      const t = U.normalizeText(raw);
      if (!t) { this.stats.done++; continue; }
      let e = uniq.get(t);
      if (!e) { e = { text: t, ids: [], cacheKey: '' }; uniq.set(t, e); }
      e.ids.push(list[i].id);
    }
    const entries = [];
    uniq.forEach(function (v) { entries.push(v); });
    for (let i = 0; i < entries.length; i++) entries[i].cacheKey = this.cache.key(this.systemPrompt, entries[i].text);

    // 2) 缓存命中：立即回填，用户几乎无感
    const pending = [];
    const hitResults = [];
    if (settings.useCache) {
      const keys = entries.map(function (e) { return e.cacheKey; });
      const cached = await this.cache.getMany(keys);
      for (let i = 0; i < entries.length; i++) {
        const v = cached.get(entries[i].cacheKey);
        if (typeof v === 'string') {
          this.stats.cached++;
          for (let j = 0; j < entries[i].ids.length; j++) hitResults.push([entries[i].ids[j], v]);
        } else {
          pending.push(entries[i]);
        }
      }
    } else {
      for (let i = 0; i < entries.length; i++) pending.push(entries[i]);
    }
    if (hitResults.length) {
      this.stats.done += hitResults.length;
      this.onResults(hitResults);
      this.onProgress(this.stats);
    }
    if (!pending.length || this.stopped) return this.stats;

    // 3) 组装批量请求项（占位符保护 -> XML 转义）
    let ref = 0;
    const work = [];
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      const prot = U.protectTokens(e.text);
      ref++;
      work.push({
        ref: ref,
        entry: e,
        escaped: U.escapeXml(prot.text),
        sourceProtected: prot.text,
        tokens: prot.tokens,
        ids: e.ids,
        cost: U.visualLength(e.text)
      });
    }

    // 4) 打包 + 并发执行（顺序即内容脚本给出的「视口优先」顺序）
    const batches = U.planBatches(work, {
      maxChars: settings.batchChars,
      maxItems: settings.batchItems,
      firstBatchChars: settings.firstBatchChars
    });
    this.stats.batches = batches.length;
    this.log('去重后 ' + work.length + ' 段 / ' + batches.length + ' 批 / 并发 ' + settings.concurrency);

    await U.runPool(batches, settings.concurrency, function (batch) {
      return self.translateBatch(batch, 0);
    }, { signal: this.signal, onError: function () {} });

    // 致命错误 / 主动取消时，未完成的片段计入 failed，保证 done === total 的统计自洽
    if (this.stopped) {
      for (let i = 0; i < work.length; i++) {
        const it = work[i];
        if (!it.done) {
          it.done = true;
          this.stats.failed += it.ids.length;
          this.stats.done += it.ids.length;
        }
      }
    }

    // 任务结束立即落盘：Service Worker 随时可能被回收，不能依赖防抖
    await this.cache.flush();
    this.stats.finishedAt = Date.now();
    return this.stats;
  };

  /* ---------------- 单批翻译（含重试与拆分） ---------------- */
  Engine.prototype.translateBatch = async function (batch, depth) {
    if (this.stopped) return;
    const maxRetries = this.settings.maxRetries;
    let pending = batch;
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries && pending.length; attempt++) {
      if (this.stopped) return;
      try {
        const parsed = await this.callOnce(pending);
        const missing = [];
        for (let i = 0; i < pending.length; i++) {
          const it = pending[i];
          const got = parsed.get(it.ref);
          if (typeof got === 'string' && got.length) this.pushResult(it, got);
          else missing.push(it);
        }
        if (!missing.length) return;
        lastErr = new Error('模型返回缺少 ' + missing.length + ' 个片段');
        lastErr.retryable = true;
        pending = missing;
      } catch (err) {
        if (U.isAbort(err) || this.stopped) return;
        if (err.fatal) { this.setFatal(err); return; }
        lastErr = err;
        if (!err.retryable) break;                       // 400/413 → 直接拆分重试
        if (attempt >= maxRetries) break;
        const wait = err.retryAfterMs != null ? err.retryAfterMs : U.backoff(attempt);
        this.log('重试 ' + (attempt + 1) + '/' + maxRetries + '（' + U.describeError(err) + '），等待 ' + wait + 'ms');
        try { await U.sleep(wait, this.signal); } catch (e) { return; }
      }
    }

    if (this.stopped || !pending.length) return;

    // 二分拆分：把失败影响面缩到最小
    if (pending.length > 1 && depth < MAX_SPLIT_DEPTH) {
      const mid = Math.ceil(pending.length / 2);
      await this.translateBatch(pending.slice(0, mid), depth + 1);
      await this.translateBatch(pending.slice(mid), depth + 1);
      return;
    }

    for (let i = 0; i < pending.length; i++) this.pushFailed(pending[i], lastErr);
  };

  Engine.prototype.callOnce = async function (batch) {
    const parts = [];
    for (let i = 0; i < batch.length; i++) parts.push('<t id="' + batch[i].ref + '">' + batch[i].escaped + '</t>');
    const user = parts.join('\n');
    this.stats.requests++;
    const raw = await NS.providers.call(this.settings, {
      system: this.systemPrompt,
      user: user,
      maxTokens: NS.providers.estimateMaxTokens(user)
    }, this.signal);
    return NS.prompt.parse(raw);
  };

  /* ---------------- 结果落地 ---------------- */
  Engine.prototype.pushResult = function (item, raw) {
    item.done = true;
    let text = U.unescapeXml(raw);
    text = U.restoreTokens(text, item.tokens);
    text = U.ensureTokensPreserved(item.sourceProtected, text, item.tokens).trim();
    if (!text) { this.pushFailed(item, new Error('译文为空')); return; }
    const out = [];
    for (let i = 0; i < item.ids.length; i++) out.push([item.ids[i], text]);
    if (this.settings.useCache) {
      this.cache.setMany([[item.entry.cacheKey, text]]);
      this.cache.scheduleFlush();
    }
    this.stats.done += out.length;
    this.onResults(out);
    this.onProgress(this.stats);
  };

  Engine.prototype.pushFailed = function (item, err) {
    item.done = true;
    this.stats.failed += item.ids.length;
    this.stats.done += item.ids.length;
    this.lastError = err || this.lastError;
    this.log('翻译失败：' + U.describeError(err) + '｜原文：' + U.truncate(item.entry.text, 60));
    this.onProgress(this.stats);
  };

  NS.Engine = Engine;
})();
