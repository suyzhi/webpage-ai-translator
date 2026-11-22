/*
 * AI 网页翻译 — 页面内提示浮层（Shadow DOM，与页面样式互不干扰）。
 * 兼容 Trusted Types CSP 与 XHTML 严格 XML 解析（不触碰 innerHTML）。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.Toast) return;

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  /**
   * @param {string} tag
   * @param {string} [cls]
   * @returns {HTMLElement}
   */
  function mkEl(tag, cls) {
    const el = /** @type {HTMLElement} */ (typeof document.createElementNS === 'function'
      ? document.createElementNS(XHTML_NS, tag)
      : document.createElement(tag));
    if (cls) el.className = cls;
    return el;
  }

  const STYLE =
    ':host{all:initial}' +
    '.box{--fg:#111827;--sub:#6b7280;--bg:rgba(255,255,255,.9);--line:rgba(15,23,42,.08);--track:rgba(15,23,42,.08);' +
    '--accent:#6366f1;--ok:#10b981;--err:#ef4444;--btn:rgba(15,23,42,.05);--btn-h:rgba(15,23,42,.1);' +
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
    'color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:14px;' +
    'box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 32px -8px rgba(0,0,0,.22);' +
    '-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);' +
    'min-width:220px;max-width:340px;overflow:hidden;pointer-events:auto;' +
    'opacity:0;transform:translateY(10px) scale(.98);transform-origin:100% 100%;' +
    'transition:opacity .22s ease,transform .32s cubic-bezier(.2,.8,.2,1)}' +
    '@media (prefers-color-scheme:dark){.box{--fg:#f3f4f6;--sub:#9ca3af;--bg:rgba(24,24,27,.88);--line:rgba(255,255,255,.1);' +
    '--track:rgba(255,255,255,.12);--accent:#818cf8;--ok:#34d399;--err:#f87171;--btn:rgba(255,255,255,.08);--btn-h:rgba(255,255,255,.16)}}' +
    '.box.show{opacity:1;transform:none}' +
    '.main{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px}' +
    '.ic{width:16px;height:16px;flex:0 0 auto;position:relative}' +
    '.ic.busy{border-radius:50%;border:2px solid var(--track);border-top-color:var(--accent);box-sizing:border-box;animation:spin .8s linear infinite}' +
    '.ic.ok::before,.ic.err::before{content:"";position:absolute;inset:0;border-radius:50%;background:var(--ok)}' +
    '.ic.err::before{background:var(--err)}' +
    '.ic.ok::after{content:"";position:absolute;left:5px;top:3px;width:4px;height:7px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}' +
    '.ic.err::after{content:"!";position:absolute;inset:0;color:#fff;font:700 11px/16px sans-serif;text-align:center}' +
    '.txt{flex:1;min-width:0}' +
    '.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}' +
    '.sub{color:var(--sub);font-size:11.5px;margin-top:1px}.sub:empty{display:none}' +
    '.acts{display:flex;gap:4px;flex:0 0 auto}' +
    'button{all:unset;cursor:pointer;font:600 12px/1 inherit;font-family:inherit;color:var(--fg);background:var(--btn);' +
    'padding:6px 9px;border-radius:8px;transition:background .15s}' +
    'button:hover{background:var(--btn-h)}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
    'button.x{color:var(--sub);background:transparent;padding:6px 7px}' +
    '.bar{height:2px;background:var(--track)}.bar[hidden]{display:none}' +
    '.bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .35s cubic-bezier(.2,.8,.2,1)}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){.box,.bar i{transition:none}.ic.busy{animation-duration:2.4s}}';

  /**
   * 创建页面内提示控制器。子框架传入 disabled=true 返回空实现。
   * @param {boolean} [disabled]
   * @returns {WptToastApi}
   */
  function create(disabled) {
    if (disabled) return { show: function () {}, hide: function () {} };

    /** @type {HTMLElement | null} */
    let host = null;
    /** @type {ShadowRoot | null} */
    let root = null;
    /** @type {HTMLElement | null} */
    let box = null;
    /** @type {any} */
    let hideTimer = null;
    /** @type {any} */
    let removeTimer = null;
    /** @type {Record<string, any>} */
    let els = {};

    function ensure() {
      clearTimeout(removeTimer);
      if (host && host.isConnected) return;
      host = mkEl('wpt-ui');
      host.setAttribute('data-wpt', '1');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:16px;bottom:16px;pointer-events:none;';
      root = host.attachShadow({ mode: 'open' });
      if (typeof root.appendChild === 'function') {
        const st = mkEl('style');
        st.textContent = STYLE;
        box = mkEl('div', 'box');
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        const main = mkEl('div', 'main');
        const ic = mkEl('span', 'ic');
        const txt = mkEl('div', 'txt');
        const t = mkEl('div', 't');
        const sub = mkEl('div', 'sub');
        txt.appendChild(t);
        txt.appendChild(sub);
        const acts = mkEl('div', 'acts');
        const x = mkEl('button', 'x');
        x.setAttribute('title', '关闭');
        x.setAttribute('aria-label', '关闭');
        x.textContent = '✕';
        main.appendChild(ic);
        main.appendChild(txt);
        main.appendChild(acts);
        main.appendChild(x);
        const bar = mkEl('div', 'bar');
        bar.appendChild(mkEl('i'));
        box.appendChild(main);
        box.appendChild(bar);
        root.appendChild(st);
        root.appendChild(box);
        els = { ic: ic, t: t, sub: sub, acts: acts, bar: bar, x: x };
      } else {
        box = /** @type {HTMLElement} */ (root.querySelector('.box'));
        els = {
          ic: root.querySelector('.ic'), t: root.querySelector('.t'), sub: root.querySelector('.sub'),
          acts: root.querySelector('.acts'), bar: root.querySelector('.bar'), x: root.querySelector('.x')
        };
      }
      els.x.addEventListener('click', hide);
      document.documentElement.appendChild(host);
      void box.offsetWidth;   // 保证首次出现也有过渡
    }

    /**
     * @param {string} msg
     * @param {WptToastOptions} [opts]
     */
    function show(msg, opts) {
      const o = opts || {};
      ensure();
      clearTimeout(hideTimer);
      els.t.textContent = msg;
      els.sub.textContent = o.sub || '';
      els.ic.className = 'ic' + (o.kind ? ' ' + o.kind : '');
      if (o.progress != null) {
        els.bar.hidden = false;
        els.bar.firstChild.style.width = Math.round(Math.max(0.02, o.progress) * 100) + '%';
      } else {
        els.bar.hidden = true;
      }
      const acts = o.actions || [];
      const sig = acts.map(function (a) { return a.label; }).join('|');
      if (els.acts.getAttribute('data-sig') !== sig) {
        els.acts.textContent = '';
        els.acts.setAttribute('data-sig', sig);
        acts.forEach(function (a) {
          const b = mkEl('button');
          b.textContent = a.label;
          b.addEventListener('click', function () { a.run(); });
          els.acts.appendChild(b);
        });
      }
      box.classList.add('show');
      if (o.duration !== 0) {
        // 成功提示尽量不打扰（还原随时可用快捷键 / 弹出面板），错误提示留足阅读时间
        hideTimer = setTimeout(hide, o.duration || (o.kind === 'err' ? 8000 : 1600));
      }
    }

    function hide() {
      if (!box) return;
      clearTimeout(hideTimer);
      box.classList.remove('show');
      removeTimer = setTimeout(function () {
        if (host && host.parentNode && !box.classList.contains('show')) {
          host.parentNode.removeChild(host);
          host = null;
          root = null;
          box = null;
        }
      }, 360);
    }

    return { show: show, hide: hide };
  }

  NS.Toast = { create: create };
})();
