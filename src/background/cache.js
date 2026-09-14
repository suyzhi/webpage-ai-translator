/*
 * 翻译缓存：内存 LRU + chrome.storage.local 持久化。
 * 键 = hash(系统提示词 + 原文)，因此更换模型 / 目标语言 / 自定义提示词都会自然失效。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = {});
  if (NS.TranslationCache) return;
  const U = NS.util;

  const FLUSH_DELAY = 1200;
  const MAX_VALUE_CHARS = 8000;   // 超长段落不落盘，避免存储膨胀

  function Cache() {
    this.mem = new U.LRUCache(2000);
    this.sizes = new Map();        // key -> 字符数
    this.order = [];               // LRU 顺序（旧 -> 新）
    this.orderSet = new Set();
    this.chars = 0;
    this.maxEntries = NS.DEFAULT_SETTINGS.cacheMaxEntries;
    this.maxChars = 3.5 * 1024 * 1024;
    this.pending = new Map();      // 待落盘 key -> value
    this.timer = null;
    this.loaded = false;
    this.loading = null;
    this.writeChain = Promise.resolve();
  }

  Cache.prototype.key = function (systemPrompt, text) {
    return NS.CACHE_PREFIX + U.hashText(systemPrompt + '\u0000' + text);
  };

  Cache.prototype.load = function (maxEntries, maxChars) {
    const self = this;
    if (maxEntries) this.maxEntries = maxEntries;
    if (maxChars) this.maxChars = maxChars;
    if (this.loading) return this.loading;
    this.loading = (async function () {
      try {
        const got = await chrome.storage.local.get(NS.CACHE_META_KEY);
        const meta = got[NS.CACHE_META_KEY];
        if (meta && Array.isArray(meta.order)) {
          for (let i = 0; i < meta.order.length; i++) {
            const entry = meta.order[i];
            if (!entry || !entry[0]) continue;
            self.order.push(entry[0]);
            self.orderSet.add(entry[0]);
            self.sizes.set(entry[0], entry[1] || 0);
            self.chars += entry[1] || 0;
          }
        }
        self.loaded = true;
        await self.enforceLimits();
      } catch (e) {
        self.loaded = true;
      }
      return self;
    })();
    return this.loading;
  };

  Cache.prototype.getMany = async function (keys) {
    const result = new Map();
    const misses = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const hit = this.mem.get(k);
      if (hit !== undefined) { result.set(k, hit); continue; }
      if (this.orderSet.has(k)) misses.push(k);
    }
    if (misses.length) {
      try {
        const got = await chrome.storage.local.get(misses);
        for (let i = 0; i < misses.length; i++) {
          const k = misses[i];
          const v = got[k];
          if (typeof v === 'string') {
            this.mem.set(k, v);
            result.set(k, v);
            this.touch(k, v.length);
          } else {
            this.dropKey(k);
          }
        }
      } catch (e) {}
    }
    return result;
  };

  Cache.prototype.touch = function (k, size) {
    if (this.orderSet.has(k)) {
      const idx = this.order.indexOf(k);
      if (idx >= 0) this.order.splice(idx, 1);
      this.chars -= this.sizes.get(k) || 0;
    } else {
      this.orderSet.add(k);
    }
    this.order.push(k);
    this.sizes.set(k, size);
    this.chars += size;
  };

  Cache.prototype.dropKey = function (k) {
    this.mem.delete(k);
    if (this.orderSet.has(k)) {
      this.orderSet.delete(k);
      const idx = this.order.indexOf(k);
      if (idx >= 0) this.order.splice(idx, 1);
      this.chars -= this.sizes.get(k) || 0;
      this.sizes.delete(k);
    }
    this.pending.delete(k);
  };

  Cache.prototype.setMany = function (entries) {
    const removed = [];
    for (let i = 0; i < entries.length; i++) {
      const k = entries[i][0];
      const v = entries[i][1];
      this.mem.set(k, v);
      this.touch(k, v.length);
      if (v.length <= MAX_VALUE_CHARS) this.pending.set(k, v);
    }
    while (this.order.length > this.maxEntries || this.chars > this.maxChars) {
      const victim = this.order.shift();
      if (victim === undefined) break;
      this.orderSet.delete(victim);
      this.chars -= this.sizes.get(victim) || 0;
      this.sizes.delete(victim);
      this.mem.delete(victim);
      this.pending.delete(victim);
      removed.push(victim);
    }
    if (removed.length) {
      try { chrome.storage.local.remove(removed); } catch (e) {}
    }
  };

  Cache.prototype.scheduleFlush = function () {
    const self = this;
    if (this.timer) return;
    this.timer = setTimeout(function () { self.timer = null; self.flush(); }, FLUSH_DELAY);
  };

  Cache.prototype.flush = function () {
    const self = this;
    if (!this.pending.size) return this.writeChain;
    const payload = {};
    this.pending.forEach(function (v, k) { payload[k] = v; });
    this.pending.clear();
    payload[NS.CACHE_META_KEY] = { v: 1, order: this.order.map(function (k) { return [k, self.sizes.get(k) || 0]; }) };
    this.writeChain = this.writeChain.then(function () {
      return chrome.storage.local.set(payload).catch(function () {});
    });
    return this.writeChain;
  };

  Cache.prototype.enforceLimits = async function () {
    if (this.order.length <= this.maxEntries && this.chars <= this.maxChars) return;
    const removed = [];
    while (this.order.length > this.maxEntries || this.chars > this.maxChars) {
      const victim = this.order.shift();
      if (victim === undefined) break;
      this.orderSet.delete(victim);
      this.chars -= this.sizes.get(victim) || 0;
      this.sizes.delete(victim);
      removed.push(victim);
    }
    if (removed.length) {
      try { await chrome.storage.local.remove(removed); } catch (e) {}
      await this.flush();
    }
  };

  Cache.prototype.clear = async function () {
    this.mem.clear();
    this.sizes.clear();
    this.order = [];
    this.orderSet.clear();
    this.chars = 0;
    this.pending.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      // 扫描全部存储键，删除所有缓存条目（含历史遗留的孤儿数据）
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(function (k) {
        return k.indexOf(NS.CACHE_PREFIX) === 0 || k === NS.CACHE_META_KEY;
      });
      if (keys.length) await chrome.storage.local.remove(keys);
    } catch (e) {}
  };

  Cache.prototype.stats = function () {
    return { entries: this.order.length, chars: this.chars, memEntries: this.mem.size, maxEntries: this.maxEntries };
  };

  NS.TranslationCache = Cache;
})();
