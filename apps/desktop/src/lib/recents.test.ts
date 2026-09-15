import { describe, expect, it } from "vitest";
import { getRecentFiles, pushRecentFile } from "./recents";

function fakeStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("recent files", () => {
  it("stores newest-first and dedupes", () => {
    const s = fakeStore();
    pushRecentFile("/root", "src/a.ts", s);
    pushRecentFile("/root", "src/b.ts", s);
    pushRecentFile("/root", "src/a.ts", s);
    expect(getRecentFiles("/root", s)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("caps the list at 10", () => {
    const s = fakeStore();
    for (let i = 0; i < 15; i++) pushRecentFile("/root", `src/f${i}.ts`, s);
    expect(getRecentFiles("/root", s)).toHaveLength(10);
  });

  it("keeps projects separate", () => {
    const s = fakeStore();
    pushRecentFile("/a", "x.ts", s);
    pushRecentFile("/b", "y.ts", s);
    expect(getRecentFiles("/a", s)).toEqual(["x.ts"]);
    expect(getRecentFiles("/b", s)).toEqual(["y.ts"]);
  });

  it("tolerates corrupt storage", () => {
    const s = { getItem: () => "not json{{{", setItem: () => {} };
    expect(getRecentFiles("/r", s)).toEqual([]);
  });

  it("returns empty without a storage backend", () => {
    expect(getRecentFiles("/r", undefined)).toEqual([]);
  });
});
