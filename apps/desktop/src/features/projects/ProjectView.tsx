import { activeTarget, type Capability, errorMessage } from "@rootray/shared";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Splitter } from "../../components/Splitter";
import { projectDisplayName } from "../../lib/format";
import {
  changeProject as changeProjectIpc,
  getSettings,
  openInEditor,
  pickProjectDirectory,
  setActiveTarget,
  setInspection,
  startDevServer,
} from "../../lib/ipc";
import {
  EXPLORER_MAX,
  EXPLORER_MIN,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  LAYOUT_DEFAULTS,
} from "../../state/layout";
import { useStore } from "../../state/store";
import { EditorPanel } from "../editor/EditorPanel";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { InspectorPanel } from "../inspector/InspectorPanel";
import { useSelectionAutoReveal } from "../inspector/useAutoReveal";
import { QuickOpen } from "../nav/QuickOpen";
import { SearchPanel } from "../nav/SearchPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { LogPanel } from "../runner/LogPanel";
import { RunnerPanel } from "../runner/RunnerPanel";

const FRAMEWORK_LABELS: Record<string, string> = {
  "next-js": "Next.js",
  "vite-react": "React + Vite",
  vite: "Vite",
  "vue-vite": "Vue + Vite",
  "svelte-vite": "Svelte + Vite",
  sveltekit: "SvelteKit",
  astro: "Astro",
  nuxt: "Nuxt",
  angular: "Angular",
  remotion: "Remotion",
  "static-web": "Static Web",
  "node-web": "Node.js",
  unknown: "unknown",
};

const KIND_LABELS: Record<string, string> = {
  "single-package": "single package",
  "npm-workspace": "npm workspace",
  "pnpm-workspace": "pnpm workspace",
  "yarn-workspace": "yarn workspace",
  "unknown-multi-package": "multi-package",
  "no-manifest": "no manifest",
};

const runningPhases = ["running", "starting", "stopping"] as const;
type LivePhase = (typeof runningPhases)[number];

function frameworkLabel(fw: string, version: string | null): string {
  const base = FRAMEWORK_LABELS[fw] ?? fw;
  return version ? `${base} ${version}` : base;
}

/** One capability row: state icon + optional factual reason. */
function CapRow({ label, cap }: { label: string; cap: Capability }) {
  const icon =
    cap.state === "available" ? (
      <span className="ok">✓</span>
    ) : cap.state === "partial" ? (
      <span className="warn">◐</span>
    ) : (
      <span className="muted">○</span>
    );
  return (
    <li className="cap-row" title={cap.reason ?? undefined}>
      {icon} <span>{label}</span>
      {cap.reason && <span className="cap-reason muted">— {cap.reason}</span>}
    </li>
  );
}

