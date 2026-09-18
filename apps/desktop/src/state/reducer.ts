import type {
  CoreErrorPayload,
  EditSession,
  InspectorState,
  LogLine,
  PreviewState,
  ProcessEventPayload,
  RuntimeState,
  SourceFileRead,
  SourceFileWrite,
  SourceLocation,
} from "@rootray/shared";
import { editSessionHasUserContent } from "@rootray/shared";
import { clampLayoutPatch, type FocusMode, LAYOUT_DEFAULTS, type WorkbenchLayout } from "./layout";

export const LOG_CAP = 500;

export interface UiState {
  runtime: RuntimeState;
  inspector: InspectorState;
  /** Quick Edit session — null when no source file is open in-app. */
  editor: EditSession | null;
  /** Disk text fetched during a conflict, for the compare view. */
  conflictDiskContent: string | null;
  /** True while the user asked to see the unsaved-changes close prompt. */
  editorClosePrompt: boolean;
  /** A Quick Edit request deferred behind the unsaved-changes prompt. */
  pendingOpen: { relativePath: string; source: SourceLocation } | null;
  /** Live-appended log tail (mirrors backend recentLogs, streams realtime). */
  logs: LogLine[];
  /** Embedded project-preview snapshot — driven by `rootray://preview-state`. */
  preview: PreviewState;
  /** Settings-backed preference: open the internal preview on URL detect. */
  autoPreview: boolean;
  /** Center workbench mode: preview only, code only, or side-by-side. */
  workspaceTab: "preview" | "code" | "split";
  /** Workbench pane layout — visibility, widths, split ratio, focus. */
  layout: WorkbenchLayout;
  /**
   * A source reveal deferred while Preview Focus is active — the user
   * picks "Show Source" to leave focus and open the file.
   */
  revealOffer: { relativePath: string; source: SourceLocation } | null;
  settingsOpen: boolean;
  /** Transient user-facing error from the last failed action. */
  notice: string | null;
  /** Last few error strings, newest first — powers Copy Diagnostics. */
  recentErrors: string[];
}

export const emptyRuntime: RuntimeState = {
  seq: 0,
  phase: "idle",
  workspace: null,
  pid: null,
  command: null,
  url: null,
  port: null,
  startedAt: null,
  error: null,
  recentLogs: [],
};

export const emptyInspector: InspectorState = {
  phase: "inactive",
  sessionId: null,
  port: null,
  pageUrl: null,
  connectedAt: null,
  inspectionEnabled: false,
  lastSelection: null,
  error: null,
};

export const emptyPreview: PreviewState = {
  phase: "hidden",
  url: null,
  error: null,
  generation: 0,
};

export const initialUiState: UiState = {
  runtime: emptyRuntime,
  inspector: emptyInspector,
  editor: null,
  conflictDiskContent: null,
  editorClosePrompt: false,
  pendingOpen: null,
  logs: [],
  preview: emptyPreview,
  autoPreview: true,
  workspaceTab: "preview",
  layout: LAYOUT_DEFAULTS,
  revealOffer: null,
  settingsOpen: false,
  notice: null,
  recentErrors: [],
};

export type UiAction =
  | { type: "runtime"; state: RuntimeState }
  | { type: "inspector"; state: InspectorState }
  | { type: "process-event"; event: ProcessEventPayload }
  | { type: "toggle-settings"; open?: boolean }
  | { type: "notice"; message: string | null; isError?: boolean }
  | { type: "preview-state"; state: PreviewState }
  | { type: "auto-preview"; enabled: boolean }
  | { type: "workspace-tab"; tab: "preview" | "code" | "split" }
  // --- workbench layout ---------------------------------------------------------
  | { type: "layout-update"; patch: Partial<WorkbenchLayout> }
  | { type: "layout-focus"; mode: FocusMode }
  | { type: "layout-auto"; explorer: boolean; inspector: boolean }
  | { type: "layout-restore"; layout: Partial<WorkbenchLayout> }
  | { type: "layout-reset" }
  | { type: "reveal-offer"; relativePath: string; source: SourceLocation }
  | { type: "reveal-offer-clear" }
  | { type: "logs-cleared" }
  // --- quick editor -----------------------------------------------------------
  | { type: "edit-open"; relativePath: string; source: SourceLocation }
  | { type: "edit-opened"; read: SourceFileRead; source: SourceLocation }
  | { type: "edit-changed"; content: string }
  | { type: "edit-save-start" }
  | { type: "edit-saved"; write: SourceFileWrite }
  | { type: "edit-failed"; error: CoreErrorPayload }
  | { type: "edit-external-change"; diskHash: string }
  | { type: "edit-disk-loaded"; read: SourceFileRead }
  | { type: "edit-discard" }
  | { type: "edit-focus"; source: SourceLocation }
  | { type: "edit-reverted"; read: SourceFileRead }
  | { type: "edit-close-request" }
  | { type: "edit-close-cancel" }
  | { type: "edit-closed" }
  | { type: "edit-conflict-compare"; diskContent: string }
  | { type: "edit-conflict-compare-close" };

