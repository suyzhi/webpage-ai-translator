/* 弹出面板逻辑：状态展示 + 翻译/停止/还原 + 快速设置 */
(function () {
  'use strict';
  const NS = globalThis.WPT;
  const $ = function (id) { return document.getElementById(id); };

  let tab = null;
  let settings = null;
  let live = null;         // 内容脚本上报的实时状态
  let pollTimer = null;
  let dirty = false;       // 是否有未保存的设置改动

  const STATUS_TEXT = {
    idle: '未翻译',
    scanning: '分析页面…',
    translating: '翻译中',
    done: '已翻译',
    error: '出错'
  };
  const BUSY = { scanning: 1, translating: 1 };

  function isLocal(url) { return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(String(url || '')); }

  function fillLanguages() {
    const sel = $('targetLang');
    sel.innerHTML = '';
    for (let i = 0; i < NS.LANGUAGES.length; i++) {
      const l = NS.LANGUAGES[i];
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.native + ' · ' + l.code;
      sel.appendChild(opt);
    }
  }

  function updateConc(value) {
    const v = Math.max(1, Math.min(32, Number(value) || 1));
    $('concurrency').value = v;
    $('concurrency').style.setProperty('--fill', ((v - 1) / 31 * 100) + '%');
    $('concurrencyVal').textContent = v;
    const chips = $('concPresets').querySelectorAll('.chip');
    for (let i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed', String(Number(chips[i].dataset.value) === v));
    }
  }

  function render() {
    const st = live && live.status ? live.status : 'idle';
    const busy = !!BUSY[st];
    const pill = $('statusPill');
    pill.textContent = STATUS_TEXT[st] || st;
    pill.className = 'pill' + (busy ? ' busy' : st === 'done' ? ' done' : st === 'error' ? ' err' : '');

    const total = (live && live.total) || 0;
    const done = (live && live.done) || 0;
    const pct = total ? Math.min(1, done / total) : (st === 'done' ? 1 : 0);
    $('progressBar').firstChild.style.width = (busy ? pct * 100 : 0) + '%';
    const showPct = busy && total;
    $('statusPercent').textContent = showPct ? Math.round(pct * 100) + '%' : '';
    const ring = $('ring');
    ring.className = 'ring' + (busy ? ' busy' : st === 'done' ? ' done' : st === 'error' ? ' err' : '') + (showPct ? ' has-label' : '');
    const arc = busy ? Math.max(6, pct * 100) : st === 'done' ? 100 : 0;
    $('ringVal').style.strokeDasharray = arc + ' 100';

    if (busy) {
      $('statusDetail').textContent = total ? '已完成 ' + done + ' / ' + total + ' 段' + (live.cached ? ' · 缓存 ' + live.cached : '') : '正在分析页面…';
    } else if (st === 'done') {
      $('statusDetail').textContent = (live.translated || 0) + ' 段译文' + (live.failed ? ' · ' + live.failed + ' 段失败' : '') + (live.cached ? ' · 缓存 ' + live.cached : '');
    } else if (st === 'idle' && live && live.translated) {
      $('statusDetail').textContent = '已暂停 · 保留 ' + live.translated + ' 段译文';
    } else {
      $('statusDetail').textContent = '';
    }

    const hasOutput = st === 'done' || (live && live.translated > 0);
    const canRetry = !busy && live && live.failed > 0;
    let label = '翻译此页面';
    let danger = false;
    if (busy) { label = '停止'; danger = true; }
    else if (canRetry) { label = '重试失败段落（' + live.failed + '）'; }
    else if (st === 'error') { label = hasOutput ? '继续翻译' : '重新翻译'; }
    else if (st === 'idle' && hasOutput) { label = '继续翻译'; }
    else if (hasOutput) { label = '重新翻译'; }
    $('mainBtn').textContent = label;
    $('mainBtn').className = 'btn grow ' + (danger ? 'btn-danger' : 'btn-primary');
    $('restoreBtn').classList.toggle('hidden', !hasOutput || busy);

    const err = live && live.error;
    if (err) { $('errorBox').classList.remove('hidden'); $('errorText').textContent = err; }
    else $('errorBox').classList.add('hidden');
  }

  function statusOf(tabId) {
    return new Promise(function (resolve) {
      if (tabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(tabId, { type: NS.MSG.PING }, function (resp) {
          if (chrome.runtime.lastError || !resp) return resolve(null);
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  async function refresh() {
    live = await statusOf(tab && tab.id);
    render();
    renderUsage();
  }

  async function ensureInjected() {
    const resp = await chrome.runtime.sendMessage({ type: NS.MSG.INJECT, tabId: tab.id });
    return resp || { ok: false, error: '注入失败' };
  }

  async function retranslate() {
    await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.RESTORE }).catch(function () {});
    await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.START, overrides: overrides() }).catch(function () {});
    $('mainBtn').textContent = '分析中…';
    setTimeout(refresh, 300);
  }

  async function onMain() {
    if (!tab || tab.id == null) return;
    const st = live && live.status;
    if (BUSY[st]) {
      await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.STOP }).catch(function () {});
      refresh();
      return;
    }
    const hasOutput = st === 'done' || (live && live.translated > 0);
    // 失败段落重试 / 停止或出错后继续：不还原，只补翻剩余部分
    const resume = (live && live.failed > 0) || ((st === 'idle' || st === 'error') && hasOutput);
    if (resume) {
      await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.START, overrides: overrides() }).catch(function () {});
      setTimeout(refresh, 300);
      return;
    }
    if (hasOutput) return retranslate();
    if (settings && !settings.apiKey && !isLocal(settings.baseUrl)) {
      $('noKey').classList.remove('hidden');
      return;
    }
    const res = await ensureInjected();
    if (!res.ok) {
      live = { status: 'error', error: res.error || '无法注入脚本' };
      render();
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.START, overrides: overrides() }).catch(function () {});
    $('mainBtn').textContent = '分析中…';
    setTimeout(refresh, 300);
  }

  function onRestore() {
    if (!tab || tab.id == null) return;
    chrome.tabs.sendMessage(tab.id, { type: NS.MSG.RESTORE }).catch(function () {}).then(function () { refresh(); });
  }

  function overrides() {
    return {
      targetLang: $('targetLang').value,
      displayMode: currentDisplay(),
      concurrency: Number($('concurrency').value)
    };
  }

  function currentDisplay() {
    const pressed = $('displaySeg').querySelector('[aria-pressed="true"]');
    return pressed ? pressed.dataset.value : 'bilingual';
  }

  function setDisplay(value) {
    const btns = $('displaySeg').querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].dataset.value === value));
    }
  }

  async function save(patch) {
    settings = await NS.settings.set(patch);
    dirty = true;
    $('modelLabel').textContent = modelText(settings);
    $('noKey').classList.toggle('hidden', !!settings.apiKey || isLocal(settings.baseUrl));
  }

  function modelText(s) {
    const p = NS.PRESETS.filter(function (x) { return x.baseUrl && x.baseUrl === s.baseUrl; })[0];
    return (s.model || '未配置模型') + (p ? ' · ' + p.label : '');
  }

  async function init() {
    fillLanguages();
    settings = await NS.settings.get();
    $('targetLang').value = settings.targetLang;
    updateConc(settings.concurrency);
    setDisplay(settings.displayMode);
    $('modelLabel').textContent = modelText(settings);
    $('noKey').classList.toggle('hidden', !!settings.apiKey || isLocal(settings.baseUrl));

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
    renderSiteAuto();
    loadTotalUsage();
    live = await statusOf(tab && tab.id);
    render();
    pollTimer = setInterval(refresh, 600);
  }

  /* 显示实际生效的快捷键（用户可能改过，或因冲突未分配）；点击跳到浏览器的快捷键设置页 */
  // 旧版本的默认绑定（macOS 显示为符号）；用户自己改成别的键时不提示
  const STALE_SHORTCUTS = ['⌥⇧T', 'Alt+Shift+T', ''];
  function openShortcutSettings(e) {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  function showShortcut() {
    const el = $('shortcut');
    if (!el || !chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll(function (cmds) {
      const c = (cmds || []).filter(function (x) { return x.name === 'toggle-translate'; })[0];
      const key = c && c.shortcut;
      // 从旧版本升级时浏览器会保留旧绑定（如 ⌥⇧T），扩展无法自行修改，只能提示用户手动设置
      const stale = STALE_SHORTCUTS.indexOf(key || '') >= 0;
      $('shortcutWarn').classList.toggle('hidden', !stale);
      el.classList.toggle('hidden', stale);             // 旧绑定不再展示，由提示取代
      el.textContent = '';
      if (!key) { el.textContent = '设置快捷键'; return; }
      // macOS 返回「⌥A」这样的符号串，其他平台返回「Alt+A」
      const parts = key.indexOf('+') >= 0 ? key.split('+') : Array.from(key);
      parts.forEach(function (p, i) {
        if (i) el.appendChild(document.createTextNode(' '));
        const k = document.createElement('kbd');
        k.textContent = p;
        el.appendChild(k);
      });
    });
    el.addEventListener('click', openShortcutSettings);
    $('shortcutWarn').addEventListener('click', openShortcutSettings);
  }

  /* ---------------- token 用量 ---------------- */
  let totalUsage = null;

  function fmtTokens(n) {
    n = n || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
  }

  function renderUsage() {
    const page = live && live.usage;
    const parts = [];
    if (page && (page.input || page.output)) {
      const hit = page.input ? Math.round(page.cached / page.input * 100) : 0;
      parts.push('本页 ' + fmtTokens(page.input + page.output) + ' token' + (hit ? '（缓存命中 ' + hit + '%）' : ''));
    }
    if (totalUsage && (totalUsage.input || totalUsage.output)) parts.push('累计 ' + fmtTokens(totalUsage.input + totalUsage.output));
    $('usageLine').textContent = parts.join(' · ');
  }

  function loadTotalUsage() {
    chrome.storage.local.get(NS.USAGE_KEY).then(function (got) {
      totalUsage = got[NS.USAGE_KEY] || null;
      renderUsage();
    }).catch(function () {});
  }

  /* ---------------- 自动翻译此网站 ---------------- */
  function tabHost() {
    try {
      const u = new URL(tab && tab.url);
      return /^https?:$/.test(u.protocol) ? NS.settings.normalizeHost(u.hostname) : '';
    } catch (e) { return ''; }
  }

  function renderSiteAuto() {
    const host = tabHost();
    $('siteAutoRow').classList.toggle('hidden', !host);
    if (!host || !settings) return;
    $('siteAuto').checked = NS.settings.autoAllowed(settings, host);
    $('siteAutoRow').title = '打开 ' + host + ' 时自动翻译' + (settings.autoTranslate && !settings.autoSites.length ? '（当前对所有网站自动翻译）' : '');
  }

  /* 事件绑定 */
  showShortcut();
  $('siteAuto').addEventListener('change', function () {
    const host = tabHost();
    if (!host || !settings) return;
    save(NS.settings.siteAutoPatch(settings, host, this.checked)).then(renderSiteAuto);
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[NS.USAGE_KEY]) { totalUsage = changes[NS.USAGE_KEY].newValue || null; renderUsage(); }
  });
  $('mainBtn').addEventListener('click', onMain);
  $('restoreBtn').addEventListener('click', onRestore);
  $('openOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('goOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('footOptions').addEventListener('click', function (e) { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('targetLang').addEventListener('change', function () {
    save({ targetLang: $('targetLang').value }).then(function () {
      if (live && (live.translated || live.status === 'done')) retranslate();
    });
  });
  $('concurrency').addEventListener('input', function () { updateConc(this.value); });
  $('concurrency').addEventListener('change', function () { updateConc(this.value); save({ concurrency: Number(this.value) }); });
  $('concPresets').addEventListener('click', function (e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    updateConc(btn.dataset.value);
    save({ concurrency: Number(btn.dataset.value) });
  });
  $('displaySeg').addEventListener('click', function (e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    setDisplay(btn.dataset.value);
    save({ displayMode: btn.dataset.value }).then(function () {
      if (live && (live.translated || live.status === 'done')) retranslate();
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { window.close(); return; }
    const tag = document.activeElement && document.activeElement.tagName;
    if (e.key === 'Enter' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
      e.preventDefault();
      onMain();
    }
  });

  window.addEventListener('unload', function () { if (pollTimer) clearInterval(pollTimer); });

  init().catch(function (e) {
    $('errorBox').classList.remove('hidden');
    $('errorText').textContent = String((e && e.message) || e);
  });
})();
