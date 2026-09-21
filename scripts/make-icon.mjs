// Рисует icon.png (512×512): бумажный самолётик и искра на сине-фиолетовом
// скруглённом квадрате. Без зависимостей: фигуры со сглаживанием и свой PNG-кодер.
//   node scripts/make-icon.mjs [путь] [размер]

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const out = process.argv[2] ?? new URL('../icon.png', import.meta.url).pathname;
const SIZE = Number(process.argv[3] ?? 512);
const SS = 4; // выборок на пиксель по каждой оси

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TOP = hex('#2F80ED');
const BOTTOM = hex('#6A4BD6');

// Фигуры в координатах 0..100.
const shapes = [
  { poly: [[18, 49], [81, 23], [42, 57]], color: hex('#FFFFFF') },
  { poly: [[42, 57], [81, 23], [60, 77]], color: hex('#E3EAF8') },
  { poly: [[42, 57], [46, 73], [53, 63]], color: hex('#BFCBEA') },
];
const sparkle = { cx: 27, cy: 27, r: 10, color: hex('#FFC15E') };

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y) {
  const r = 22;
  const cx = Math.min(Math.max(x, r), 100 - r);
  const cy = Math.min(Math.max(y, r), 100 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && x <= 100 && y >= 0 && y <= 100;
}

// Четырёхлучевая звезда: |dx|^p + |dy|^p ≤ r^p при p < 1.
function inSparkle(x, y) {
  const dx = Math.abs(x - sparkle.cx) / sparkle.r;
  const dy = Math.abs(y - sparkle.cy) / sparkle.r;
  return dx ** 0.55 + dy ** 0.55 <= 1;
}

const px = new Uint8Array(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let pxl = 0; pxl < SIZE; pxl++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = ((pxl + (sx + 0.5) / SS) / SIZE) * 100;
        const y = ((py + (sy + 0.5) / SS) / SIZE) * 100;
        if (!inRoundedSquare(x, y)) continue;
        let c = null;
        for (const s of shapes) if (inPoly(x, y, s.poly)) c = s.color;
        if (!c && inSparkle(x, y)) c = sparkle.color;
        if (!c) {
          const t = Math.min(1, Math.max(0, (x * 0.35 + y * 0.65) / 100));
          c = TOP.map((v, i) => v + (BOTTOM[i] - v) * t);
        }
        r += c[0];
        g += c[1];
        b += c[2];
        a += 1;
      }
    }
    const i = (py * SIZE + pxl) * 4;
    if (a) {
      px[i] = Math.round(r / a);
      px[i + 1] = Math.round(g / a);
      px[i + 2] = Math.round(b / a);
    }
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // бит на канал
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(out, png);
process.stdout.write(`${out}: ${SIZE}×${SIZE}, ${png.length} байт\n`);
