import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * Functional guards for the shipped brand layer: the runtime assets the
 * UI references must exist, be real PNGs/ICO, and the application icon
 * must be the pixel ROBOT at every frame — never the orange ring mark.
 * Lives in node env — no DOM required.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function pngOk(path: string): Buffer {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 4).equals(PNG_MAGIC), `${path} is not a PNG`).toBe(true);
  return buf;
}

interface IcoFrame {
  size: number;
  data: Buffer;
}

/** Parse the ICO directory and return each frame's image blob. */
function icoFrames(path: string): IcoFrame[] {
  const buf = readFileSync(path);
  expect(buf.readUInt16LE(2), `${path} is not an ICO`).toBe(1);
  const count = buf.readUInt16LE(4);
  const frames: IcoFrame[] = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf[off] === 0 ? 256 : (buf[off] ?? 0);
    const len = buf.readUInt32LE(off + 8);
    const start = buf.readUInt32LE(off + 12);
    frames.push({ size: w, data: buf.subarray(start, start + len) });
  }
  return frames;
}

/** Minimal PNG decoder for the 8-bit RGBA/RGB frames PIL writes. */
function decodePng(buf: Buffer): { width: number; height: number; px: Buffer } {
  expect(buf.subarray(0, 4).equals(PNG_MAGIC), "frame is not PNG-encoded").toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? 0;
      expect(data[8], "expected 8-bit channels").toBe(8);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(bpp, `unsupported PNG color type ${colorType}`).toBeGreaterThan(0);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[x - bpp] ?? 0) : 0;
      const b = prev ? (prev[x] ?? 0) : 0;
      const c = x >= bpp && prev ? (prev[x - bpp] ?? 0) : 0;
      const v = row[x] ?? 0;
      let r = v;
      if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[x] = r & 0xff;
    }
  }
  return { width, height, px };
}

/** Classify frame pixels: robot = white head + black face + orange marks. */
function frameColorStats(frame: IcoFrame) {
  const { px } = decodePng(frame.data);
  const n = px.length / 4;
  let white = 0;
  let dark = 0;
  let orange = 0;
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 4] ?? 0;
    const g = px[i * 4 + 1] ?? 0;
    const b = px[i * 4 + 2] ?? 0;
    const a = px[i * 4 + 3] ?? 0;
    if (a < 40) continue;
    opaque++;
    if (r > 180 && g > 180 && b > 180) white++;
    else if (r < 45 && g < 45 && b < 55) dark++;
    else if (r > 170 && g > 50 && g < 160 && b < 70) orange++;
  }
  return { opaque, white, dark, orange };
}

describe("brand assets", () => {
  it.each(["lockup.png", "mascot.png", "wordmark.png"])(
    "public/brand/%s is a real PNG under 256 KB",
    (name) => {
      const buf = pngOk(`public/brand/${name}`);
      expect(buf.length).toBeGreaterThan(4_000);
      expect(buf.length).toBeLessThan(256 * 1024);
    },
  );

  it("public/brand/mascot-head.png is a real PNG (compact 24px glyph)", () => {
    const buf = pngOk("public/brand/mascot-head.png");
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.length).toBeLessThan(64 * 1024);
  });

  it.each(["icon-16.png", "icon-24.png", "icon-32.png"])(
    "docs/brand/%s small-icon master exists",
    (name) => {
      pngOk(`../../docs/brand/${name}`);
    },
  );

  it("icon.ico is a multi-size ICO with all required frames", () => {
    const frames = icoFrames("src-tauri/icons/icon.ico");
    expect(frames.length).toBeGreaterThanOrEqual(7);
    const sizes = frames.map((f) => f.size);
    for (const s of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes, `missing ${s}px frame`).toContain(s);
    }
  });

  it.each([16, 24, 32])(
    "icon.ico %dpx frame is the ROBOT — white head, black face, orange marks (not a ring)",
    (size) => {
      const frame = icoFrames("src-tauri/icons/icon.ico").find((f) => f.size === size);
      expect(frame, `no ${size}px frame`).toBeTruthy();
      const s = frameColorStats(frame as IcoFrame);
      // The ring mark was ~100% orange on transparent. A robot icon must
      // contain all three signature colors in meaningful amounts.
      expect(s.white, `${size}px: no white head pixels`).toBeGreaterThan(8);
      expect(s.dark, `${size}px: no black face pixels`).toBeGreaterThan(8);
      expect(s.orange, `${size}px: no orange eye/antenna pixels`).toBeGreaterThan(2);
      expect(s.orange / s.opaque, `${size}px: reads as ring mark`).toBeLessThan(0.6);
    },
  );
});

describe("app header", () => {
  const app = readFileSync("src/app/App.tsx", "utf8");

  it("header mark uses the purpose-built head glyph, not the full mascot", () => {
    expect(app).toContain("/brand/mascot-head.png");
  });

  it("wordmark splits Root / Ray for accent coloring", () => {
    expect(app).toContain('brand-name-accent">Ray');
  });
});

describe("splash", () => {
  const html = readFileSync("index.html", "utf8");

  it("ships a branded bootstrap splash referencing the lockup", () => {
    expect(html).toContain("boot-splash");
    expect(html).toContain("/brand/lockup.png");
  });

  it("has no artificial delay — nothing schedules the splash lifetime", () => {
    expect(html).not.toMatch(/setTimeout|setInterval/);
  });
});

describe("reduced motion", () => {
  const css = readFileSync("src/index.css", "utf8");

  it("the global reduced-motion rule covers the brand loader", () => {
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("animation: none !important");
    expect(css).toContain(".brand-loader-track::after");
  });
});