function sessionFromRead(
  read: SourceFileRead,
  source: SourceLocation | null,
  prev: EditSession | null,
): EditSession {
  return {
    relativePath: read.relativePath,
    diskContent: read.content,
    currentContent: read.content,
    baseHash: read.hash,
    lineEnding: read.lineEnding,
    bom: read.bom,
    status: "clean",
    selectedLine: source?.line ?? null,
    selectedColumn: source?.column ?? null,
    canRevert: prev?.relativePath === read.relativePath ? prev.canRevert : false,
    error: null,
  };
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "runtime": {
      // Stale-snapshot guard — events emitted on concurrent paths (IPC
      // thread vs. process watcher) can arrive out of order; seq only
      // ever increases, so an older snapshot must never win.
      if (action.state.seq < state.runtime.seq) return state;
      // A new run resets the live log tail — backend clears its buffer too.
      const logs = action.state.phase === "starting" ? [] : state.logs;
      return { ...state, runtime: action.state, logs };
    }
    case "inspector":
      return { ...state, inspector: action.state };
    case "process-event": {
      const e = action.event;
      if (e.kind === "stdout" || e.kind === "stderr") {
        const line: LogLine = { stream: e.kind, line: e.line, at: Date.now() };
        const logs =
          state.logs.length >= LOG_CAP ? [...state.logs.slice(1), line] : [...state.logs, line];
        return { ...state, logs };
      }
      return state;
    }
    case "toggle-settings":
      return { ...state, settingsOpen: action.open ?? !state.settingsOpen };
    case "preview-state": {
      // Stale snapshot guard — out-of-order native events never regress
      // the phase or resurrect a dead URL.
      if (action.state.generation < state.preview.generation) return state;
      return { ...state, preview: action.state };
    }
    case "auto-preview":
      return { ...state, autoPreview: action.enabled };
    case "workspace-tab":
      return { ...state, workspaceTab: action.tab };

    // --- workbench layout -----------------------------------------------------

    case "layout-update":
      return { ...state, layout: { ...state.layout, ...clampLayoutPatch(action.patch) } };
    case "layout-focus": {
      // Leaving Preview Focus drops any deferred reveal offer.
      const revealOffer = action.mode === "preview" ? state.revealOffer : null;
      return { ...state, layout: { ...state.layout, focusMode: action.mode }, revealOffer };
    }
    case "layout-auto":
      return {
        ...state,
        layout: {
          ...state.layout,
          autoExplorer: action.explorer,
          autoInspector: action.inspector,
        },
      };
    case "layout-restore":
      return {
        ...state,
        layout: { ...state.layout, ...clampLayoutPatch(action.layout) },
      };
    case "layout-reset":
      return { ...state, layout: { ...LAYOUT_DEFAULTS }, revealOffer: null };
    case "reveal-offer":
      return {
        ...state,
        revealOffer: { relativePath: action.relativePath, source: action.source },
      };
    case "reveal-offer-clear":
      return { ...state, revealOffer: null };
    case "logs-cleared":
      return { ...state, logs: [] };
    case "notice": {
      const msg = action.message?.slice(0, 160) ?? null;
      const recentErrors =
        msg && action.isError !== false && state.recentErrors[0] !== msg
          ? [msg, ...state.recentErrors].slice(0, 5)
          : state.recentErrors;
      return { ...state, notice: action.message, recentErrors };
    }

    // --- quick editor ---------------------------------------------------------

    case "edit-open": {
      const existing = state.editor;
      // Same file already open → keep the session (and any dirty edits),
      // just move the focus marker.
      if (existing && existing.relativePath === action.relativePath) {
        return {
          ...state,
          editor: {
            ...existing,
            selectedLine: action.source.line,
            selectedColumn: action.source.column,
          },
        };
      }
      // Dirty file + different target → hold the request behind the
      // unsaved-changes prompt instead of silently replacing. Only a
      // session with user content counts — a still-loading file has
      // nothing to lose, so the newest selection replaces it directly
      // and the stale read is discarded by "edit-opened" below.
      if (existing && editSessionHasUserContent(existing.status)) {
        return {
          ...state,
          editorClosePrompt: true,
          pendingOpen: { relativePath: action.relativePath, source: action.source },
        };
      }
      return {
        ...state,
        conflictDiskContent: null,
        editor: {
          relativePath: action.relativePath,
          diskContent: "",
          currentContent: "",
          baseHash: "",
          lineEnding: "lf",
          bom: false,
          status: "loading",
          selectedLine: action.source.line,
          selectedColumn: action.source.column,
          canRevert: false,
          error: null,
        },
      };
    }
    case "edit-opened": {
      if (state.editor?.relativePath !== action.read.relativePath) {
        return state;
      }
      return {
        ...state,
        editor: sessionFromRead(action.read, action.source, state.editor),
      };
    }
    case "edit-changed": {
      const ed = state.editor;
      if (!ed || ed.status === "saving" || ed.status === "loading") return state;
      const status = action.content === ed.diskContent ? "clean" : "dirty";
      return {
        ...state,
        editor: { ...ed, currentContent: action.content, status },
      };
    }
    case "edit-save-start": {
      const ed = state.editor;
      if (!ed || (ed.status !== "dirty" && ed.status !== "save_failed")) return state;
      return { ...state, editor: { ...ed, status: "saving", error: null } };
    }
    case "edit-saved": {
      const ed = state.editor;
      if (!ed || ed.relativePath !== action.write.relativePath) return state;
      return {
        ...state,
        editor: {
          ...ed,
          diskContent: ed.currentContent,
          baseHash: action.write.hash,
          status: "clean",
          canRevert: true,
          error: null,
        },
      };
    }
    case "edit-failed": {
      const ed = state.editor;
      if (!ed) return state;
      if (action.error.code === "SOURCE_EDIT_CONFLICT") {
        return {
          ...state,
          conflictDiskContent: null,
          editor: { ...ed, status: "conflict", error: action.error },
        };
      }
      return {
        ...state,
        editor: { ...ed, status: "save_failed", error: action.error },
      };
    }
    case "edit-external-change": {
      const ed = state.editor;
      if (!ed) return state;
      // Clean sessions auto-reload — the store issues `edit-disk-loaded`.
      if (ed.status === "clean" || ed.status === "loading") return state;
      return {
        ...state,
        conflictDiskContent: null,
        editor: { ...ed, status: "conflict" },
      };
    }
    case "edit-disk-loaded": {
      const ed = state.editor;
      if (!ed || ed.relativePath !== action.read.relativePath) return state;
      // The user typed while a clean auto-reload was in flight — don't
      // clobber the edit; surface the divergence as a conflict instead.
      if (ed.status !== "clean" && ed.status !== "loading") {
        return {
          ...state,
          conflictDiskContent: action.read.content,
          editor: { ...ed, status: "conflict" },
        };
      }
      return { ...state, editor: sessionFromRead(action.read, null, ed) };
    }
    case "edit-reverted": {
      const ed = state.editor;
      if (!ed || ed.relativePath !== action.read.relativePath) return state;
      return { ...state, editor: sessionFromRead(action.read, null, ed) };
    }
    case "edit-discard": {
      const ed = state.editor;
      if (!ed) return state;
      return {
        ...state,
        editor: {
          ...ed,
          currentContent: ed.diskContent,
          status: "clean",
          error: null,
        },
        conflictDiskContent: null,
      };
    }
    case "edit-focus": {
      const ed = state.editor;
      if (!ed || ed.relativePath !== action.source.relativePath) return state;
      return {
        ...state,
        editor: {
          ...ed,
          selectedLine: action.source.line,
          selectedColumn: action.source.column,
        },
      };
    }
    case "edit-close-request": {
      const ed = state.editor;
      if (!ed) return { ...state, pendingOpen: null };
      if (ed.status === "dirty" || ed.status === "save_failed" || ed.status === "conflict") {
        return { ...state, editorClosePrompt: true };
      }
      return {
        ...state,
        editor: null,
        conflictDiskContent: null,
        editorClosePrompt: false,
        pendingOpen: null,
      };
    }
    case "edit-close-cancel":
      return { ...state, editorClosePrompt: false, pendingOpen: null };
    case "edit-closed":
      return {
        ...state,
        editor: null,
        conflictDiskContent: null,
        editorClosePrompt: false,
        pendingOpen: null,
      };
    case "edit-conflict-compare":
      return { ...state, conflictDiskContent: action.diskContent };
    case "edit-conflict-compare-close":
      return { ...state, conflictDiskContent: null };
  }
}
