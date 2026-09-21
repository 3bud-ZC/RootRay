/**
 * Quick Edit panel — the lightweight in-app editor for the inspected
 * element's source. Single session, no tabs, no project tree: inspect →
 * tweak → save → HMR. Heavy work still goes through "Open External".
 */

import { errorMessage } from "@rootray/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { CloseIcon } from "../../components/icons";
import { getSettings, openSourceLocation } from "../../lib/ipc";
import { useStore } from "../../state/store";
import {
  closeCompare,
  compareWithDisk,
  confirmCloseEditor,
  discardEditor,
  focusEditorOnSelection,
  reloadFromDisk,
  requestCloseEditor,
  revertLastSave,
  saveEditor,
} from "./controller";
import { collapseContext, diffLines } from "./diff";

// CodeMirror stays out of the initial bundle — it's fetched on first use.
const LazyCodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

const STATUS_LABEL: Record<string, string> = {
  loading: "Loading…",
  clean: "Saved",
  dirty: "Modified",
  saving: "Saving…",
  conflict: "Conflict",
  save_failed: "Save failed",
};

export function EditorPanel() {
  const { state, dispatch } = useStore();
  const ed = state.editor;
  const [showChanges, setShowChanges] = useState(false);
  const [preferredLauncher, setPreferredLauncher] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setPreferredLauncher(s.preferredLauncher))
      .catch(() => {});
  }, []);

  // A fresh inspector selection that lands inside the open file just
  // moves the focus marker — edits are never touched.
  const lastSel = state.inspector.lastSelection;
  useEffect(() => {
    const src = lastSel?.source;
    if (ed && src && src.relativePath === ed.relativePath) {
      if (src.line !== ed.selectedLine) {
        focusEditorOnSelection(dispatch, src);
      }
    }
  }, [lastSel, ed, dispatch]);

  if (!ed) return null;

  const dirty = ed.status === "dirty" || ed.status === "save_failed";
  const inConflict = ed.status === "conflict";

  const openExternal = async () => {
    if (!preferredLauncher) {
      dispatch({
        type: "notice",
        message: "No preferred editor set — pick one in Settings.",
      });
      dispatch({ type: "toggle-settings", open: true });
      return;
    }
    try {
      await openSourceLocation(
        preferredLauncher,
        ed.relativePath,
        ed.selectedLine ?? 1,
        ed.selectedColumn ?? 1,
      );
      if (dirty) {
        dispatch({
          type: "notice",
          message: "You have unsaved RootRay edits — external changes may cause a conflict.",
        });
      }
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  const fileName = ed.relativePath.split("/").pop() ?? ed.relativePath;

  return (
    <section className="qeditor" aria-label="Quick Edit">
      <div className="qe-head">
        <h3 className="section-title">Quick Edit</h3>
        <span className="qe-file" title={ed.relativePath}>
          {fileName}
          {dirty && (
            <span className="qe-dot" title="unsaved changes" aria-hidden>
              ●
            </span>
          )}
        </span>
        <span className="qe-path muted">{ed.relativePath}</span>
        <span className={`qe-status qe-status-${ed.status}`}>{STATUS_LABEL[ed.status]}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close editor"
          onClick={() => requestCloseEditor(dispatch)}
        >
          <CloseIcon />
        </button>
      </div>

      {inConflict && (
        <div className="qe-conflict" role="alert">
          <span className="qe-conflict-text">
            File changed outside RootRay — your unsaved edits are safe.
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => reloadFromDisk(state, dispatch)}
          >
            Reload Disk Version
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              state.conflictDiskContent === null
                ? compareWithDisk(state, dispatch)
                : closeCompare(dispatch)
            }
          >
            {state.conflictDiskContent === null ? "Compare" : "Hide Compare"}
          </button>
        </div>
      )}

      {ed.error && ed.status === "save_failed" && (
        <div className="qe-error" role="alert">
          Save failed ({ed.error.code}): {ed.error.message}
        </div>
      )}

      <div className="qe-body">
        {showChanges ? (
          <DiffView oldText={ed.diskContent} newText={ed.currentContent} />
        ) : state.conflictDiskContent !== null && inConflict ? (
          <DiffView oldText={ed.currentContent} newText={state.conflictDiskContent} mineFirst />
        ) : ed.status === "loading" ? (
          <div className="qe-loading muted">Loading source…</div>
        ) : (
          <Suspense fallback={<div className="qe-loading muted">Loading source…</div>}>
            <LazyCodeEditor
              key={ed.relativePath}
              value={ed.currentContent}
              relativePath={ed.relativePath}
              focusLine={ed.selectedLine}
              focusColumn={ed.selectedColumn}
              onChange={(content) => dispatch({ type: "edit-changed", content })}
              onSave={() => saveEditor(state, dispatch)}
            />
          </Suspense>
        )}
      </div>

      <div className="qe-foot">
        <button
          type="button"
          className="btn"
          disabled={!dirty}
          onClick={() => discardEditor(dispatch)}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn"
          disabled={ed.status === "loading"}
          onClick={() => setShowChanges((v) => !v)}
        >
          {showChanges ? "Editor" : "Changes"}
        </button>
        {ed.canRevert && (
          <button
            type="button"
            className="btn"
            onClick={() => revertLastSave(state, dispatch)}
            title="Restore the file to before RootRay's last save (fails if it changed since)"
          >
            Revert Last Save
          </button>
        )}
        <div className="qe-foot-right">
          <button
            type="button"
            className="btn"
            onClick={openExternal}
            title={dirty ? "External edits may conflict with unsaved changes" : undefined}
          >
            Open External
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty}
            onClick={() => saveEditor(state, dispatch)}
            title="Ctrl+S"
          >
            Save
          </button>
        </div>
      </div>

      {state.editorClosePrompt && (
        <div className="qe-modal-backdrop">
          <div className="qe-modal" role="dialog" aria-modal="true" aria-label="Unsaved changes">
            <p>
              You have unsaved changes in <strong>{fileName}</strong>.
            </p>
            <div className="qe-modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => dispatch({ type: "edit-close-cancel" })}
              >
                Keep Editing
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => confirmCloseEditor(state, dispatch)}
              >
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DiffView({
  oldText,
  newText,
  mineFirst = false,
}: {
  oldText: string;
  newText: string;
  mineFirst?: boolean;
}) {
  const result = diffLines(oldText, newText);
  const lines = collapseContext(result);
  return (
    <section className="qe-diff" aria-label="Changes">
      <div className="qe-diff-legend muted">
        {mineFirst ? (
          <span>
            <span className="qe-diff-key removed">− your unsaved edits</span>{" "}
            <span className="qe-diff-key added">+ disk version</span>
          </span>
        ) : (
          <span>
            {result.added} added · {result.removed} removed
          </span>
        )}
      </div>
      {lines.length === 0 || (result.added === 0 && result.removed === 0) ? (
        <p className="muted">No differences.</p>
      ) : (
        <pre className="qe-diff-body">
          {lines.map((l) => (
            <div
              key={`${l.kind}:${l.oldN ?? ""}:${l.newN ?? ""}:${l.text.length === 0 ? "e" : l.text}`}
              className={`qe-diff-line ${l.kind}`}
            >
              <span className="qe-diff-sign">
                {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " "}
              </span>
              <span className="qe-diff-n">{l.newN ?? l.oldN ?? ""}</span>
              <span className="qe-diff-t">{l.text}</span>
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}
