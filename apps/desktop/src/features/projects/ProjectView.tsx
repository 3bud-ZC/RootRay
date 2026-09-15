import { errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { projectDisplayName } from "../../lib/format";
import {
  analyzeProject,
  getSettings,
  openInEditor,
  pickProjectDirectory,
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

export function ProjectView() {
  const { state, dispatch } = useStore();
  const { runtime } = state;
  const project = runtime.project;
  const [quickOpen, setQuickOpen] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });

  // Global workspace shortcuts — active only while a project is loaded.
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

  if (!project) return null;

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

  return (
    <div className="project">
      <section className="project-card">
        <div className="project-head">
          <div>
            <h1 className="project-name">
              {projectDisplayName(project.projectName, project.root)}
            </h1>
            <div className="project-path" title={project.root}>
              {project.root}
            </div>
          </div>
          <button type="button" className="btn" onClick={changeProject}>
            Change…
          </button>
        </div>

        <dl className="facts">
          <div className="fact">
            <dt>Framework</dt>
            <dd>
              <code>{project.framework}</code>
            </dd>
          </div>
          <div className="fact">
            <dt>Package manager</dt>
            <dd>
              <code>{project.packageManager}</code>
            </dd>
          </div>
          <div className="fact">
            <dt>Dev command</dt>
            <dd>
              <code>{project.devCommand?.display ?? "—"}</code>
            </dd>
          </div>
          <div className="fact">
            <dt>Compatibility</dt>
            <dd>
              {project.supported ? (
                project.capabilities.canRun ? (
                  <span className="ok">Supported — can run</span>
                ) : (
                  <span className="warn">Detected — cannot run</span>
                )
              ) : (
                <span className="bad">Unsupported</span>
              )}
            </dd>
          </div>
        </dl>

        {!project.supported && (
          <div className="reasons">
            <h2 className="section-title bad">Unsupported Project</h2>
            <ul>
              {project.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {project.supported && !project.capabilities.canRun && (
          <div className="reasons">
            <h2 className="section-title warn">Cannot run</h2>
            <ul>
              {project.reasons.map((r) => (
                <li key={r}>{r}</li>
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
          {!isLive && project.capabilities.canRun && (
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
            project.capabilities.inspectorCompatible &&
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
