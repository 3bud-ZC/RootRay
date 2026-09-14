import type { DetectedLauncher, InspectorPhase, SourcePreview } from "@rootray/shared";
import { errorMessage } from "@rootray/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearInspectorSelection,
  detectEditors,
  getSettings,
  openSourceLocation,
  readSourcePreview,
  setInspection,
  updateSettings,
} from "../../lib/ipc";
import { useStore } from "../../state/store";

const PHASE_LABEL: Record<InspectorPhase, string> = {
  inactive: "Inactive",
  starting: "Starting bridge",
  waiting_for_browser: "Waiting for Browser",
  connected: "Browser Connected",
  inspecting: "Inspecting",
  disconnected: "Disconnected",
  failed: "Unavailable",
};

export function InspectorPanel() {
  const { state, dispatch } = useStore();
  const inspector = state.inspector;
  const sel = inspector.lastSelection;
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [launchers, setLaunchers] = useState<DetectedLauncher[]>([]);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  const connected = inspector.phase === "connected" || inspector.phase === "inspecting";

  // Resolve the preferred (or first available) editor once.
  useEffect(() => {
    Promise.all([detectEditors(), getSettings()])
      .then(([found, settings]) => {
        setLaunchers(found);
        const preferred = found.find((l) => l.id === settings.preferredLauncher && l.available);
        setEditorId(preferred?.id ?? found.find((l) => l.available)?.id ?? null);
      })
      .catch(() => {});
  }, []);

  // Fetch the read-only preview whenever the selection changes.
  useEffect(() => {
    const id = ++reqId.current;
    if (!sel) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    readSourcePreview(sel.source.relativePath, sel.source.line)
      .then((p) => {
        if (reqId.current === id) {
          setPreview(p);
          setPreviewErr(null);
        }
      })
      .catch((e) => {
        if (reqId.current === id) {
          setPreview(null);
          setPreviewErr(errorMessage(e));
        }
      });
  }, [sel]);

  const toggleInspect = async () => {
    setBusy(true);
    try {
      await setInspection(!inspector.inspectionEnabled);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const openSource = async () => {
    if (!sel || !editorId) return;
    try {
      await openSourceLocation(
        editorId,
        sel.source.relativePath,
        sel.source.line,
        sel.source.column,
      );
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  const copyPath = async () => {
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(
        `${sel.source.relativePath}:${sel.source.line}:${sel.source.column}`,
      );
    } catch {
      dispatch({ type: "notice", message: "Copy failed" });
    }
  };

  const chooseEditor = useCallback(async (id: string) => {
    setEditorId(id);
    try {
      await updateSettings({ preferredLauncher: id });
    } catch {
      /* preference save is best-effort */
    }
  }, []);

  const phaseDot =
    inspector.phase === "inspecting" || inspector.phase === "connected"
      ? "ok"
      : inspector.phase === "failed"
        ? "bad"
        : "warn";

  return (
    <section className="inspector">
      <div className="inspector-head">
        <h3 className="section-title">Inspector</h3>
        <span className={`inspector-status ${phaseDot}`}>
          <span className="pill-dot" aria-hidden />
          {PHASE_LABEL[inspector.phase]}
        </span>
        {inspector.error && (
          <span className="inspector-error" title={inspector.error.message}>
            {inspector.error.code === "INSPECTOR_UNAVAILABLE"
              ? "Inspector unavailable for this dev configuration"
              : inspector.error.message}
          </span>
        )}
        <div className="inspector-actions">
          {inspector.phase === "inspecting" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={toggleInspect}
            >
              Stop Inspecting
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !connected}
              onClick={toggleInspect}
              title={
                connected
                  ? "Hover and click elements in the browser"
                  : "Waiting for the browser to connect"
              }
            >
              Inspect UI
            </button>
          )}
        </div>
      </div>

      {sel ? (
        <div className="selection">
          <div className="selection-head">
            <h4 className="section-title">Selected Element</h4>
            <button
              type="button"
              className="icon-btn"
              aria-label="Clear selection"
              onClick={() => clearInspectorSelection().catch(() => {})}
            >
              ×
            </button>
          </div>
          <div className="selection-facts">
            <span className="sel-tag">&lt;{sel.element.tagName}&gt;</span>
            {sel.source.componentName && (
              <span className="sel-component">{sel.source.componentName}</span>
            )}
            {sel.element.textPreview && (
              <span className="sel-text">“{sel.element.textPreview}”</span>
            )}
          </div>
          <div className="selection-loc">
            <span className="sel-file">{sel.source.relativePath}</span>
            <span className="sel-pos">
              Line {sel.source.line} · Column {sel.source.column}
            </span>
          </div>

          {preview && (
            <pre className="source-preview">
              {preview.lines.map((l) => (
                <div
                  key={l.n}
                  className={`src-line ${l.n === preview.selectedLine ? "selected" : ""}`}
                >
                  <span className="src-n">{l.n}</span>
                  <span className="src-t">{l.text}</span>
                </div>
              ))}
            </pre>
          )}
          {previewErr && <p className="muted">Preview unavailable: {previewErr}</p>}

          <div className="selection-actions">
            {launchers.length > 1 && (
              <select
                className="editor-select"
                value={editorId ?? ""}
                onChange={(e) => chooseEditor(e.target.value)}
                aria-label="Editor"
              >
                {launchers
                  .filter((l) => l.available)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!editorId}
              onClick={openSource}
            >
              Open Source
            </button>
            <button type="button" className="btn" onClick={copyPath}>
              Copy Path
            </button>
          </div>
        </div>
      ) : (
        inspector.phase !== "failed" && (
          <p className="muted inspector-hint">
            {connected
              ? "Enable Inspect UI, then hover and click elements in the browser."
              : "The browser runtime connects automatically once the page loads."}
          </p>
        )
      )}
    </section>
  );
}
