import { describe, expect, it } from "vitest";
import { formatElapsed, projectDisplayName, stripAnsi } from "./format";

describe("formatElapsed", () => {
  it("formats seconds and hours", () => {
    const t0 = 1_000_000;
    expect(formatElapsed(t0, t0 + 61_000)).toBe("1:01");
    expect(formatElapsed(t0, t0 + 3_725_000)).toBe("1:02:05");
    expect(formatElapsed(t0, t0 + 5_000)).toBe("0:05");
  });

  it("returns a placeholder when not started", () => {
    expect(formatElapsed(null, 0)).toBe("—");
  });
});

describe("projectDisplayName", () => {
  it("prefers the package name", () => {
    expect(projectDisplayName("my-app", "C:\\x\\y")).toBe("my-app");
  });
  it("falls back to the last path segment", () => {
    expect(projectDisplayName(null, "C:\\projects\\cool-app")).toBe("cool-app");
    expect(projectDisplayName(null, "/home/u/cool-app")).toBe("cool-app");
  });
});

describe("stripAnsi", () => {
  it("removes color and cursor sequences", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m")).toBe("ok");
    expect(stripAnsi("\u001b[1;36mhttp://x\u001b[0m done")).toBe("http://x done");
  });
});