export function ProjectView() {
  const { state, dispatch } = useStore();
  const { runtime } = state;
  const workspace = runtime.workspace;
  const layout = state.layout;
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [changing, setChanging] = useState(false);
  // Widths snapshotted at drag start — deltas apply to a stable base.
  const leftBase = useRef(220);
  const rightBase = useRef(320);
  const explorerBtnRef = useRef<HTMLButtonElement>(null);
  const inspectorBtnRef = useRef<HTMLButtonElement>(null);
  const outputBtnRef = useRef<HTMLButtonElement>(null);
  const leftPaneRef = useRef<HTMLElement>(null);
  const rightPaneRef = useRef<HTMLElement>(null);

  const focused = layout.focusMode !== "none";
  const explorerVis = layout.explorerVisible && !layout.autoExplorer && !focused;
  const inspectorVis = layout.inspectorVisible && !layout.autoInspector && !focused;

  const setExplorer = (w: number) =>
    dispatch({ type: "layout-update", patch: { explorerWidth: w } });
  const setInspector = (w: number) =>
    dispatch({ type: "layout-update", patch: { inspectorWidth: w } });

  const dragStart = (side: "left" | "right") => (d: boolean) => {
    if (d) {
      if (side === "left") leftBase.current = layout.explorerWidth;
      else rightBase.current = layout.inspectorWidth;
    }
    setDragging(d);
  };

  // After a pane hides, keyboard focus must not stay trapped inside a
  // display:none subtree — hand it to the pane's toolbar toggle. A collapsed
  // pane unmounts its content (focus → body); a display:none pane keeps it.
  const focusFallback = (
    pane: RefObject<HTMLElement | null> | null,
    btn: RefObject<HTMLButtonElement | null>,
  ) => {
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el === document.body || (pane?.current && el && pane.current.contains(el)))
        btn.current?.focus();
    });
  };

  const toggleExplorer = () => {
    if (explorerVis) focusFallback(leftPaneRef, explorerBtnRef);
    dispatch({
      type: "layout-update",
      patch: { explorerVisible: !layout.explorerVisible },
    });
  };
  const toggleInspector = () => {
    if (inspectorVis) focusFallback(rightPaneRef, inspectorBtnRef);
    dispatch({
      type: "layout-update",
      patch: { inspectorVisible: !layout.inspectorVisible },
    });
  };
  const toggleOutput = () => {
    if (layout.outputVisible) focusFallback(null, outputBtnRef);
    dispatch({
      type: "layout-update",
      patch: { outputVisible: !layout.outputVisible },
    });
  };

  // Inspect click → source opens beside the preview automatically.
  useSelectionAutoReveal();

  const modalOpen = quickOpen || search.open || state.settingsOpen || state.editorClosePrompt;

  // Global workspace shortcuts — active only while a workspace is loaded.
  // Ctrl+P: quick open · Ctrl+Shift+F: workspace search · Ctrl+Shift+C:
  // inspect toggle · Ctrl+B: explorer · Ctrl+J: output · Ctrl+Shift+P:
  // preview focus · Esc: inspect → focus → nothing. CodeMirror's own
  // Ctrl+S / Ctrl+F keep working inside the editor.
  const inspectorEnabled = state.inspector.inspectionEnabled;
  const inspectorConnected =
    state.inspector.phase === "connected" || state.inspector.phase === "inspecting";
  const focusMode = layout.focusMode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The in-page runtime handles Escape inside the preview; this
        // covers Escape pressed while the RootRay UI has focus. Modals
        // keep their own Escape. Inspect mode wins over focus exit.
        if (inspectorEnabled && !modalOpen) {
          e.preventDefault();
          setInspection(false).catch(() => {});
          return;
        }
        if (focusMode !== "none" && !modalOpen) {
          e.preventDefault();
          dispatch({ type: "layout-focus", mode: "none" });
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyC" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (inspectorConnected) {
          setInspection(!inspectorEnabled).catch(() => {});
        }
      } else if (e.code === "KeyP" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        dispatch({
          type: "layout-focus",
          mode: focusMode === "preview" ? "none" : "preview",
        });
      } else if (e.key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearch({ open: false, query: "" });
        setQuickOpen((v) => !v);
      } else if (e.key === "F" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setQuickOpen(false);
        setSearch((s) => ({ open: !s.open, query: s.query }));
      } else if (e.code === "KeyB" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleExplorer();
      } else if (e.code === "KeyJ" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleOutput();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Narrow windows prefer Preview+Code over squeezing every pane —
  // auto-hides layer over (never overwrite) the stored user preference.
  useEffect(() => {
    const mqExplorer = window.matchMedia("(max-width: 980px)");
    const mqInspector = window.matchMedia("(max-width: 760px)");
    const apply = () =>
      dispatch({
        type: "layout-auto",
        explorer: mqExplorer.matches,
        inspector: mqInspector.matches,
      });
    apply();
    mqExplorer.addEventListener("change", apply);
    mqInspector.addEventListener("change", apply);
    return () => {
      mqExplorer.removeEventListener("change", apply);
      mqInspector.removeEventListener("change", apply);
    };
  }, [dispatch]);

  if (!workspace) return null;
  const target = activeTarget(workspace);
  const caps = target?.capabilities ?? workspace.capabilities;

  const isLive = runningPhases.includes(runtime.phase as LivePhase);

  const run = async () => {
    dispatch({ type: "notice", message: null });
    try {
      await startDevServer(true);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  // A live runtime can never go straight to analyzing — the backend's
  // change_project command stops the server and analyzes as one
  // serialized operation. Checking a render-time phase here would be
  // stale by the time the native dialog closes.
  const changeProject = async () => {
    const dir = await pickProjectDirectory();
    if (!dir) return;
    setChanging(true);
    try {
      await changeProjectIpc(dir);
      // The analyzed workspace replaced the old one — drop the stale
      // editor session and any pending reveal only on success.
      dispatch({ type: "edit-closed" });
      dispatch({ type: "reveal-offer-clear" });
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    } finally {
      setChanging(false);
    }
  };

  const switchTarget = async (id: string) => {
    try {
      await setActiveTarget(id);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  const openInPreferredEditor = async () => {
    try {
      const settings = await getSettings();
      if (!settings.preferredLauncher) {
        dispatch({
          type: "notice",
          message: "No preferred editor set — pick one in Settings.",
        });
        dispatch({ type: "toggle-settings", open: true });
        return;
      }
      await openInEditor(settings.preferredLauncher);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  // Overall support level — honest wording, no dead-end.
  const supportLevel =
    caps.domInspect.state === "available"
      ? { cls: "ok", label: "Full runtime support" }
      : caps.run.state === "available"
        ? { cls: "warn", label: "Partial runtime support" }
        : { cls: "muted", label: "Workspace support" };

  const targetSelect = workspace.targets.length > 1 && (
    <select
      aria-label="Active target"
      className="target-select"
      value={workspace.activeTargetId ?? ""}
      disabled={isLive}
      title={isLive ? "Stop the project to switch targets" : "Choose the run target"}
      onChange={(e) => switchTarget(e.target.value)}
    >
      {workspace.targets.map((t) => (
        <option key={t.id} value={t.id}>
          {t.id} — {frameworkLabel(t.framework, t.frameworkVersion)}
        </option>
      ))}
    </select>
  );

  const projectDetails = (
    <>
      <dl className="facts">
        <div className="fact">
          <dt>Workspace</dt>
          <dd>
            <code>{KIND_LABELS[workspace.workspaceKind] ?? workspace.workspaceKind}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Framework</dt>
          <dd>
            <code>{target ? frameworkLabel(target.framework, target.frameworkVersion) : "—"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Package manager</dt>
          <dd>
            <code>{target?.packageManager ?? workspace.packageManager}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Dev command</dt>
          <dd>
            <code>{target?.selectedRunner?.display ?? "—"}</code>
          </dd>
        </div>
        <div className="fact">
          <dt>Support</dt>
          <dd>
            <span className={supportLevel.cls}>{supportLevel.label}</span>
          </dd>
        </div>
      </dl>

      {target && target.technologies.length > 0 && (
        <div className="tech-list">
          {target.technologies.map((t) => (
            <span key={t.name} className="tech-chip" title={t.evidence.join("\n")}>
              {t.name}
              {t.version ? ` ${t.version}` : ""}
            </span>
          ))}
        </div>
      )}

      <div className="cap-groups">
        <div className="cap-group">
          <h3 className="cap-title">Workspace</h3>
          <ul>
            <CapRow label="Explorer" cap={caps.workspaceBrowse} />
            <CapRow label="Quick Open" cap={caps.quickOpen} />
            <CapRow label="Search" cap={caps.workspaceSearch} />
            <CapRow label="Quick Edit" cap={caps.quickEdit} />
          </ul>
        </div>
        <div className="cap-group">
          <h3 className="cap-title">Runtime</h3>
          <ul>
            <CapRow label="Run" cap={caps.run} />
            <CapRow label="Browser" cap={caps.browserOpen} />
            <CapRow label="HMR-aware" cap={caps.hmrAware} />
          </ul>
        </div>
        <div className="cap-group">
          <h3 className="cap-title">Inspection</h3>
          <ul>
            <CapRow label="DOM inspect" cap={caps.domInspect} />
            <CapRow label="Style inspect" cap={caps.styleInspect} />
            <CapRow label="Source mapping" cap={caps.sourceMapping} />
            <CapRow label="Components" cap={caps.componentIntelligence} />
          </ul>
        </div>
      </div>
    </>
  );

  // ---- workbench mode: the project is (or is becoming) live -----------
  if (isLive) {
    const covered = modalOpen || dragging;
    const outputMounted = state.logs.length > 0 || isLive;
    // PreviewPanel derives the same effective tab — the parent needs it
    // to decide whether the code pane is even rendered.
    const effTab =
      layout.focusMode === "preview"
        ? "preview"
        : layout.focusMode === "code"
          ? "code"
          : state.workspaceTab;
    return (
      <div className="project workbench">
        <div className="wb-head">
          <div className="wb-id">
            <h1 className="project-name" title={workspace.root}>
              {projectDisplayName(workspace.name, workspace.root)}
            </h1>
            {targetSelect}
          </div>
          <div className="wb-head-actions">
            <fieldset className="wb-toggles" aria-label="Workbench panes">
              <button
                type="button"
                ref={explorerBtnRef}
                className={`icon-btn${explorerVis ? " on" : ""}`}
                aria-label="Toggle explorer (Ctrl+B)"
                aria-pressed={layout.explorerVisible}
                title="Explorer (Ctrl+B)"
                onClick={toggleExplorer}
              >
                ◧
              </button>
              <button
                type="button"
                ref={inspectorBtnRef}
                className={`icon-btn${inspectorVis ? " on" : ""}`}
                aria-label="Toggle inspector"
                aria-pressed={layout.inspectorVisible}
                title="Inspector"
                onClick={toggleInspector}
              >
                ◨
              </button>
              <button
                type="button"
                ref={outputBtnRef}
                className={`icon-btn${layout.outputVisible ? " on" : ""}`}
                aria-label="Toggle output (Ctrl+J)"
                aria-pressed={layout.outputVisible}
                title="Output (Ctrl+J)"
                onClick={toggleOutput}
              >
                ▤
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Reset layout"
                title="Reset layout"
                onClick={() => dispatch({ type: "layout-reset" })}
              >
                ⟲
              </button>
            </fieldset>
            <button
              type="button"
              className="btn"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              Details
            </button>
            <button
              type="button"
              className="btn"
              disabled={changing}
              title={
                isLive
                  ? "Stop the running project and analyze a new directory"
                  : "Analyze a different project directory"
              }
              onClick={changeProject}
            >
              {changing && isLive ? "Stopping…" : "Change…"}
            </button>
          </div>
        </div>

        {detailsOpen && <section className="project-card wb-details">{projectDetails}</section>}

        <RunnerPanel />

        <div className="wb-body">
          {/* Hidden panes stay mounted — Explorer's expanded dirs and
              scroll position are component state, so display:none beats
              unmounting for preserving them. */}
          <aside
            ref={leftPaneRef}
            className={`wb-left${explorerVis ? "" : " wb-hidden"}`}
            style={{ width: layout.explorerWidth }}
          >
            <ExplorerPanel onSearch={(query) => setSearch({ open: true, query })} />
          </aside>
          {explorerVis && (
            <Splitter
              label="Explorer width"
              valueNow={layout.explorerWidth}
              valueMin={EXPLORER_MIN}
              valueMax={EXPLORER_MAX}
              onDelta={(dx) =>
                setExplorer(Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, leftBase.current + dx)))
              }
              onDragState={dragStart("left")}
              onNudge={(d) =>
                setExplorer(
                  Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, layout.explorerWidth + d)),
                )
              }
              onReset={() => setExplorer(LAYOUT_DEFAULTS.explorerWidth)}
            />
          )}
          <div className="wb-center">
            <PreviewPanel
              covered={covered}
              onCover={setDragging}
              tab={state.workspaceTab}
              onTab={(tab) => dispatch({ type: "workspace-tab", tab })}
            >
              {effTab !== "preview" && (
                <div
                  className="wb-code"
                  style={effTab === "split" ? { flex: 1 - layout.splitRatio } : undefined}
                >
                  <div className="wb-code-head">
                    <span className="wb-code-path" title={state.editor?.relativePath ?? undefined}>
                      {state.editor?.relativePath ?? "No file open"}
                    </span>
                    {layout.focusMode !== "code" && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Code Focus"
                        title="Code Focus — give the editor the workbench"
                        onClick={() => dispatch({ type: "layout-focus", mode: "code" })}
                      >
                        ⤢
                      </button>
                    )}
                  </div>
                  {state.editor ? (
                    <EditorPanel />
                  ) : (
                    <div className="wb-code-empty muted">
                      No source open — inspect an element or pick a file in the Explorer.
                    </div>
                  )}
                </div>
              )}
            </PreviewPanel>
          </div>
          {inspectorVis && (
            <Splitter
              label="Inspector width"
              valueNow={layout.inspectorWidth}
              valueMin={INSPECTOR_MIN}
              valueMax={INSPECTOR_MAX}
              onDelta={(dx) =>
                setInspector(
                  Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, rightBase.current - dx)),
                )
              }
              onDragState={dragStart("right")}
              onNudge={(d) =>
                setInspector(
                  Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, layout.inspectorWidth + d)),
                )
              }
              onReset={() => setInspector(LAYOUT_DEFAULTS.inspectorWidth)}
            />
          )}
          <aside
            ref={rightPaneRef}
            className={`wb-right${inspectorVis ? "" : " wb-hidden"}`}
            style={{ width: layout.inspectorWidth }}
          >
            <InspectorPanel onSearch={(query) => setSearch({ open: true, query })} />
          </aside>
        </div>

        {outputMounted && !focused && <LogPanel logs={state.logs} onCover={setDragging} />}

        {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} />}
        {search.open && (
          <SearchPanel
            initialQuery={search.query}
            onClose={() => setSearch((s) => ({ ...s, open: false }))}
          />
        )}
      </div>
    );
  }

  // ---- analysis mode: no running project ------------------------------
  return (
    <div className="project">
      <section className="project-card">
        <div className="project-head">
          <div>
            <h1 className="project-name">{projectDisplayName(workspace.name, workspace.root)}</h1>
            <div className="project-path" title={workspace.root}>
              {workspace.root}
            </div>
          </div>
          <div className="project-head-actions">
            {targetSelect}
            <button type="button" className="btn" onClick={changeProject}>
              Change…
            </button>
          </div>
        </div>

        {projectDetails}

        {workspace.warnings.length > 0 && (
          <div className="reasons">
            <h2 className="section-title warn">Discovery warnings</h2>
            <ul>
              {workspace.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {runtime.error && (
          <div className="reasons">
            <h2 className="section-title bad">{runtime.error.code}</h2>
            <p className="muted">{runtime.error.message}</p>
          </div>
        )}

        <div className="project-actions">
          {caps.run.state === "available" && (
            <button type="button" className="btn btn-primary" onClick={run}>
              Run Project
            </button>
          )}
          <button type="button" className="btn" onClick={openInPreferredEditor}>
            Open in Editor
          </button>
        </div>
      </section>

      {(runtime.phase === "stopped" || runtime.phase === "failed") && <RunnerPanel />}

      <div className="workspace">
        <ExplorerPanel onSearch={(query) => setSearch({ open: true, query })} />
        <div className="workspace-main">
          <EditorPanel />
          {(state.logs.length > 0 || runtime.phase === "stopped") && <LogPanel logs={state.logs} />}
        </div>
      </div>

      {quickOpen && <QuickOpen onClose={() => setQuickOpen(false)} />}
      {search.open && (
        <SearchPanel
          initialQuery={search.query}
          onClose={() => setSearch((s) => ({ ...s, open: false }))}
        />
      )}
    </div>
  );
}
