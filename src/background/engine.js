/*
 * 翻译引擎（后台核心）
 *
 * 关键设计：
 *  1. 去重          —— 页面内相同文本只请求一次，结果广播给所有副本（含后续增量加入的副本）；
 *  2. 缓存          —— hash(系统提示词 + 原文) 为键，命中直接秒回；
 *  3. 批量协议      —— 每段一行「N|文本」，一次请求翻译多个段落，显著降低往返开销（见 prompt.js）；
 *  4. 占位符保护    —— URL / 邮箱 / 模板变量先替换为 ⟦n⟧，避免被模型改写；
 *  5. 并发控制      —— 同一端点 + 密钥的所有任务共享一个限流器（跨标签页），
 *                      429 时 AIMD 降速 + 全局冷却，而不是各批次各自重试形成 429 风暴；
 *  6. 增量追加      —— 任务运行中可 add() 新段落（SPA / 无限滚动），不打断在途请求；
 *  7. 失败自愈      —— 返回格式错误 / 上下文超限时自动二分拆分，最终退化到逐条翻译；
 *                      限流 / 网络 / 服务端错误不拆分（拆分只会把请求数翻倍，雪上加霜）；
 *  8. 快速失败      —— 401/403/404 判定为致命错误，立即中止全部请求，避免无谓消耗。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.Engine) return;
  const U = NS.util;

  const MAX_SPLIT_DEPTH = 3;
  const RATE_LIMIT_EXTRA_RETRIES = 4;   // 429 额外重试次数（冷却由共享限流器统一处理）

  /* 限流器按「供应商 + 端点 + 密钥」共享；密钥只参与哈希，不以明文作为键保存 */
  const limiters = new Map();
  function limiterFor(settings) {
    const key = (settings.provider || '') + '|' + U.joinUrl(settings.baseUrl, '') + '|' + U.hashText(settings.apiKey || '');
    let l = limiters.get(key);
    if (!l) { l = new U.Limiter(settings.concurrency); limiters.set(key, l); }
    else l.setMax(settings.concurrency);
    return l;
  }

  function Engine(opts) {
    const o = opts || {};
    const self = this;
    this.settings = o.settings;
    this.cache = o.cache;
    this.onResults = o.onResults || function () {};
    this.onProgress = o.onProgress || function () {};
    this.onFatal = o.onFatal || function () {};
    this.onUsage = o.onUsage || function () {};
    this.log = o.log || function () {};
    this.limiter = o.limiter || limiterFor(this.settings);
    this.quickStart = o.quickStart !== false;   // 用户发起的首轮翻译：首批切小，首屏更快
    this.ctrl = new AbortController();
    this.signal = this.ctrl.signal;
    this.stopped = false;
    this.finished = false;
    this.fatalError = null;
    this.systemPrompt = NS.prompt.buildSystem(this.settings);
    this.stats = { total: 0, done: 0, cached: 0, failed: 0, requests: 0, batches: 0, startedAt: Date.now(),
      usage: { input: 0, output: 0, cached: 0 } };
    this.failedIds = [];
    this.entries = new Map();      // 规范化原文 -> { text, ids, cacheKey, state: pending|done|failed, result }
    this.work = [];                // 全部待请求项（用于停止时统计）
    this.queue = [];               // 待执行批次
    this.workers = 0;
    this.adding = 0;
    this.ref = 0;
    this.idle = new Promise(function (resolve) { self._resolveIdle = resolve; });
  }

  Engine.limiterFor = limiterFor;

  Engine.prototype.stop = function () {
    this.stopped = true;
    try { this.ctrl.abort(U.abortError()); } catch (e) {}
    this.checkIdle();
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
  Engine.prototype.run = function (items) {
    this.add(items);
    this.checkIdle();
    return this.idle;
  };

  Engine.prototype.whenIdle = function () { return this.idle; };

  /* 追加段落；引擎已结束时返回 false，由调用方新建引擎 */
  Engine.prototype.add = function (items) {
    if (this.finished || this.stopped) return false;
    const self = this;
    this.adding++;
    this.addAsync(items || []).catch(function (e) {
      self.log('追加失败：' + U.describeError(e));
    }).then(function () {
      self.adding--;
      self.pump();
      self.checkIdle();
    });
    return true;
  };

  Engine.prototype.addAsync = async function (list) {
    const settings = this.settings;
    this.stats.total += list.length;
    if (!list.length) return;

    // 1) 去重：相同原文只翻译一次；与在途 / 已完成条目合并
    const fresh = [];
    const immediate = [];
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id;
      const t = U.normalizeText(list[i].text);
      if (!t) { this.stats.done++; continue; }
      let e = this.entries.get(t);
      if (e) {
        if (e.state === 'done') { immediate.push([id, e.result]); this.stats.done++; }
        else if (e.state === 'failed') { this.stats.done++; this.stats.failed++; this.failedIds.push(id); }
        else e.ids.push(id);                 // 在途：结果落地时一并分发
        continue;
      }
      e = { text: t, ids: [id], cacheKey: this.cache.key(this.systemPrompt, t), state: 'pending', result: null };
      this.entries.set(t, e);
      fresh.push(e);
    }
    if (immediate.length) { this.onResults(immediate); this.onProgress(this.stats); }
    if (!fresh.length) return;

    // 2) 缓存命中：立即回填（此处 await 期间追加的同文副本会进入 e.ids，一并回填）
    const pending = [];
    if (settings.useCache) {
      const cached = await this.cache.getMany(fresh.map(function (e) { return e.cacheKey; }));
      const hits = [];
      for (let i = 0; i < fresh.length; i++) {
        const e = fresh[i];
        const v = cached.get(e.cacheKey);
        if (typeof v === 'string' && !this.stopped) {
          e.state = 'done';
          e.result = v;
          this.stats.cached++;
          this.stats.done += e.ids.length;
          for (let j = 0; j < e.ids.length; j++) hits.push([e.ids[j], v]);
        } else {
          pending.push(e);
        }
      }
      if (hits.length) { this.onResults(hits); this.onProgress(this.stats); }
    } else {
      for (let i = 0; i < fresh.length; i++) pending.push(fresh[i]);
    }
    if (!pending.length) return;

    // 3) 组装批量请求项（占位符保护）
    const work = [];
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      const prot = U.protectTokens(e.text);
      work.push({
        ref: ++this.ref,
        entry: e,
        sourceProtected: prot.text,
        tokens: prot.tokens,
        ids: e.ids,
        cost: U.visualLength(e.text)
      });
    }
    for (let i = 0; i < work.length; i++) this.work.push(work[i]);

    // 4) 打包（顺序即内容脚本给出的「视口优先」顺序）。
    //    「首批更小」只用于整个任务的第一批：增量追加（滚动、动态内容）若每次都切出小首批，
    //    每个小请求都要重复携带一遍系统提示词，纯属浪费 token。
    const batches = U.planBatches(work, {
      maxChars: settings.batchChars,
      maxItems: settings.batchItems,
      firstBatchChars: this.quickStart && !this.stats.batches ? settings.firstBatchChars : settings.batchChars
    });
    this.stats.batches += batches.length;
    for (let i = 0; i < batches.length; i++) this.queue.push(batches[i]);
    this.log('新增 ' + work.length + ' 段 / ' + batches.length + ' 批 / 并发 ' + settings.concurrency);
  };

  /* 工作协程：每个引擎最多 concurrency 个；真实 HTTP 并发由共享限流器约束 */
  Engine.prototype.pump = function () {
    const width = Math.max(1, Math.round(this.settings.concurrency) || 1);
    while (!this.stopped && this.workers < width && this.queue.length) {
      this.workers++;
      this.worker();
    }
  };

  Engine.prototype.worker = async function () {
    try {
      while (!this.stopped && this.queue.length) {
        const batch = this.queue.shift();
        try { await this.translateBatch(batch, 0); }
        catch (e) { if (!U.isAbort(e)) this.log('批次异常：' + U.describeError(e)); }
      }
    } finally {
      this.workers--;
      this.checkIdle();
    }
  };

  Engine.prototype.checkIdle = function () {
    if (this.finished || this.workers > 0 || this.adding > 0) return;
    if (this.queue.length && !this.stopped) return;
    this.finished = true;
    this.finalize();
  };

  Engine.prototype.finalize = async function () {
    // 致命错误 / 主动取消时，未完成的片段计入 failed，保证 done === total 的统计自洽
    if (this.stopped) {
      for (let i = 0; i < this.work.length; i++) {
        const it = this.work[i];
        if (!it.done) {
          it.done = true;
          it.entry.state = 'failed';
          this.stats.failed += it.ids.length;
          this.stats.done += it.ids.length;
        }
      }
    }
    // 任务结束立即落盘：Service Worker 随时可能被回收，不能依赖防抖
    try { await this.cache.flush(); } catch (e) {}
    this.stats.finishedAt = Date.now();
    this._resolveIdle(this.stats);
  };

  /* ---------------- 单批翻译（含重试与拆分） ---------------- */
  Engine.prototype.translateBatch = async function (batch, depth) {
    if (this.stopped) return;
    const maxRetries = this.settings.maxRetries;
    let pending = batch;
    let lastErr = null;
    let rateLimited = 0;

    for (let attempt = 0; attempt <= maxRetries && pending.length; attempt++) {
      if (this.stopped) return;
      pending = pending.filter(notDone);              // 流式中途失败时，已落地的段落不再重发
      if (!pending.length) return;
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
        lastErr.malformed = true;
        pending = missing;
      } catch (err) {
        if (U.isAbort(err) || this.stopped) return;
        if (err.fatal) { this.setFatal(err); return; }
        lastErr = err;
        if (!err.retryable) break;                       // 400/413 → 直接拆分重试
        // 超时：服务端很可能已经生成（并计费）了大半，原样重发整批等于再付一遍；直接拆小重试
        if (err.name === 'TimeoutError' && pending.length > 1 && depth < MAX_SPLIT_DEPTH) break;
        // 429 的等待由共享限流器的全局冷却承担；这里不消耗普通重试次数
        if (err.status === 429 && rateLimited < RATE_LIMIT_EXTRA_RETRIES) { rateLimited++; attempt--; continue; }
        if (attempt >= maxRetries) break;
        const wait = err.retryAfterMs != null ? err.retryAfterMs : U.backoff(attempt);
        this.log('重试 ' + (attempt + 1) + '/' + maxRetries + '（' + U.describeError(err) + '），等待 ' + wait + 'ms');
        try { await U.sleep(wait, this.signal); } catch (e) { return; }
      }
    }

    pending = pending.filter(notDone);
    if (this.stopped || !pending.length) return;

    // 二分拆分：只对「内容相关」的失败有意义（格式错误 / 缺片段 / 上下文超限 / 超时）；
    // 限流、网络、服务端 5xx 拆分只会成倍放大请求量。
    const splittable = !lastErr || lastErr.malformed || lastErr.split || lastErr.name === 'TimeoutError' ||
      (!lastErr.status && !lastErr.network);
    if (splittable && pending.length > 1 && depth < MAX_SPLIT_DEPTH) {
      const mid = Math.ceil(pending.length / 2);
      await this.translateBatch(pending.slice(0, mid), depth + 1);
      await this.translateBatch(pending.slice(mid), depth + 1);
      return;
    }

    for (let i = 0; i < pending.length; i++) this.pushFailed(pending[i], lastErr);
  };

  /* 每个请求内部从 1 重新编号：任务级流水号在长页面上会涨到 4~5 位，每段都白白多花 token */
  function notDone(it) { return !it.done; }

  Engine.prototype.callOnce = async function (batch) {
    const items = [];
    for (let i = 0; i < batch.length; i++) items.push({ id: i + 1, text: batch[i].sourceProtected });
    const user = NS.prompt.buildUser(items);
    await this.limiter.acquire(this.signal);
    let raw;
    const meta = {};
    const self = this;
    // 流式：出现新的一行「N|」说明它之前的段落已经写完，立即落地；最后一段等响应结束再定
    let cut = 0;
    const lineStart = /\n\s*\d+\s*\|/g;
    const onPartial = function (text) {
      if (self.stopped) return;
      lineStart.lastIndex = cut ? cut + 1 : 0;
      let last = -1;
      let m;
      while ((m = lineStart.exec(text)) !== null) last = m.index;
      if (last <= cut) return;
      cut = last;
      NS.prompt.parse(text.slice(0, last)).forEach(function (v, id) {
        const it = batch[id - 1];
        if (it && v) self.pushResult(it, v);
      });
    };
    try {
      this.stats.requests++;
      raw = await NS.providers.call(this.settings, {
        system: this.systemPrompt,
        user: user,
        maxTokens: NS.providers.estimateMaxTokens(user),
        onPartial: onPartial
      }, this.signal, meta);
      this.limiter.onSuccess();
    } catch (err) {
      if (err && err.status === 429) this.limiter.onRateLimit(err.retryAfterMs);
      throw err;
    } finally {
      this.limiter.release();
      if (meta.usage) this.addUsage(meta.usage);       // 即使随后判定失败，这些 token 也已计费
    }
    const parsed = NS.prompt.parse(raw);
    const out = new Map();
    for (let i = 0; i < batch.length; i++) {
      if (parsed.has(i + 1)) out.set(batch[i].ref, parsed.get(i + 1));
    }
    return out;
  };

  Engine.prototype.addUsage = function (u) {
    const t = this.stats.usage;
    t.input += u.input || 0;
    t.output += u.output || 0;
    t.cached += u.cached || 0;
    try { this.onUsage(u); } catch (e) {}
  };

  /* ---------------- 结果落地 ---------------- */
  Engine.prototype.pushResult = function (item, raw) {
    if (item.done) return;
    let text = U.restoreTokens(raw, item.tokens);
    text = U.ensureTokensPreserved(item.sourceProtected, text, item.tokens).trim();
    if (!text) { this.pushFailed(item, new Error('译文为空')); return; }
    item.done = true;
    item.entry.state = 'done';
    item.entry.result = text;
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
    if (item.done) return;
    item.done = true;
    item.entry.state = 'failed';
    this.stats.failed += item.ids.length;
    this.stats.done += item.ids.length;
    for (let i = 0; i < item.ids.length; i++) this.failedIds.push(item.ids[i]);
    this.lastError = err || this.lastError;
    this.log('翻译失败：' + U.describeError(err) + '｜原文：' + U.truncate(item.entry.text, 60));
    this.onProgress(this.stats);
  };

  NS.Engine = Engine;
})();
