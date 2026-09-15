import type { SourceFileRead, SourceLocation } from "@rootray/shared";
import { describe, expect, it } from "vitest";
import { initialUiState, type UiState, uiReducer } from "./reducer";

const SRC: SourceLocation = {
  relativePath: "src/App.tsx",
  line: 12,
  column: 4,
  componentName: "App",
};

function read(over: Partial<SourceFileRead> = {}): SourceFileRead {
  return {
    relativePath: "src/App.tsx",
    content: "const x = 1;\n",
    hash: "a".repeat(64),
    lineEnding: "lf",
    bom: false,
    sizeBytes: 13,
    ...over,
  };
}

function openSession(state: UiState): UiState {
  let s = uiReducer(state, { type: "edit-open", relativePath: SRC.relativePath, source: SRC });
  s = uiReducer(s, { type: "edit-opened", read: read(), source: SRC });
  return s;
}

describe("editor session reducer", () => {
  it("loading → clean on open", () => {
    let s = uiReducer(initialUiState, {
      type: "edit-open",
      relativePath: SRC.relativePath,
      source: SRC,
    });
    expect(s.editor?.status).toBe("loading");
    s = uiReducer(s, { type: "edit-opened", read: read(), source: SRC });
    expect(s.editor?.status).toBe("clean");
    expect(s.editor?.diskContent).toBe("const x = 1;\n");
    expect(s.editor?.selectedLine).toBe(12);
  });

  it("edit → dirty, revert to identical → clean", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "const x = 2;\n" });
    expect(s.editor?.status).toBe("dirty");
    s = uiReducer(s, { type: "edit-changed", content: "const x = 1;\n" });
    expect(s.editor?.status).toBe("clean");
  });

  it("save start → saving → saved → clean with rebased hash", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-save-start" });
    expect(s.editor?.status).toBe("saving");
    s = uiReducer(s, {
      type: "edit-saved",
      write: { relativePath: "src/App.tsx", hash: "b".repeat(64) },
    });
    expect(s.editor?.status).toBe("clean");
    expect(s.editor?.baseHash).toBe("b".repeat(64));
    expect(s.editor?.diskContent).toBe("v2\n");
    expect(s.editor?.canRevert).toBe(true);
  });

  it("generic save error → save_failed, keeps dirty content", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-save-start" });
    s = uiReducer(s, {
      type: "edit-failed",
      error: { code: "SOURCE_WRITE_FAILED", message: "disk full" },
    });
    expect(s.editor?.status).toBe("save_failed");
    expect(s.editor?.currentContent).toBe("v2\n");
  });

  it("conflict error → conflict status, unsaved content preserved", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-save-start" });
    s = uiReducer(s, {
      type: "edit-failed",
      error: { code: "SOURCE_EDIT_CONFLICT", message: "changed" },
    });
    expect(s.editor?.status).toBe("conflict");
    expect(s.editor?.currentContent).toBe("v2\n");
  });

  it("external change on dirty session → conflict", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-external-change", diskHash: "x" });
    expect(s.editor?.status).toBe("conflict");
    expect(s.editor?.currentContent).toBe("v2\n");
  });

  it("external change on clean session → no-op (store auto-reloads)", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-external-change", diskHash: "x" });
    expect(s.editor?.status).toBe("clean");
  });

  it("discard restores disk snapshot → clean", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-discard" });
    expect(s.editor?.status).toBe("clean");
    expect(s.editor?.currentContent).toBe("const x = 1;\n");
  });

  it("disk reload rebases content", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, {
      type: "edit-disk-loaded",
      read: read({ content: "external\n", hash: "c".repeat(64) }),
    });
    expect(s.editor?.status).toBe("clean");
    expect(s.editor?.currentContent).toBe("external\n");
    expect(s.editor?.baseHash).toBe("c".repeat(64));
  });

  it("disk reload during unsaved edits becomes a conflict, not a clobber", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "mine\n" });
    s = uiReducer(s, {
      type: "edit-disk-loaded",
      read: read({ content: "external\n" }),
    });
    expect(s.editor?.status).toBe("conflict");
    expect(s.editor?.currentContent).toBe("mine\n");
    expect(s.conflictDiskContent).toBe("external\n");
  });

  it("re-open on same file preserves dirty text, only refocuses", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, {
      type: "edit-open",
      relativePath: "src/App.tsx",
      source: { ...SRC, line: 40 },
    });
    expect(s.editor?.status).toBe("dirty");
    expect(s.editor?.currentContent).toBe("v2\n");
    expect(s.editor?.selectedLine).toBe(40);
  });

  it("re-open on a different file while dirty parks behind the prompt", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, {
      type: "edit-open",
      relativePath: "src/Other.tsx",
      source: { ...SRC, relativePath: "src/Other.tsx" },
    });
    expect(s.editor?.relativePath).toBe("src/App.tsx");
    expect(s.editorClosePrompt).toBe(true);
    expect(s.pendingOpen?.relativePath).toBe("src/Other.tsx");
  });

  it("close request on clean session closes immediately", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-close-request" });
    expect(s.editor).toBeNull();
  });

  it("close request while dirty opens the unsaved prompt", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-close-request" });
    expect(s.editorClosePrompt).toBe(true);
    expect(s.editor).not.toBeNull();
    s = uiReducer(s, { type: "edit-close-cancel" });
    expect(s.editorClosePrompt).toBe(false);
    s = uiReducer(s, { type: "edit-close-request" });
    s = uiReducer(s, { type: "edit-closed" });
    expect(s.editor).toBeNull();
  });

  it("revert restores pre-save content", () => {
    let s = openSession(initialUiState);
    s = uiReducer(s, { type: "edit-changed", content: "v2\n" });
    s = uiReducer(s, { type: "edit-save-start" });
    s = uiReducer(s, {
      type: "edit-saved",
      write: { relativePath: "src/App.tsx", hash: "b".repeat(64) },
    });
    s = uiReducer(s, {
      type: "edit-reverted",
      read: read({ content: "const x = 1;\n" }),
    });
    expect(s.editor?.currentContent).toBe("const x = 1;\n");
    expect(s.editor?.status).toBe("clean");
  });
});
