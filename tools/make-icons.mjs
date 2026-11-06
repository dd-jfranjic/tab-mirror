// Ikona: dva "prozora" s trakom tabova, jedan iza drugog (isti raspored na dva računala). Bez ovisnosti: PNG ručno.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const TEAL = [15, 110, 99];
const LIGHT = [180, 222, 214];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
function shade(u, v) {
  // u, v u [0,1]; stražnji prozor svjetliji, prednji tamni s bijelom trakom tabova
  const front = roundRect(u, v, 0.30, 0.32, 0.94, 0.90, 0.10);
  if (front) {
    const tabBar = v < 0.46 && v > 0.36 && ((u > 0.38 && u < 0.58) || (u > 0.62 && u < 0.82));
    return tabBar ? [255, 255, 255, 255] : [...TEAL, 255];
  }
  if (roundRect(u, v, 0.06, 0.10, 0.70, 0.68, 0.10)) return [...LIGHT, 255];
  return [0, 0, 0, 0];
}
function png(size) {
  const SS = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const p = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        for (let i = 0; i < 3; i++) acc[i] += p[i] * p[3]; acc[3] += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4, a = acc[3] / (SS * SS);
      for (let i = 0; i < 3; i++) raw[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = process.argv[2];
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}/icon${s}.png`, png(s));
console.log('icons ok');
