/* 弹出面板逻辑 */
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

  function render() {
    const st = live && live.status ? live.status : 'idle';
    const pill = $('statusPill');
    pill.textContent = STATUS_TEXT[st] || st;
    pill.className = 'pill' + (st === 'translating' || st === 'scanning' ? ' busy' : st === 'done' ? ' done' : st === 'error' ? ' err' : '');

    const total = (live && live.total) || 0;
    const done = (live && live.done) || 0;
    const pct = total ? Math.min(1, done / total) : (st === 'done' ? 1 : 0);
    $('progressBar').firstChild.style.width = (pct * 100) + '%';

    if (st === 'translating' || st === 'scanning') {
      $('statusDetail').textContent = total ? done + ' / ' + total + (live.cached ? '（缓存 ' + live.cached + '）' : '') : '';
    } else if (st === 'done') {
      $('statusDetail').textContent = total + ' 段' + (live.failed ? '，' + live.failed + ' 段失败' : '');
    } else {
      $('statusDetail').textContent = '';
    }

    const busy = st === 'translating' || st === 'scanning';
    $('mainBtn').textContent = busy ? '停止' : (st === 'done' || (live && live.translated) ? '还原原文' : '翻译此页面');
    $('mainBtn').className = 'btn btn-block ' + (busy || (st === 'done' || (live && live.translated)) ? 'btn-danger' : 'btn-primary');
    $('stopBtn').classList.add('hidden');

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
  }

  async function ensureInjected() {
    const resp = await chrome.runtime.sendMessage({ type: NS.MSG.INJECT, tabId: tab.id });
    return resp || { ok: false, error: '注入失败' };
  }

  async function onMain() {
    if (!tab || tab.id == null) return;
    const st = live && live.status;
    if (st === 'translating' || st === 'scanning') {
      await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.STOP }).catch(function () {});
      refresh();
      return;
    }
    if (st === 'done' || (live && live.translated)) {
      await chrome.tabs.sendMessage(tab.id, { type: NS.MSG.RESTORE }).catch(function () {});
      refresh();
      return;
    }
    if (!settings.apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl || '')) {
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
    $('modelLabel').textContent = settings.model || '';
    $('noKey').classList.toggle('hidden', !!settings.apiKey);
  }

  async function init() {
    fillLanguages();
    settings = await NS.settings.get();
    $('targetLang').value = settings.targetLang;
    $('concurrency').value = settings.concurrency;
    $('concurrencyVal').textContent = settings.concurrency;
    setDisplay(settings.displayMode);
    $('modelLabel').textContent = settings.model || '';
    $('noKey').classList.toggle('hidden', !!settings.apiKey || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl || ''));

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
    live = await statusOf(tab && tab.id);
    render();
    pollTimer = setInterval(refresh, 600);
  }

  /* 事件绑定 */
  $('mainBtn').addEventListener('click', onMain);
  $('openOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('goOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  $('targetLang').addEventListener('change', function () {
    save({ targetLang: $('targetLang').value }).then(function () {
      if (live && (live.translated || live.status === 'done')) {
        // 目标语言变化 -> 还原后重新翻译
        chrome.tabs.sendMessage(tab.id, { type: NS.MSG.RESTORE }).catch(function () {}).then(function () {
          setTimeout(function () { chrome.tabs.sendMessage(tab.id, { type: NS.MSG.START, overrides: overrides() }).catch(function () {}); }, 120);
        });
      }
    });
  });
  $('concurrency').addEventListener('input', function () {
    $('concurrencyVal').textContent = this.value;
  });
  $('concurrency').addEventListener('change', function () {
    save({ concurrency: Number(this.value) });
  });
  $('displaySeg').addEventListener('click', function (e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    setDisplay(btn.dataset.value);
    save({ displayMode: btn.dataset.value }).then(function () {
      if (live && (live.translated || live.status === 'done')) {
        chrome.tabs.sendMessage(tab.id, { type: NS.MSG.RESTORE }).catch(function () {}).then(function () {
          setTimeout(function () { chrome.tabs.sendMessage(tab.id, { type: NS.MSG.START, overrides: overrides() }).catch(function () {}); }, 120);
        });
      }
    });
  });

  window.addEventListener('unload', function () { if (pollTimer) clearInterval(pollTimer); });

  init().catch(function (e) {
    $('errorBox').classList.remove('hidden');
    $('errorText').textContent = String((e && e.message) || e);
  });
})();
