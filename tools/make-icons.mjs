/*
 * 图标生成器：零依赖，自行做 4x 超采样光栅化 + PNG 编码。
 * 运行： node tools/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'icons');

/* ---------------- 几何工具 ---------------- */
function segDistT(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}

function insideRoundedRect(x, y, r) {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return Math.hypot(dx, dy) <= r;
}

/* ---------------- 图形定义（归一化坐标 0..1） ---------------- */
const GRAD_A = [79, 70, 229];    // #4F46E5
const GRAD_B = [124, 58, 237];   // #7C3AED
const WHITE = [255, 255, 255];

function box(x0, y0, x1, y1) {
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
const A_BOX = box(0.055, 0.405, 0.475, 0.845);
const W_BOX = box(0.525, 0.275, 0.950, 0.880);

function pt(b, u, v) {
  return { x: b.x0 + u * b.w, y: b.y0 + v * b.h };
}

/* 一条带可变粗细的笔画：宽度以所在字形框的宽度为基准 */
function stroke(b, u0, v0, u1, v1, w0, w1) {
  const p = pt(b, u0, v0), q = pt(b, u1, v1);
  const bw = b.w;
  return { ax: p.x, ay: p.y, bx: q.x, by: q.y, r0: (w0 * bw) / 2, r1: (w1 * bw) / 2 };
}

function hit(strokes, x, y) {
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const { d, t } = segDistT(x, y, s.ax, s.ay, s.bx, s.by);
    if (d <= s.r0 + (s.r1 - s.r0) * t) return true;
  }
  return false;
}

function makeGlyphs(bold) {
  const k = bold;   // 笔画粗细增益：小尺寸时适当加粗，保证可辨识
  const A = [
    stroke(A_BOX, 0.04, 1.0, 0.46, 0.02, 0.15 * k, 0.15 * k),
    stroke(A_BOX, 0.54, 0.02, 0.96, 1.0, 0.15 * k, 0.15 * k),
    stroke(A_BOX, 0.20, 0.68, 0.80, 0.68, 0.12 * k, 0.12 * k)
  ];
  const W = [
    stroke(W_BOX, 0.66, 0.02, 0.46, 0.20, 0.15 * k, 0.10 * k),
    stroke(W_BOX, 0.02, 0.34, 0.98, 0.34, 0.14 * k, 0.14 * k),
    stroke(W_BOX, 0.63, 0.52, 0.04, 1.0, 0.15 * k, 0.07 * k),
    stroke(W_BOX, 0.41, 0.52, 0.97, 1.0, 0.13 * k, 0.06 * k)
  ];
  return { A, W };
}

/* ---------------- 光栅化 ---------------- */
function pointColor(x, y, g) {
  const t = (x + y) / 2;
  if (!insideRoundedRect(x, y, 0.235)) return null;             // 圆角矩形之外透明
  let rgb = [
    GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t,
    GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t,
    GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t
  ];
  // 顶部加一点柔和高光，避免纯平色显得廉价
  const glow = Math.max(0, 1 - Math.hypot(x - 0.3, y - 0.16) * 2.1) * 26;
  rgb = rgb.map((c) => Math.min(255, c + glow));
  if (hit(g.A, x, y) || hit(g.W, x, y)) return WHITE;
  return rgb;
}

function render(size) {
  const SS = 4;                          // 每像素 4x4 超采样
  const bold = Math.min(1.28, Math.max(1.0, 1.35 / Math.max(1, size / 16) * 0.72 + 0.62));
  const g = makeGlyphs(bold);
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          const c = pointColor(x, y, g);
          if (c) { r += c[0]; gg += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const idx = (py * size + px) * 4;
      const cov = a / n;
      rgba[idx] = cov ? Math.round(r / (a / 255)) : 0;
      rgba[idx + 1] = cov ? Math.round(gg / (a / 255)) : 0;
      rgba[idx + 2] = cov ? Math.round(b / (a / 255)) : 0;
      rgba[idx + 3] = Math.round(cov);
    }
  }
  return rgba;
}

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, render(size));
  const file = path.join(OUT_DIR, 'icon' + size + '.png');
  fs.writeFileSync(file, png);
  console.log('generated', path.relative(process.cwd(), file), png.length + ' bytes');
}
