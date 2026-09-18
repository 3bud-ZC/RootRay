import type { RuntimeState } from "@rootray/shared";
import { describe, expect, it } from "vitest";
import { emptyRuntime, initialUiState, LOG_CAP, type UiState, uiReducer } from "./reducer";

function runtime(over: Partial<RuntimeState>): RuntimeState {
  return { ...emptyRuntime, ...over };
}

describe("uiReducer", () => {
  it("applies runtime snapshots", () => {
    const s = uiReducer(initialUiState, {
      type: "runtime",
      state: runtime({ phase: "running", pid: 1234 }),
    });
    expect(s.runtime.phase).toBe("running");
    expect(s.runtime.pid).toBe(1234);
  });

  it("drops stale runtime snapshots arriving out of order", () => {
    // Concurrent emit paths (IPC thread + process watcher) can deliver
    // an older snapshot after a newer one — seq must never go backwards.
    let s = uiReducer(initialUiState, {
      type: "runtime",
      state: runtime({ seq: 5, phase: "ready" }),
    });
    s = uiReducer(s, {
      type: "runtime",
      state: runtime({ seq: 3, phase: "stopping" }),
    });
    expect(s.runtime.phase).toBe("ready");
    // Equal-seq snapshots still apply (idempotent re-delivery).
    s = uiReducer(s, {
      type: "runtime",
      state: runtime({ seq: 5, phase: "running" }),
    });
    expect(s.runtime.phase).toBe("running");
  });

  it("appends log events and caps the buffer", () => {
    let s: UiState = initialUiState;
    for (let i = 0; i < LOG_CAP + 50; i++) {
      s = uiReducer(s, {
        type: "process-event",
        event: { kind: "stdout", line: `line ${i}` },
      });
    }
    expect(s.logs).toHaveLength(LOG_CAP);
    expect(s.logs[LOG_CAP - 1]?.line).toBe(`line ${LOG_CAP + 49}`);
    expect(s.logs[0]?.line).toBe("line 50");
  });

  it("tags stderr lines distinctly", () => {
    const s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "stderr", line: "boom" },
    });
    expect(s.logs[0]?.stream).toBe("stderr");
  });

  it("clears the log tail when a new run starts", () => {
    let s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "stdout", line: "old" },
    });
    s = uiReducer(s, {
      type: "runtime",
      state: runtime({ phase: "starting" }),
    });
    expect(s.logs).toHaveLength(0);
  });

  it("ignores non-log process events for the log buffer", () => {
    const s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "url-detected", url: "http://localhost:5173/", port: 5173 },
    });
    expect(s.logs).toHaveLength(0);
  });

  it("toggles settings and records notices", () => {
    let s = uiReducer(initialUiState, { type: "toggle-settings" });
    expect(s.settingsOpen).toBe(true);
    s = uiReducer(s, { type: "toggle-settings", open: false });
    expect(s.settingsOpen).toBe(false);
    s = uiReducer(s, { type: "notice", message: "failed" });
    expect(s.notice).toBe("failed");
    s = uiReducer(s, { type: "notice", message: null });
    expect(s.notice).toBeNull();
  });

  it("applies preview snapshots and rejects stale generations", () => {
    let s = uiReducer(initialUiState, {
      type: "preview-state",
      state: { phase: "ready", url: "http://localhost:5173/", error: null, generation: 3 },
    });
    expect(s.preview.phase).toBe("ready");
    expect(s.preview.url).toBe("http://localhost:5173/");
    // An out-of-order older snapshot must not resurrect dead state.
    s = uiReducer(s, {
      type: "preview-state",
      state: { phase: "loading", url: "http://localhost:5173/old", error: null, generation: 2 },
    });
    expect(s.preview.phase).toBe("ready");
    expect(s.preview.url).toBe("http://localhost:5173/");
    // A newer snapshot applies normally.
    s = uiReducer(s, {
      type: "preview-state",
      state: { phase: "stopped", url: null, error: null, generation: 4 },
    });
    expect(s.preview.phase).toBe("stopped");
  });

  it("tracks the workspace tab and the auto-preview preference", () => {
    let s = uiReducer(initialUiState, { type: "workspace-tab", tab: "split" });
    expect(s.workspaceTab).toBe("split");
    s = uiReducer(s, { type: "auto-preview", enabled: false });
    expect(s.autoPreview).toBe(false);
    s = uiReducer(s, { type: "workspace-tab", tab: "code" });
    expect(s.workspaceTab).toBe("code");
  });

  it("replaces a still-loading editor — newest selection must win", () => {
    const loc = (line: number) => ({
      relativePath: "src/A.tsx",
      line,
      column: 1,
    });
    let s = uiReducer(initialUiState, {
      type: "edit-open",
      relativePath: "src/A.tsx",
      source: loc(1),
    });
    expect(s.editor?.status).toBe("loading");
    // A second selection lands while the first file is still loading.
    // Nothing user-owned exists yet — the open must not park behind the
    // unsaved-changes prompt.
    s = uiReducer(s, {
      type: "edit-open",
      relativePath: "src/B.tsx",
      source: { ...loc(3), relativePath: "src/B.tsx" },
    });
    expect(s.editor?.relativePath).toBe("src/B.tsx");
    expect(s.editor?.status).toBe("loading");
    expect(s.editorClosePrompt).toBe(false);
    expect(s.pendingOpen).toBeNull();
    // The stale A read is discarded; B's read applies.
    const readB = {
      relativePath: "src/B.tsx",
      content: "// B\n",
      hash: "h",
      lineEnding: "lf" as const,
      bom: false,
      sizeBytes: 5,
    };
    s = uiReducer(s, {
      type: "edit-opened",
      read: { ...readB, relativePath: "src/A.tsx" },
      source: loc(1),
    });
    expect(s.editor?.relativePath).toBe("src/B.tsx");
    s = uiReducer(s, {
      type: "edit-opened",
      read: readB,
      source: { ...loc(3), relativePath: "src/B.tsx" },
    });
    expect(s.editor?.relativePath).toBe("src/B.tsx");
    expect(s.editor?.status).toBe("clean");
    // A dirty session, by contrast, still parks behind the prompt.
    s = uiReducer(s, { type: "edit-changed", content: "// B edited\n" });
    expect(s.editor?.status).toBe("dirty");
    s = uiReducer(s, {
      type: "edit-open",
      relativePath: "src/C.tsx",
      source: { ...loc(5), relativePath: "src/C.tsx" },
    });
    expect(s.editorClosePrompt).toBe(true);
    expect(s.pendingOpen?.relativePath).toBe("src/C.tsx");
  });
});

