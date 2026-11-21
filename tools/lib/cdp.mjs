/*
 * 轻量 CDP 客户端（零依赖）：通过 --remote-debugging-pipe 驱动无头浏览器。
 * 命令写入 fd3，响应从 fd4 读取（NUL 结尾的 JSON），Node 18+ 均可运行，无需 WebSocket。
 * 供 tools/e2e-headless.mjs / e2e-extract.mjs / e2e-ui.mjs 复用。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NUL = String.fromCharCode(0);

export function findBrowser() {
  const candidates = [];
  const env = process.env.CHROME_PATH || process.env.WPT_E2E_BROWSER;
  if (env) candidates.push(env);
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (process.platform === 'win32') {
    const bases = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']];
    for (const base of bases) {
      if (!base) continue;
      candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
    );
  }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* 忽略 */ }
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.json();
}

export async function waitFor(label, fn, timeout, interval) {
  const limit = timeout || 30000;
  const step = interval || 150;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < limit) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('等待「' + label + '」超时' + (last ? '：' + last.message : ''));
}

export class PipeCDP {
  constructor(proc) {
    this.proc = proc;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    const stream = proc.stdio[4];
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf(NUL)) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          const list = this.listeners.get(msg.method);
          if (list) for (const fn of list) fn(msg.params, msg.sessionId);
        }
      }
    });
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  send(method, params, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params: params || {} };
      if (sessionId) message.sessionId = sessionId;
      this.proc.stdio[3].write(JSON.stringify(message) + NUL);
    });
  }
  async evalIn(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    }, sessionId);
    if (r.exceptionDetails) throw new Error('Runtime.evaluate 失败：' + JSON.stringify(r.exceptionDetails).slice(0, 700));
    return r.result ? r.result.value : undefined;
  }
}

export async function launchBrowser(opts) {
  const o = opts || {};
  const browserPath = findBrowser();
  if (!browserPath) {
    const err = new Error('未找到 Chrome / Chromium / Edge，请设置 CHROME_PATH 后重试。');
    err.code = 'NO_BROWSER';
    throw err;
  }
  const profileDir = o.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-e2e-'));
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu'
  ];
  if (o.extensionDebug !== false) {
    args.push('--enable-unsafe-extension-debugging');
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch');
  }
  if (o.args) args.push.apply(args, o.args);
  args.push('about:blank');

  const proc = spawn(browserPath, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  const stderr = [];
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr.push(d); if (stderr.length > 200) stderr.shift(); });

  const cdp = new PipeCDP(proc);
  try {
    await waitFor('CDP 就绪', async () => { await cdp.send('Browser.getVersion'); return true; }, 25000, 250);
  } catch (e) {
    killTree(proc);
    throw e;
  }
  return { browserPath, proc, cdp, profileDir, stderr };
}

export function killTree(proc) {
  if (!proc || proc.exitCode != null) return;
  try {
    if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
    else proc.kill('SIGKILL');
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch (e2) { /* 已退出 */ }
  }
}

export function spawnMockServer(options) {
  const o = options || {};
  const args = [path.join(o.root, 'tools', 'mock-ai-server.mjs'), '--port', String(o.port)];
  if (o.dict) args.push('--dict', o.dict);
  if (o.delay != null) args.push('--delay', String(o.delay));
  if (o.copyProper) args.push('--copy-proper');
  if (o.pseudoZh) args.push('--pseudo-zh');
  return spawn(process.execPath, args, { cwd: o.root, stdio: ['ignore', 'pipe', 'pipe'] });
}
