/*
 * AI 网页翻译 — 站点规则匹配与自动翻译脚本注册范围计算。
 * siteRules: { 'example.com': 'always' | 'never' }。
 * 子域名继承父域名的规则，最具体的规则优先：a.b.example.com 先找 a.b.example.com，再找 b.example.com、example.com。
 * 优先级：手动翻译 > 从不翻译 > 总是翻译 / 全局自动翻译开关。
 * 同时挂载到 WPT.siteRules 与 WPT.util 以保持向后兼容。
 */
(function () {
  'use strict';
  const NS = globalThis.WPT || (globalThis.WPT = /** @type {any} */ ({}));
  if (NS.siteRules) return;
  const U = NS.util || (NS.util = /** @type {any} */ ({}));

  const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
  const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  const ALL_PAGES = ['http://*/*', 'https://*/*'];
  /**
   * @param {object} o
   * @param {string} k
   */
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /**
   * 用户输入 -> 纯主机名（小写、IDN 转 punycode）。协议/路径/端口/开头的 *. 会被去掉，其余无法识别的返回 ''。
   * @param {string | null | undefined} input
   * @returns {string}
   */
  function normalizeHost(input) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    const scheme = /^(?:([a-z][a-z0-9+.-]*|\*):)?\/\//.exec(s);
    if (scheme) {
      if (scheme[1] && !/^(?:https?|\*)$/.test(scheme[1])) return '';   // 规则只作用于 http/https 网页
      s = s.slice(scheme[0].length);                   // 协议
    }
    s = s.split(/[/?#\\]/)[0];                          // 路径 / 查询 / 片段
    s = s.slice(s.lastIndexOf('@') + 1);                // 用户信息
    if (s.charAt(0) === '[') return '';                 // IPv6 字面量不支持
    s = s.replace(/:\d*$/, '');                         // 端口
    s = s.replace(/^\*\./, '').replace(/\.+$/, '');     // *.example.com 等价于 example.com（子域名本就继承）
    if (!s || s.indexOf('*') >= 0) return '';
    try { s = new URL('http://' + s + '/').hostname; } catch (e) { return ''; }
    if (s.length > 253) return '';
    const labels = s.split('.');
    for (let i = 0; i < labels.length; i++) if (!HOST_LABEL_RE.test(labels[i])) return '';
    return s;
  }

  /**
   * 清洗规则表：主机名规范化、丢弃无效项、去重（后者覆盖前者）、限制条数。
   * @param {unknown} raw
   * @returns {WptSiteRules}
   */
  function normalizeSiteRules(raw) {
    /** @type {WptSiteRules} */
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const max = NS.SITE_RULES_MAX || 500;
    let n = 0;
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
      const v = /** @type {Record<string, unknown>} */ (raw)[keys[i]];
      if (v !== 'always' && v !== 'never') continue;
      const h = normalizeHost(keys[i]);
      if (!h) continue;
      if (!hasOwn(out, h)) {
        if (n >= max) continue;
        n++;
      }
      out[h] = v;
    }
    return out;
  }

  /**
   * 找到对主机生效的规则：{ host: 规则所在的域名, rule }，无规则返回 null。
   * @param {string | null | undefined} host
   * @param {WptSiteRules | null | undefined} rules
   * @returns {{ host: string, rule: WptSiteRule } | null}
   */
  function matchSiteRule(host, rules) {
    if (!rules || typeof rules !== 'object') return null;
    let h = String(host || '').toLowerCase().replace(/\.+$/, '');
    const exactOnly = IPV4_RE.test(h);                  // IP 地址没有父域名
    while (h) {
      if (hasOwn(rules, h) && (rules[h] === 'always' || rules[h] === 'never')) return { host: h, rule: rules[h] };
      const dot = h.indexOf('.');
      if (exactOnly || dot < 0) break;
      h = h.slice(dot + 1);
    }
    return null;
  }

  /**
   * @param {string | null | undefined} host
   * @param {WptSiteRules | null | undefined} rules
   * @returns {WptSiteRule | null}
   */
  function siteRuleFor(host, rules) {
    const m = matchSiteRule(host, rules);
    return m ? m.rule : null;
  }

  /**
   * 内容脚本加载后是否自动开始翻译（手动翻译不经过这里，不受「从不翻译」限制）。
   * @param {Partial<WptSettings> | null | undefined} settings
   * @param {string | null | undefined} host
   * @returns {boolean}
   */
  function autoStartFor(settings, host) {
    const s = settings || {};
    const rule = siteRuleFor(host, s.siteRules);
    if (rule === 'never') return false;
    if (rule === 'always') return true;
    return !!s.autoTranslate;
  }

  /**
   * @param {string} h
   * @param {WptSiteRules} rules
   * @param {WptSiteRule} value
   */
  function hasRuleAbove(h, rules, value) {
    for (let i = h.indexOf('.'); i >= 0; i = h.indexOf('.', i + 1)) {
      if (rules[h.slice(i + 1)] === value) return true;
    }
    return false;
  }

  /**
   * @param {string} h
   * @param {WptSiteRules} rules
   * @param {WptSiteRule} value
   */
  function hasRuleBelow(h, rules, value) {
    const suffix = '.' + h;
    for (const k in rules) {
      if (rules[k] === value && k.length > suffix.length && k.slice(-suffix.length) === suffix) return true;
    }
    return false;
  }

  /**
   * 主机名 -> 匹配模式；withSubdomains 时同时覆盖全部子域名（IP 地址没有子域名）。
   * @param {string} h
   * @param {boolean} withSubdomains
   * @returns {string[]}
   */
  function hostPatterns(h, withSubdomains) {
    const out = ['*://' + h + '/*'];
    if (withSubdomains && !IPV4_RE.test(h)) out.push('*://*.' + h + '/*');
    return out;
  }

  /**
   * 自动翻译内容脚本的注册参数 { matches, excludeMatches? }；无需注册时返回 null。
   *   自动翻译开启：全部 http/https 页面，排除「从不翻译」的网站；
   *   自动翻译关闭：只匹配「总是翻译」的网站（及其子域名），排除其中「从不翻译」的子域名。
   * 「从不翻译」的域名下若还有「总是翻译」的子域名，只排除该域名本身，其余子域名交给内容脚本按规则判定。
   * 规则先经 normalizeSiteRules 清洗，保证不会生成无效的匹配模式（一个无效模式会让整次注册失败）。
   * @param {Partial<WptSettings> | null | undefined} settings
   * @returns {{ matches: string[], excludeMatches?: string[] } | null}
   */
  function autoRegistrationFor(settings) {
    const s = settings || {};
    const auto = !!s.autoTranslate;
    const rules = normalizeSiteRules(s.siteRules);
    const matches = auto ? ALL_PAGES.slice() : [];
    /** @type {string[]} */
    const exclude = [];
    for (const h in rules) {
      if (rules[h] === 'always') {
        if (!auto) matches.push.apply(matches, hostPatterns(h, true));
      } else if (auto || hasRuleAbove(h, rules, 'always')) {
        exclude.push.apply(exclude, hostPatterns(h, !hasRuleBelow(h, rules, 'always')));
      }
    }
    if (!matches.length) return null;
    /** @type {{ matches: string[], excludeMatches?: string[] }} */
    const reg = { matches: matches };
    if (exclude.length) reg.excludeMatches = exclude;
    return reg;
  }

  const api = {
    normalizeHost: normalizeHost,
    normalizeSiteRules: normalizeSiteRules,
    matchSiteRule: matchSiteRule,
    siteRuleFor: siteRuleFor,
    autoStartFor: autoStartFor,
    autoRegistrationFor: autoRegistrationFor
  };
  NS.siteRules = api;
  Object.assign(U, api);
})();