describe("workbench layout", () => {
  const src = { relativePath: "src/App.tsx", line: 4, column: 2 };

  it("applies and clamps layout patches", () => {
    let s = uiReducer(initialUiState, {
      type: "layout-update",
      patch: { explorerWidth: 40, inspectorWidth: 9000, splitRatio: 1.4 },
    });
    expect(s.layout.explorerWidth).toBe(160);
    expect(s.layout.inspectorWidth).toBe(560);
    expect(s.layout.splitRatio).toBe(0.9);

    s = uiReducer(s, {
      type: "layout-update",
      patch: { explorerVisible: false, outputHeight: 10 },
    });
    expect(s.layout.explorerVisible).toBe(false);
    expect(s.layout.outputHeight).toBe(80);
    // Untouched fields keep their values.
    expect(s.layout.inspectorVisible).toBe(true);
  });

  it("restores persisted layout safely with clamping", () => {
    const s = uiReducer(initialUiState, {
      type: "layout-restore",
      layout: {
        explorerWidth: 5,
        inspectorVisible: false,
        splitRatio: 0.33,
        focusMode: "preview",
      },
    });
    expect(s.layout.explorerWidth).toBe(160);
    expect(s.layout.inspectorVisible).toBe(false);
    expect(s.layout.splitRatio).toBe(0.33);
    // Focus mode is session-only — never touched by a restore merge.
    expect(s.layout.focusMode).toBe("preview");
  });

  it("auto-hide flags layer over user visibility", () => {
    const s = uiReducer(initialUiState, {
      type: "layout-auto",
      explorer: true,
      inspector: true,
    });
    expect(s.layout.autoExplorer).toBe(true);
    expect(s.layout.autoInspector).toBe(true);
    // The stored preference is untouched — widening restores it.
    expect(s.layout.explorerVisible).toBe(true);
    expect(s.layout.inspectorVisible).toBe(true);
  });

  it("leaving preview focus clears a deferred reveal offer", () => {
    let s = uiReducer(initialUiState, { type: "layout-focus", mode: "preview" });
    s = uiReducer(s, { type: "reveal-offer", relativePath: src.relativePath, source: src });
    expect(s.revealOffer?.relativePath).toBe("src/App.tsx");
    s = uiReducer(s, { type: "layout-focus", mode: "none" });
    expect(s.layout.focusMode).toBe("none");
    expect(s.revealOffer).toBeNull();
  });

  it("reveal offers replace each other and clear explicitly", () => {
    let s = uiReducer(initialUiState, { type: "layout-focus", mode: "preview" });
    s = uiReducer(s, { type: "reveal-offer", relativePath: "src/A.tsx", source: src });
    s = uiReducer(s, { type: "reveal-offer", relativePath: "src/B.tsx", source: src });
    expect(s.revealOffer?.relativePath).toBe("src/B.tsx");
    s = uiReducer(s, { type: "reveal-offer-clear" });
    expect(s.revealOffer).toBeNull();
  });

  it("reset returns defaults including clearing focus and offers", () => {
    let s = uiReducer(initialUiState, {
      type: "layout-update",
      patch: { explorerVisible: false, explorerWidth: 400, splitRatio: 0.8 },
    });
    s = uiReducer(s, { type: "layout-focus", mode: "code" });
    s = uiReducer(s, { type: "reveal-offer", relativePath: "src/A.tsx", source: src });
    s = uiReducer(s, { type: "layout-reset" });
    expect(s.layout.explorerVisible).toBe(true);
    expect(s.layout.explorerWidth).toBe(220);
    expect(s.layout.splitRatio).toBe(0.55);
    expect(s.layout.focusMode).toBe("none");
    expect(s.revealOffer).toBeNull();
  });

  it("clears logs without touching other state", () => {
    let s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "stdout", line: "x" },
    });
    expect(s.logs).toHaveLength(1);
    s = uiReducer(s, { type: "logs-cleared" });
    expect(s.logs).toHaveLength(0);
    expect(s.runtime).toBe(initialUiState.runtime);
  });

  it("does not stack duplicate error notices in recentErrors", () => {
    let s = uiReducer(initialUiState, { type: "notice", message: "boom" });
    s = uiReducer(s, { type: "notice", message: "boom" });
    expect(s.recentErrors).toEqual(["boom"]);
    s = uiReducer(s, { type: "notice", message: "other" });
    expect(s.recentErrors[0]).toBe("other");
  });
});
