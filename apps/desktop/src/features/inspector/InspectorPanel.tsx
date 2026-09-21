import type { DetectedLauncher, InspectorPhase } from "@rootray/shared";
import { errorMessage } from "@rootray/shared";
import { useCallback, useEffect, useState } from "react";
import { CloseIcon } from "../../components/icons";
import {
  clearInspectorSelection,
  detectEditors,
  getSettings,
  openSourceLocation,
  setInspection,
  updateSettings,
} from "../../lib/ipc";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";
import { describeComponent } from "../intelligence/controller";
import { CanvasSection } from "./CanvasSection";
import { ComponentSection } from "./ComponentSection";
import { buildContextBlock } from "./copyContext";
import { StylesSection } from "./StylesSection";

const PHASE_LABEL: Record<InspectorPhase, string> = {
  inactive: "Inactive",
  starting: "Starting bridge",
  waiting_for_browser: "Waiting for Browser",
  connected: "Browser Connected",
  inspecting: "Inspecting",
  disconnected: "Disconnected",
  failed: "Unavailable",
};

export function InspectorPanel({ onSearch }: { onSearch: (query: string) => void }) {
  const { state, dispatch } = useStore();
  const inspector = state.inspector;
  const sel = inspector.lastSelection;
  const [launchers, setLaunchers] = useState<DetectedLauncher[]>([]);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (!sel?.source || !editorId) return;
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
    if (!sel?.source) return;
    try {
      await navigator.clipboard.writeText(
        `${sel.source.relativePath}:${sel.source.line}:${sel.source.column}`,
      );
    } catch {
      dispatch({ type: "notice", message: "Copy failed" });
    }
  };

  const copyContext = async () => {
    if (!sel) return;
    const root = state.runtime.workspace?.root;
    let usedBy = null;
    if (root && sel.source?.componentName) {
      usedBy = await describeComponent(root, sel.source.componentName, sel.source.relativePath)
        .then((s) => s.usedBy)
        .catch(() => null);
    }
    try {
      await navigator.clipboard.writeText(buildContextBlock(sel, null, usedBy));
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
              <CloseIcon />
            </button>
          </div>
          <div className="selection-facts">
            <span className="sel-tag">&lt;{sel.element.tagName}&gt;</span>
            {sel.source?.componentName && (
              <span className="sel-component">{sel.source.componentName}</span>
            )}
            {sel.element.textPreview && (
              <span className="sel-text">“{sel.element.textPreview}”</span>
            )}
          </div>
          {sel.source ? (
            <details className="inspector-disclosure" open>
              <summary>Source</summary>
              <div className="selection-loc">
                <div className="sel-file-stack">
                  <strong className="sel-file-name">
                    {sel.source.relativePath.split("/").pop() ?? sel.source.relativePath}
                  </strong>
                  <span className="sel-file" title={sel.source.relativePath}>
                    {sel.source.relativePath}
                  </span>
                </div>
                <div className="sel-loc-meta">
                  <span className={`badge-confidence badge-${sel.source.confidence ?? "exact"}`}>
                    {sel.source.confidence === "exact"
                      ? "EXACT SOURCE"
                      : sel.source.confidence === "approximate"
                        ? "APPROXIMATE"
                        : sel.source.confidence === "component"
                          ? "COMPONENT"
                          : "SOURCE"}
                  </span>
                  <span className="sel-pos">
                    {sel.source.line}:{sel.source.column}
                  </span>
                </div>
              </div>
            </details>
          ) : (
            <div className="selection-loc">
              <div className="sel-loc-row">
                <span className="badge-confidence badge-unresolved">UNRESOLVED</span>
              </div>
              <span className="muted sel-unmapped">
                No authored source — this element was created at runtime
              </span>
            </div>
          )}

          {sel.element.tagName === "canvas" && <CanvasSection hasSource={Boolean(sel.source)} />}

          {sel.source && (
            <details className="inspector-disclosure" open>
              <summary>Component</summary>
              <ComponentSection source={sel.source} />
            </details>
          )}
          {sel.styles && (
            <details className="inspector-disclosure" open>
              <summary>Styles &amp; Box Model</summary>
              <StylesSection styles={sel.styles} onSearch={onSearch} />
            </details>
          )}

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
              disabled={!sel.source}
              onClick={() =>
                sel.source && quickEdit(state, dispatch, sel.source.relativePath, sel.source)
              }
              title={
                sel.source
                  ? "Open this source inside RootRay"
                  : "No authored source — this element was created at runtime"
              }
            >
              Quick Edit
            </button>
            <button
              type="button"
              className="btn"
              disabled={!editorId || !sel.source}
              onClick={openSource}
            >
              Open Source
            </button>
            <button type="button" className="btn" disabled={!sel.source} onClick={copyPath}>
              Copy Path
            </button>
            <button
              type="button"
              className="btn"
              onClick={copyContext}
              title="Copy a bounded context block for this element"
            >
              Copy Context
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
