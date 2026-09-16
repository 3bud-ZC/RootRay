import { activeTarget, type Capability, errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { projectDisplayName } from "../../lib/format";
import {
  analyzeProject,
  getSettings,
  openInEditor,
  pickProjectDirectory,
  setActiveTarget,
  startDevServer,
} from "../../lib/ipc";
import { useStore } from "../../state/store";
import { EditorPanel } from "../editor/EditorPanel";
import { ExplorerPanel } from "../explorer/ExplorerPanel";
import { InspectorPanel } from "../inspector/InspectorPanel";
import { QuickOpen } from "../nav/QuickOpen";
import { SearchPanel } from "../nav/SearchPanel";
import { LogPanel } from "../runner/LogPanel";
import { RunnerPanel } from "../runner/RunnerPanel";

const FRAMEWORK_LABELS: Record<string, string> = {
  "next-js": "Next.js",
  "vite-react": "React + Vite",
  vite: "Vite",
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

  // Global workspace shortcuts — active only while a workspace is loaded.
  // Ctrl+P: quick open · Ctrl+Shift+F: workspace search. CodeMirror's own
  // Ctrl+S / Ctrl+F keep working inside the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "p" && !e.shiftKey && !e.altKey) {
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
  }, []);

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
          <button type="button" className="btn" onClick={changeProject}>
            Change…
          </button>
        </div>

        <dl className="facts">
          <div className="fact">
            <dt>Workspace</dt>
            <dd>
              <code>{KIND_LABELS[workspace.workspaceKind] ?? workspace.workspaceKind}</code>
            </dd>
          </div>
          {workspace.targets.length > 1 && (
            <div className="fact">
              <dt>Active target</dt>
              <dd>
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
              </dd>
            </div>
          )}
          <div className="fact">
            <dt>Framework</dt>
            <dd>
              <code>
                {target ? frameworkLabel(target.framework, target.frameworkVersion) : "—"}
              </code>
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
          {!isLive && caps.run.state === "available" && (
            <button type="button" className="btn btn-primary" onClick={run}>
              Run Project
            </button>
          )}
          <button type="button" className="btn" onClick={openInPreferredEditor}>
            Open in Editor
          </button>
        </div>
      </section>

      {(isLive || runtime.phase === "stopped" || runtime.phase === "failed") && <RunnerPanel />}

      <div className="workspace">
        <ExplorerPanel onSearch={(query) => setSearch({ open: true, query })} />
        <div className="workspace-main">
          {isLive &&
            caps.domInspect.state === "available" &&
            state.inspector.phase !== "inactive" && (
              <InspectorPanel onSearch={(query) => setSearch({ open: true, query })} />
            )}

          <EditorPanel />

          {(state.logs.length > 0 || isLive) && <LogPanel logs={state.logs} />}
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
