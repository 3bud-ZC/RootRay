import { activeTarget, type Capability, errorMessage } from "@rootray/shared";
import { useEffect, useRef, useState } from "react";
import { Splitter } from "../../components/Splitter";
import { projectDisplayName } from "../../lib/format";
import {
  analyzeProject,
  getSettings,
  openInEditor,
  pickProjectDirectory,
  setActiveTarget,
  setInspection,
  startDevServer,
} from "../../lib/ipc";
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Pane widths in px — the center takes whatever space remains.
  const [leftW, setLeftW] = useState(220);
  const [rightW, setRightW] = useState(340);
  // Widths snapshotted at drag start — deltas apply to a stable base.
  const leftBase = useRef(220);
  const rightBase = useRef(340);

  const dragStart = (side: "left" | "right") => (d: boolean) => {
    if (d) {
      if (side === "left") leftBase.current = leftW;
      else rightBase.current = rightW;
    }
    setDragging(d);
  };

  // Inspect click → source opens beside the preview automatically.
  useSelectionAutoReveal();

  const modalOpen = quickOpen || search.open || state.settingsOpen || state.editorClosePrompt;

  // Global workspace shortcuts — active only while a workspace is loaded.
  // Ctrl+P: quick open · Ctrl+Shift+F: workspace search · Ctrl+Shift+C:
  // inspect toggle · Esc: back to Interact (when no modal owns it).
  // CodeMirror's own Ctrl+S / Ctrl+F keep working inside the editor.
  const inspectorEnabled = state.inspector.inspectionEnabled;
  const inspectorConnected =
    state.inspector.phase === "connected" || state.inspector.phase === "inspecting";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The in-page runtime handles Escape inside the preview; this
        // covers Escape pressed while the RootRay UI has focus. Modals
        // keep their own Escape.
        if (inspectorEnabled && !modalOpen) {
          e.preventDefault();
          setInspection(false).catch(() => {});
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyC" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (inspectorConnected) {
          setInspection(!inspectorEnabled).catch(() => {});
        }
      } else if (e.key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearch({ open: false, query: "" });
        setQuickOpen((v) => !v);
      } else if (e.key === "F" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setQuickOpen(false);
        setSearch((s) => ({ open: !s.open, query: s.query }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectorEnabled, inspectorConnected, modalOpen]);

  if (!workspace) return null;
  const target = activeTarget(workspace);
  const caps = target?.capabilities ?? workspace.capabilities;

  const runningPhases = ["running", "starting", "stopping"] as const;
  const isLive = runningPhases.includes(runtime.phase as (typeof runningPhases)[number]);

  const run = async () => {
    dispatch({ type: "notice", message: null });
    try {
      await startDevServer(true);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  const changeProject = async () => {
    const dir = await pickProjectDirectory();
    if (!dir) return;
    try {
      await analyzeProject(dir);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
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
            <button
              type="button"
              className="btn"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              Details
            </button>
            <button type="button" className="btn" onClick={changeProject}>
              Change…
            </button>
          </div>
        </div>

        {detailsOpen && <section className="project-card wb-details">{projectDetails}</section>}

        <RunnerPanel />

        <div className="wb-body">
          <aside className="wb-left" style={{ width: leftW }}>
            <ExplorerPanel onSearch={(query) => setSearch({ open: true, query })} />
          </aside>
          <Splitter
            label="Explorer width"
            valueNow={leftW}
            valueMin={140}
            valueMax={480}
            onDelta={(dx) => setLeftW(clamp(leftBase.current + dx, 140, 480))}
            onDragState={dragStart("left")}
            onNudge={(d) => setLeftW((w) => clamp(w + d, 140, 480))}
          />
          <div className="wb-center">
            <PreviewPanel
              covered={covered}
              tab={state.workspaceTab}
              onTab={(tab) => dispatch({ type: "workspace-tab", tab })}
            >
              {state.workspaceTab !== "preview" && (
                <div className="wb-code">
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
          <Splitter
            label="Inspector width"
            valueNow={rightW}
            valueMin={240}
            valueMax={560}
            onDelta={(dx) => setRightW(clamp(rightBase.current - dx, 240, 560))}
            onDragState={dragStart("right")}
            onNudge={(d) => setRightW((w) => clamp(w + d, 240, 560))}
          />
          <aside className="wb-right" style={{ width: rightW }}>
            <InspectorPanel onSearch={(query) => setSearch({ open: true, query })} />
          </aside>
        </div>

        {(state.logs.length > 0 || isLive) && <LogPanel logs={state.logs} />}

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

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
