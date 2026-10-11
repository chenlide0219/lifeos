/**
 * 生成 PWA 所需的 PNG 图标（纯 Node zlib 实现，不引入任何图像依赖）。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web', 'public');
const SS = 2; // 超采样倍数，用于抗锯齿

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形内？ */
function insideRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 字母 L：竖条 + 横条 */
function insideLetterL(x, y, size) {
  const vertical = x >= size * 0.34 && x <= size * 0.43 && y >= size * 0.27 && y <= size * 0.73;
  const horizontal = x >= size * 0.34 && x <= size * 0.68 && y >= size * 0.64 && y <= size * 0.73;
  return vertical || horizontal;
}

function renderIcon(size) {
  const big = size * SS;
  const radius = big * 0.22;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // 超采样平均
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          if (!insideRoundedRect(px, py, big, radius)) continue;

          if (insideLetterL(px, py, big)) {
            r += 255;
            g += 255;
            b += 255;
            a += 255;
          } else {
            // 对角渐变：#818cf8 → #4f46e5
            const t = (px / big + py / big) / 2;
            r += Math.round(129 + (79 - 129) * t);
            g += Math.round(140 + (70 - 140) * t);
            b += Math.round(248 + (229 - 248) * t);
            a += 255;
          }
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      const alpha = a / samples;
      // 按覆盖的 alpha 归一化颜色，避免边缘发暗
      const coverage = alpha / 255;
      pixels[idx] = coverage > 0 ? Math.round(r / samples / coverage) : 0;
      pixels[idx + 1] = coverage > 0 ? Math.round(g / samples / coverage) : 0;
      pixels[idx + 2] = coverage > 0 ? Math.round(b / samples / coverage) : 0;
      pixels[idx + 3] = Math.round(alpha);
    }
  }

  return encodePng(size, size, pixels);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`已生成 ${file}`);
}
