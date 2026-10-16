/* 设置页逻辑：字段绑定 + 自动保存 + 连接测试 + 缓存管理 */
(function () {
  'use strict';
  const NS = globalThis.WPT;
  const $ = function (id) { return document.getElementById(id); };

  const NUM_FIELDS = ['concurrency', 'batchChars', 'batchItems', 'firstBatchChars', 'maxRetries',
    'timeoutMs', 'minTextLength', 'temperature', 'cacheMaxEntries'];
  const BOOL_FIELDS = ['skipTargetLang', 'translateTitle', 'autoTranslate', 'animations', 'useCache'];
  const TEXT_FIELDS = ['provider', 'baseUrl', 'apiKey', 'model', 'targetLang', 'sourceLang', 'customPrompt'];
  const SITE_KINDS = ['always', 'never'];
  const SITE_LABEL = { always: '总是翻译', never: '从不翻译' };

  let settings = null;
  let saveTimer = null;
  let toastTimer = null;

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function flashSaved() {
    const s = $('saveState');
    s.classList.add('show');
    setTimeout(function () { s.classList.remove('show'); }, 1100);
  }

  function fillLanguages() {
    const t = $('targetLang');
    const s = $('sourceLang');
    t.innerHTML = '';
    for (let i = 0; i < NS.LANGUAGES.length; i++) {
      const l = NS.LANGUAGES[i];
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.native + ' · ' + l.code;
      t.appendChild(o);
    }
    for (let i = 0; i < NS.LANGUAGES.length; i++) {
      const l = NS.LANGUAGES[i];
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name + ' · ' + l.native;
      s.appendChild(o);
    }
  }

  function fillPresets() {
    const box = $('presets');
    box.innerHTML = '';
    for (let i = 0; i < NS.PRESETS.length; i++) {
      const p = NS.PRESETS[i];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.id = p.id;
      b.textContent = p.label;
      b.setAttribute('aria-pressed', 'false');
      box.appendChild(b);
    }
    const dl = $('modelList');
    dl.innerHTML = '';
    const seen = new Set();
    for (let i = 0; i < NS.PRESETS.length; i++) {
      const p = NS.PRESETS[i];
      if (!p.model || seen.has(p.model)) continue;
      seen.add(p.model);
      const o = document.createElement('option');
      o.value = p.model;
      dl.appendChild(o);
    }
  }

  function markPreset() {
    const chips = $('presets').querySelectorAll('.chip');
    let matched = null;
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      const p = NS.PRESETS.filter(function (x) { return x.id === c.dataset.id; })[0];
      if (!p) continue;
      const ok = p.baseUrl === settings.baseUrl && p.model === settings.model && p.provider === settings.provider;
      c.setAttribute('aria-pressed', String(ok));
      if (ok) matched = p;
    }
    const link = $('keyLink');
    if (matched && matched.keyUrl) {
      link.href = matched.keyUrl;
      link.textContent = '获取密钥 ↗';
      link.style.display = '';
    } else {
      link.style.display = 'none';
    }
  }

  function applyToForm() {
    for (let i = 0; i < NUM_FIELDS.length; i++) $(NUM_FIELDS[i]).value = settings[NUM_FIELDS[i]];
    for (let i = 0; i < BOOL_FIELDS.length; i++) $(BOOL_FIELDS[i]).checked = !!settings[BOOL_FIELDS[i]];
    for (let i = 0; i < TEXT_FIELDS.length; i++) $(TEXT_FIELDS[i]).value = settings[TEXT_FIELDS[i]] || '';
    $('concurrencyVal').textContent = settings.concurrency;
    setSeg('displaySeg', settings.displayMode);
    setSeg('markSeg', settings.markStyle);
    markPreset();
    renderSiteRules();
    $('version').textContent = 'AI 网页翻译 v' + NS.VERSION;
  }

  /* ---------------- 网站规则 ---------------- */
  function renderSiteRules() {
    const rules = settings.siteRules || {};
    for (let k = 0; k < SITE_KINDS.length; k++) {
      const kind = SITE_KINDS[k];
      const hosts = Object.keys(rules).filter(function (h) { return rules[h] === kind; }).sort();
      const list = $(kind + 'List');
      list.innerHTML = '';
      if (!hosts.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '暂无';
        list.appendChild(li);
      }
      for (let i = 0; i < hosts.length; i++) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'mono';
        name.textContent = hosts[i];
        name.title = hosts[i];
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-ghost';
        del.dataset.host = hosts[i];
        del.textContent = '移除';
        li.appendChild(name);
        li.appendChild(del);
        list.appendChild(li);
      }
      $(kind + 'Count').textContent = hosts.length ? hosts.length + ' 个' : '';
    }
  }

  async function addSiteRule(kind) {
    const input = $(kind + 'Input');
    const raw = input.value.trim();
    if (!raw) return;
    const host = NS.util.normalizeHost(raw);
    if (!host) { toast('无法识别的域名：' + raw); return; }
    const prev = settings.siteRules[host];
    settings = await NS.settings.setSiteRule(host, kind);
    renderSiteRules();
    if (settings.siteRules[host] !== kind) { toast('网站规则已达上限（' + NS.SITE_RULES_MAX + ' 条）'); return; }
    input.value = '';
    toast(prev && prev !== kind ? host + ' 已改为' + SITE_LABEL[kind] : '已添加 ' + host);
  }

  function setSeg(id, value) {
    const btns = $(id).querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].dataset.value === value));
  }

  async function save(patch, quiet) {
    settings = await NS.settings.set(patch);
    applyToForm();
    if (!quiet) flashSaved();
  }

  function scheduleSave(patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(patch, true); }, 420);
  }

  function collect() {
    const patch = {};
    for (let i = 0; i < NUM_FIELDS.length; i++) patch[NUM_FIELDS[i]] = Number($(NUM_FIELDS[i]).value);
    for (let i = 0; i < BOOL_FIELDS.length; i++) patch[BOOL_FIELDS[i]] = $(BOOL_FIELDS[i]).checked;
    for (let i = 0; i < TEXT_FIELDS.length; i++) patch[TEXT_FIELDS[i]] = $(TEXT_FIELDS[i]).value;
    return patch;
  }

  /* ---------------- 事件 ---------------- */
  function bindEvents() {
    for (let i = 0; i < NUM_FIELDS.length; i++) {
      const el = $(NUM_FIELDS[i]);
      el.addEventListener('input', function () {
        if (el.id === 'concurrency') $('concurrencyVal').textContent = el.value;
        scheduleSave(collect());
      });
      el.addEventListener('change', function () {
        if (el.id === 'concurrency') $('concurrencyVal').textContent = el.value;
        save(collect(), true);
      });
    }
    for (let i = 0; i < BOOL_FIELDS.length; i++) {
      $(BOOL_FIELDS[i]).addEventListener('change', function () { save(collect(), true); });
    }
    for (let i = 0; i < TEXT_FIELDS.length; i++) {
      const el = $(TEXT_FIELDS[i]);
      el.addEventListener('input', function () { scheduleSave(collect()); });
      el.addEventListener('change', function () { save(collect(), true); });
    }

    $('presets').addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const p = NS.PRESETS.filter(function (x) { return x.id === chip.dataset.id; })[0];
      if (!p) return;
      if (p.id === 'custom') {
        save({ provider: 'openai' }).then(function () { $('baseUrl').focus(); });
        return;
      }
      save({ provider: p.provider, baseUrl: p.baseUrl, model: p.model })
        .then(function () { toast('已切换到 ' + p.label); });
    });

    $('displaySeg').addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b) return;
      setSeg('displaySeg', b.dataset.value);
      save({ displayMode: b.dataset.value }, true);
    });
    $('markSeg').addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b) return;
      setSeg('markSeg', b.dataset.value);
      save({ markStyle: b.dataset.value }, true);
    });

    for (let k = 0; k < SITE_KINDS.length; k++) {
      const kind = SITE_KINDS[k];
      $(kind + 'Add').addEventListener('click', function () { addSiteRule(kind); });
      $(kind + 'Input').addEventListener('keydown', function (e) { if (e.key === 'Enter') addSiteRule(kind); });
      $(kind + 'List').addEventListener('click', async function (e) {
        const b = e.target.closest('button[data-host]');
        if (!b) return;
        settings = await NS.settings.setSiteRule(b.dataset.host, null);
        renderSiteRules();
        toast('已移除 ' + b.dataset.host);
      });
    }
    // 弹出面板里修改的网站规则同步到列表
    NS.settings.onChange(function (s) {
      settings.siteRules = s.siteRules;
      renderSiteRules();
    });

    $('toggleKey').addEventListener('click', function () {
      const el = $('apiKey');
      const show = el.type === 'password';
      el.type = show ? 'text' : 'password';
      this.textContent = show ? '隐藏' : '显示';
    });

    $('testBtn').addEventListener('click', async function () {
      const box = $('testResult');
      const btn = this;
      box.className = 'test-result pending';
      box.textContent = '正在请求…';
      btn.disabled = true;
      const patch = collect();
      await save(patch, true);
      try {
        const resp = await chrome.runtime.sendMessage({ type: NS.MSG.TEST_CONNECTION, settings: patch });
        if (resp && resp.ok) {
          box.className = 'test-result ok';
          box.textContent = '连接成功（' + resp.ms + 'ms）· 模型 ' + (resp.model || '') + ' · 返回：' + resp.text;
        } else {
          box.className = 'test-result err';
          box.textContent = '连接失败：' + ((resp && resp.error) || '未知错误');
        }
      } catch (e) {
        box.className = 'test-result err';
        box.textContent = '连接失败：' + ((e && e.message) || e);
      } finally {
        btn.disabled = false;
      }
    });

    $('refreshStats').addEventListener('click', refreshStats);
    $('clearCache').addEventListener('click', async function () {
      const resp = await chrome.runtime.sendMessage({ type: NS.MSG.CACHE_CLEAR });
      toast(resp && resp.ok ? '缓存已清空' : '清空失败');
      refreshStats();
    });
    $('resetBtn').addEventListener('click', async function () {
      if (!confirm('确定恢复默认设置吗？API 密钥与网站规则也会被清除。')) return;
      settings = await NS.settings.reset();
      applyToForm();
      toast('已恢复默认设置');
    });
  }

  async function refreshStats() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: NS.MSG.CACHE_STATS });
      if (resp && resp.ok && resp.stats) {
        const s = resp.stats;
        $('cacheStats').textContent = '缓存条目 ' + s.entries + ' 条 · 约 ' + (s.chars / 1000).toFixed(0) + 'k 字符 · 上限 ' + s.maxEntries + ' 条';
      } else {
        $('cacheStats').textContent = '缓存不可用';
      }
    } catch (e) {
      $('cacheStats').textContent = '缓存不可用';
    }
  }

  (async function init() {
    fillLanguages();
    fillPresets();
    settings = await NS.settings.get();
    applyToForm();
    bindEvents();
    refreshStats();
  })().catch(function (e) {
    toast('初始化失败：' + ((e && e.message) || e));
  });
})();
