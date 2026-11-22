/*
 * AI 网页翻译 — 并发与缓存数据结构（runPool / Limiter / LRUCache）。
 * 依赖 shared/util.js（abortError / sleep）；供后台引擎、缓存与测试使用，内容脚本 / 弹窗无需加载。
 * 同时挂载到 WPT.concurrency 与 WPT.util 以保持向后兼容。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.concurrency) return;
  const U = NS.util || (NS.util = /** @type {any} */ ({}));

  /**
   * 固定宽度并发池。
   * @template T
   * @param {T[]} items
   * @param {number} limit
   * @param {(item: T, index: number) => Promise<void>} worker
   * @param {{ signal?: AbortSignal, onError?: (err: any, item: T, index: number) => void }} [opts]
   * @returns {Promise<void>}
   */
  async function runPool(items, limit, worker, opts) {
    const o = opts || {};
    const arr = items || [];
    if (!arr.length) return;
    const width = Math.max(1, Math.min(Math.round(limit) || 1, arr.length));
    let next = 0;
    let stop = false;
    let failure = null;

    async function runner() {
      while (!stop) {
        if (o.signal && o.signal.aborted) { stop = true; return; }
        const i = next++;
        if (i >= arr.length) return;
        try {
          await worker(arr[i], i);
        } catch (err) {
          if (o.onError) o.onError(err, arr[i], i);
          else { failure = err; stop = true; return; }
        }
      }
    }

    const runners = [];
    for (let i = 0; i < width; i++) runners.push(runner());
    await Promise.all(runners);
    if (failure) throw failure;
  }

  /**
   * 共享限流器：
   * 同一 API 端点 + 密钥的所有任务（多个标签页、同页多次增量）共用一个限流器：
   *   - 并发上限 = 用户设置的并发数，而不是「每个标签页各自一份」；
   *   - AIMD 自适应：遇到 429 并发减半并进入全局冷却（尊重 Retry-After），
   *     之后每连续成功 limit 次再 +1，逐步恢复到上限，避免 429 风暴；
   *   - FIFO 排队，保证先提交（视口优先）的批次先发出。
   */
  class Limiter {
    /** @param {number} max */
    constructor(max) {
      this.max = Math.max(1, Math.round(max) || 1);
      this.limit = this.max;
      this.active = 0;
      /** @type {Array<{ resolve: (value?: any) => void, reject: (err: any) => void, onAbort: (() => void) | null, signal?: AbortSignal }>} */
      this.queue = [];
      this.cooldownUntil = 0;
      this.okStreak = 0;
    }

    /** @param {number} n */
    setMax(n) {
      const m = Math.max(1, Math.round(n) || 1);
      if (m === this.max) return;
      // 调低立即生效；调高时若当前处于降速状态则保留降速，由成功次数逐步恢复
      this.limit = this.limit >= this.max ? m : Math.min(this.limit, m);
      this.max = m;
      this._drain();
    }

    /** @param {AbortSignal} [signal] */
    async acquire(signal) {
      if (signal && signal.aborted) throw U.abortError();
      if (this.active < this.limit && !this.queue.length) this.active++;
      else {
        await new Promise((resolve, reject) => {
          const w = { resolve: resolve, reject: reject, onAbort: null, signal: signal };
          if (signal) {
            w.onAbort = () => {
              const i = this.queue.indexOf(w);
              if (i >= 0) this.queue.splice(i, 1);
              reject(U.abortError());
            };
            signal.addEventListener('abort', w.onAbort, { once: true });
          }
          this.queue.push(w);
        });
      }
      // 已占到名额；若处于 429 冷却期则持有名额等待，防止冷却结束瞬间的突发
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) {
        try { await U.sleep(wait, signal); } catch (e) { this.release(); throw e; }
      }
    }

    release() {
      this.active = Math.max(0, this.active - 1);
      this._drain();
    }

    _drain() {
      while (this.active < this.limit && this.queue.length) {
        const w = this.queue.shift();
        this.active++;
        if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
        w.resolve();
      }
    }

    onSuccess() {
      if (this.limit >= this.max) { this.okStreak = 0; return; }
      if (++this.okStreak >= this.limit) {
        this.limit++;
        this.okStreak = 0;
        this._drain();
      }
    }

    /** @param {number | null} [retryAfterMs] */
    onRateLimit(retryAfterMs) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.okStreak = 0;
      const until = Date.now() + (retryAfterMs != null ? retryAfterMs : 1000);
      if (until > this.cooldownUntil) this.cooldownUntil = until;
    }
  }

  /**
   * 固定容量内存 LRU 缓存。
   * @template K, V
   */
  class LRUCache {
    /** @param {number} [max] */
    constructor(max) {
      this.max = Math.max(1, max || 100);
      /** @type {Map<K, V>} */
      this.map = new Map();
    }
    get size() { return this.map.size; }
    /** @param {K} k */
    has(k) { return this.map.has(k); }
    /**
     * @param {K} k
     * @returns {V | undefined}
     */
    get(k) {
      if (!this.map.has(k)) return undefined;
      const v = this.map.get(k);
      this.map.delete(k);
      this.map.set(k, v);
      return v;
    }
    /**
     * @param {K} k
     * @param {V} v
     */
    set(k, v) {
      if (this.map.has(k)) this.map.delete(k);
      this.map.set(k, v);
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    /** @param {K} k */
    delete(k) { return this.map.delete(k); }
    clear() { this.map.clear(); }
    keys() { return Array.from(this.map.keys()); }
  }

  const api = { runPool: runPool, Limiter: Limiter, LRUCache: LRUCache };
  NS.concurrency = api;
  Object.assign(U, api);
})();
