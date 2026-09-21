import { afterEach, describe, expect, it } from "vitest";
import {
  clampLayoutPatch,
  LAYOUT_DEFAULTS,
  loadLayout,
  persistLayout,
  responsivePaneHides,
} from "./layout";

const KEY = "rootray.layout.v1";

/** Minimal localStorage shim for the node test environment. */
function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(KEY, initial);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  return map;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("workbench layout persistence", () => {
  it("returns defaults when nothing is stored", () => {
    fakeStorage();
    const l = loadLayout();
    expect(l.explorerWidth).toBe(LAYOUT_DEFAULTS.explorerWidth);
    expect(l.splitRatio).toBe(LAYOUT_DEFAULTS.splitRatio);
    expect(l.explorerVisible).toBe(true);
  });

  it("clamps out-of-range persisted values field-by-field", () => {
    fakeStorage(
      JSON.stringify({
        explorerWidth: 4,
        inspectorWidth: 99999,
        outputHeight: -50,
        splitRatio: 42,
        inspectorVisible: false,
      }),
    );
    const l = loadLayout();
    expect(l.explorerWidth).toBe(160); // clamped to min
    expect(l.inspectorWidth).toBe(420); // clamped to max
    expect(l.outputHeight).toBe(80);
    expect(l.splitRatio).toBe(0.9);
    expect(l.inspectorVisible).toBe(false); // valid value kept
    expect(l.explorerVisible).toBe(true); // missing → default
  });

  it("survives corrupt JSON and wrong types", () => {
    fakeStorage("{not json");
    expect(loadLayout().explorerWidth).toBe(LAYOUT_DEFAULTS.explorerWidth);

    fakeStorage(JSON.stringify({ explorerWidth: "huge", splitRatio: null }));
    const l = loadLayout();
    expect(l.explorerWidth).toBe(LAYOUT_DEFAULTS.explorerWidth);
    expect(l.splitRatio).toBe(LAYOUT_DEFAULTS.splitRatio);
  });

  it("persists only the durable subset — never focus or auto state", () => {
    const map = fakeStorage();
    persistLayout({
      ...LAYOUT_DEFAULTS,
      explorerWidth: 300,
      focusMode: "preview",
      autoExplorer: true,
      outputVisible: true,
    });
    const stored = JSON.parse(map.get(KEY) ?? "{}") as Record<string, unknown>;
    expect(stored.explorerWidth).toBe(300);
    expect(stored.outputVisible).toBe(true);
    expect(stored.focusMode).toBeUndefined();
    expect(stored.autoExplorer).toBeUndefined();
    // A round-trip restores exactly what was persisted.
    expect(loadLayout().explorerWidth).toBe(300);
  });

  it("clampLayoutPatch bounds every numeric field", () => {
    const p = clampLayoutPatch({
      explorerWidth: 0,
      inspectorWidth: 10_000,
      outputHeight: 5,
      splitRatio: -1,
    });
    expect(p.explorerWidth).toBe(160);
    expect(p.inspectorWidth).toBe(420);
    expect(p.outputHeight).toBe(80);
    expect(p.splitRatio).toBe(0.1);
  });
});

describe("responsive workbench pane priority", () => {
  const base = {
    split: true,
    explorerVisible: true,
    inspectorVisible: true,
    explorerWidth: 220,
    inspectorWidth: 350,
  };

  it("auto-collapses Inspector before Explorer when Split is constrained", () => {
    expect(responsivePaneHides({ ...base, availableWidth: 1_250 })).toEqual({
      explorer: false,
      inspector: true,
    });
    expect(responsivePaneHides({ ...base, availableWidth: 900 })).toEqual({
      explorer: true,
      inspector: true,
    });
  });

  it("restores responsive hides when enough width returns without changing preferences", () => {
    expect(responsivePaneHides({ ...base, availableWidth: 1_600 })).toEqual({
      explorer: false,
      inspector: false,
    });
    expect(
      responsivePaneHides({ ...base, availableWidth: 1_300, inspectorVisible: false }),
    ).toEqual({ explorer: false, inspector: false });
  });

  it("does not auto-hide side panes outside Split mode", () => {
    expect(responsivePaneHides({ ...base, split: false, availableWidth: 700 })).toEqual({
      explorer: false,
      inspector: false,
    });
  });
});
