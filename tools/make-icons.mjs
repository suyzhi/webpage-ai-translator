/*
 * 图标生成器：零 npm 依赖，由 icons/logo.svg 经无头浏览器 Skia 引擎光栅化为 16/32/48/128 PNG。
 * 运行：node tools/make-icons.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, killTree } from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'icons');
const SVG_PATH = path.join(OUT_DIR, 'logo.svg');
const SIZES = [16, 32, 48, 128];

async function main() {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpt-icons-'));
  let browser = null;

  try {
    browser = await launchBrowser({ profileDir, extensionDebug: false });
    const cdp = browser.cdp;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Page.enable', {}, session);

    // 用 4x 超采样离屏画布缩小，保证 16/32 小尺寸图标依然锐利清晰
    const renderExpr = `
      (async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        const out = {};
        for (const size of ${JSON.stringify(SIZES)}) {
          const hi = document.createElement('canvas');
          const scale = size <= 32 ? 4 : 2;
          hi.width = size * scale;
          hi.height = size * scale;
          const hctx = hi.getContext('2d');
          hctx.imageSmoothingEnabled = true;
          hctx.imageSmoothingQuality = 'high';
          hctx.drawImage(img, 0, 0, hi.width, hi.height);

          const c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(hi, 0, 0, size, size);
          out[size] = c.toDataURL('image/png').split(',')[1];
        }
        return out;
      })()
    `;
    const rendered = await cdp.evalIn(session, renderExpr);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const size of SIZES) {
      const buf = Buffer.from(rendered[size], 'base64');
      const file = path.join(OUT_DIR, 'icon' + size + '.png');
      fs.writeFileSync(file, buf);
      console.log('generated', path.relative(process.cwd(), file), buf.length + ' bytes');
    }
  } finally {
    if (browser) {
      try { browser.cdp.proc.stdio[3].end(); } catch (e) {}
      killTree(browser.proc);
    }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
