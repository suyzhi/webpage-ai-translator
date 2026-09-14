/*
 * 离线模拟 AI 服务 —— 用于在没有 API 密钥的情况下验证扩展的完整链路。
 *
 * 用法：
 *   node tools/mock-ai-server.mjs                                  # 默认端口 8931
 *   node tools/mock-ai-server.mjs --dict demo/showcase-dict.json    # 使用词典给出真实译文
 *
 * 然后在扩展设置里填：
 *   Base URL: http://127.0.0.1:8931/v1     API 密钥: 留空（本地地址免密钥）     模型: 任意
 *
 * 端点：
 *   GET  /<path>                  以仓库根目录为根提供静态文件
 *   GET  /__stats                 返回请求数 / 批次数等统计
 *   POST /v1/chat/completions     按 <t id="n">…</t> 批量协议返回译文
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

let DICT = null;
if (DICT_PATH) {
  DICT = JSON.parse(fs.readFileSync(path.resolve(ROOT, DICT_PATH), 'utf8'));
  console.log('已加载词典 ' + DICT_PATH + '（' + Object.keys(DICT).length + ' 条）');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const stats = { requests: 0, segments: 0, batches: [], startedAt: Date.now() };

function translate(segment) {
  const key = segment.replace(/\s+/g, ' ').trim();
  if (DICT && Object.prototype.hasOwnProperty.call(DICT, key)) return DICT[key];
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
      const segs = [...user.matchAll(/<t id="(\d+)">([\s\S]*?)<\/t>/g)];
      stats.requests++;
      stats.segments += segs.length;
      stats.batches.push(segs.length);
      console.log('[mock] 请求 #' + stats.requests + '：' + segs.length + ' 段' + (json.model ? '（模型 ' + json.model + '）' : ''));
      const content = segs
        .map((m) => '<t id="' + m[1] + '">' + esc(translate(unesc(m[2]))) + '</t>')
        .join('\n');
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-completion', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: json.model || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
