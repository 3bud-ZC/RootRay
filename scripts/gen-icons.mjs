// Generates the RootRay icon set (dark tile + ember "ray" dot) as PNGs and
// a PNG-compressed ICO — no external tools required.
// Usage: node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/desktop/src-tauri/icons",
);

const BG = [13, 17, 23, 255]; // #0d1117
const FG = [255, 122, 69, 255]; // #ff7a45 ember
const RING = [255, 122, 69, 90];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
  return out;
}

function renderPng(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const rDot = size * 0.16;
  const rRing = size * 0.3;
  const rCorner = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-rect mask
      const qx = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      const edge = size / 2 - rCorner;
      let inside = true;
      if (qx > edge) {
        const dx = Math.abs(x - cx) - edge;
        const dy = Math.abs(y - cy) - edge;
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > rCorner) inside = false;
      }
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      let color = BG;
      if (!inside) color = [0, 0, 0, 0];
      else if (d < rDot) color = FG;
      else if (d < rRing && d > rRing * 0.72) color = RING;
      px.set(color, i);
    }
  }
  // prepend filter byte per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png]);
}

mkdirSync(ICONS_DIR, { recursive: true });
const png256 = renderPng(256);
writeFileSync(join(ICONS_DIR, "icon.png"), png256);
writeFileSync(join(ICONS_DIR, "icon.ico"), makeIco(png256, 256));
writeFileSync(join(ICONS_DIR, "128x128.png"), renderPng(128));
writeFileSync(join(ICONS_DIR, "32x32.png"), renderPng(32));
console.log("icons written to", ICONS_DIR);
