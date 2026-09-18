import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Functional guards for the shipped brand layer: the runtime assets the
 * UI references must exist, be real PNGs/ICO, and stay reasonably small.
 * Lives in node env — no DOM required.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function pngOk(path: string): Buffer {
  const buf = readFileSync(path);
  expect(buf.subarray(0, 4).equals(PNG_MAGIC), `${path} is not a PNG`).toBe(true);
  return buf;
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

  it("icon.ico is a multi-size ICO with all required frames", () => {
    const buf = readFileSync("src-tauri/icons/icon.ico");
    // ICO header: reserved(2) type(2)=1 count(2)
    expect(buf.readUInt16LE(2)).toBe(1);
    const count = buf.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(7);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      const byte = buf[off] ?? 0;
      sizes.push(byte === 0 ? 256 : byte);
    }
    for (const s of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes, `missing ${s}px frame`).toContain(s);
    }
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
