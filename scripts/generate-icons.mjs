/**
 * 生成 PWA 所需的 PNG 图标（纯 Node zlib 实现，不引入任何图像依赖）。
 *
 * 视觉：生活手帐风——印章红圆角方块 + 白色「生」字（与界面左上角印章标记一致）。
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web', 'public');
const SS = 3; // 超采样倍数，用于抗锯齿

/** 印章红（与 web/src/index.css 的 --brand 一致） */
const SEAL = { r: 180, g: 69, b: 58 };

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

/**
 * 「生」字笔画掩码（归一化 0..1 坐标）。
 * 五笔：三横 + 中间短竖 + 长横 + 底横；结构紧凑，在小尺寸下仍可辨识。
 */
/**
 * 「生」字笔画掩码（归一化 0..1 坐标）。
 * 生 = 丿 + 三横 + 中竖，共五笔；"丿"斜度与横画间距按楷体骨架校准，
 * 否则小尺寸下会被误认成"王"。
 */
const STROKES = [
  { kind: 'h', x0: 0.46, x1: 0.72, y0: 0.285, y1: 0.36 }, // 上横（撇与竖的交点处）
  { kind: 'h', x0: 0.3, x1: 0.84, y0: 0.45, y1: 0.525 }, // 第二横
  { kind: 'v', x0: 0.56, x1: 0.64, y0: 0.2, y1: 0.72 }, // 中竖（略偏右，撇在左）
  { kind: 'h', x0: 0.24, x1: 0.88, y0: 0.63, y1: 0.705 }, // 第三横
  { kind: 'h', x0: 0.18, x1: 0.94, y0: 0.785, y1: 0.86 }, // 底横
];

/** 丿：自右上向左下斜出，越往左下越粗 */
const PIE = { xTop: 0.55, xBot: 0.35, y0: 0.22, y1: 0.46, wTop: 0.022, wBot: 0.058 };

function insideSheng(nx, ny) {
  if (ny >= PIE.y0 && ny <= PIE.y1) {
    const t = (ny - PIE.y0) / (PIE.y1 - PIE.y0);
    const cx = PIE.xTop + (PIE.xBot - PIE.xTop) * t;
    const halfW = (PIE.wTop + (PIE.wBot - PIE.wTop) * t) / 2;
    if (Math.abs(nx - cx) <= halfW) return true;
  }
  for (const s of STROKES) {
    if (nx >= s.x0 && nx <= s.x1 && ny >= s.y0 && ny <= s.y1) return true;
  }
  return false;
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

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          if (!insideRoundedRect(px, py, big, radius)) continue;

          if (insideSheng(px / big, py / big)) {
            r += 255;
            g += 255;
            b += 255;
          } else {
            r += SEAL.r;
            g += SEAL.g;
            b += SEAL.b;
          }
          a += 255;
        }
      }

      const samples = SS * SS;
      const idx = (y * size + x) * 4;
      const alpha = a / samples;
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
