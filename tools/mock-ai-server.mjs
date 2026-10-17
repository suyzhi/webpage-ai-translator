/*
 * 离线模拟 AI 服务 —— 用于在没有 API 密钥的情况下验证扩展的完整链路。
 *
 * 用法：
 *   node tools/mock-ai-server.mjs                                  # 默认端口 8931
 *   node tools/mock-ai-server.mjs --dict demo/showcase-dict.json    # 使用词典给出真实译文
 *   node tools/mock-ai-server.mjs --copy-proper                     # 像真实模型一样原样返回人名 / 品牌
 *
 * 然后在扩展设置里填：
 *   Base URL: http://127.0.0.1:8931/v1     API 密钥: 留空（本地地址免密钥）     模型: 任意
 *
 * 端点：
 *   GET  /<path>                  以仓库根目录为根提供静态文件
 *   GET  /__stats                 返回请求数 / 批次数 / 峰值并发等统计
 *   POST /v1/chat/completions     按「N|文本」行协议返回译文
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', 8931));
const DICT_PATH = arg('dict', '');
const PREFIX = arg('prefix', '【译】');
const DELAY = Number(arg('delay', 140));
const COPY_PROPER = process.argv.includes('--copy-proper');
/* 常见界面词：真实模型会翻译它们，即便首字母大写 */
const UI_WORDS = new Set(['home', 'explore', 'notifications', 'messages', 'bookmarks', 'profile', 'follow', 'following', 'search', 'settings']);

/* 人名 / 品牌 / 专有名词：不超过 5 个词、没有 3 个字母以上的小写开头单词、且不是常见界面词 */
function looksProper(s) {
  if (!/^[\sA-Za-z\u00c0-\u024f.'\-]+$/.test(s)) return false;     // 只模拟拉丁字母的人名 / 品牌
  const words = s.trim().split(/\s+/);
  if (!words.length || words.length > 5 || /\n/.test(s)) return false;
  if (words.length === 1 && UI_WORDS.has(words[0].toLowerCase())) return false;
  return !words.some((w) => /^[a-z]{3,}/.test(w));
}

let DICT = null;
if (DICT_PATH) {
  DICT = JSON.parse(fs.readFileSync(path.resolve(ROOT, DICT_PATH), 'utf8'));
  console.log('已加载词典 ' + DICT_PATH + '（' + Object.keys(DICT).length + ' 条）');
}


const stats = { requests: 0, segments: 0, batches: [], texts: [], inflight: 0, peak: 0, startedAt: Date.now() };

function translate(segment) {
  const key = segment.replace(/\s+/g, ' ').trim();
  if (DICT && Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
  if (COPY_PROPER && looksProper(key)) return segment;
  return PREFIX + segment;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...stats, elapsedMs: Date.now() - stats.startedAt }));
  }

  if (req.method === 'POST' && req.url.split('?')[0].endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch (e) {}
      const user = ((json.messages || []).find((m) => m.role === 'user') || {}).content || '';
      // 行协议：每段一行「N|文本」，段内换行为 <br>
      const segs = [...user.matchAll(/^(\d+)\|(.*)$/gm)].map((m) => [m[0], m[1], m[2].replace(/<br>/g, '\n')]);
      stats.requests++;
      stats.segments += segs.length;
      stats.batches.push(segs.length);
      for (const m of segs) stats.texts.push(m[2]);
      stats.inflight++;
      stats.peak = Math.max(stats.peak, stats.inflight);
      console.log('[mock] 请求 #' + stats.requests + '：' + segs.length + ' 段' + (json.model ? '（模型 ' + json.model + '）' : ''));
      const content = segs
        .map((m) => m[1] + '|' + translate(m[2]).replace(/\r?\n/g, '<br>'))
        .join('\n');
      setTimeout(() => {
        stats.inflight--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-completion', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: json.model || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          // 粗略估算（约 4 字符 / token），让端到端测试能验证用量统计链路
          usage: (() => {
            const p = Math.ceil(user.length / 4) + 50, c = Math.ceil(content.length / 4);
            return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, prompt_cache_hit_tokens: 50 };
          })()
        }));
      }, DELAY);
    });
    return;
  }

  if (req.method === 'GET') {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const full = path.join(ROOT, rel === '/' ? 'demo/showcase.html' : rel);
    if (full.startsWith(ROOT) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(405).end('method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('模拟 AI 服务已启动：http://127.0.0.1:' + PORT);
  console.log('  演示页面  http://127.0.0.1:' + PORT + '/demo/showcase.html');
  console.log('  扩展设置  Base URL = http://127.0.0.1:' + PORT + '/v1 ，API 密钥留空');
});
