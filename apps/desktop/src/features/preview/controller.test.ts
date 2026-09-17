import { describe, expect, it } from "vitest";
import { rectChanged } from "./controller";

describe("rectChanged", () => {
  const base = { x: 100, y: 50, width: 640, height: 480 };

  it("treats a missing previous rect as changed", () => {
    expect(rectChanged(null, base)).toBe(true);
  });

  it("ignores sub-pixel jitter", () => {
    expect(rectChanged(base, { ...base, x: base.x + 0.3 })).toBe(false);
    expect(rectChanged(base, { ...base, width: base.width - 0.4 })).toBe(false);
  });

  it("detects real movement and resize", () => {
    expect(rectChanged(base, { ...base, x: base.x + 1 })).toBe(true);
    expect(rectChanged(base, { ...base, y: base.y - 2 })).toBe(true);
    expect(rectChanged(base, { ...base, width: base.width + 4 })).toBe(true);
    expect(rectChanged(base, { ...base, height: base.height - 8 })).toBe(true);
  });
});
