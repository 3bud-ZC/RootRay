import { StatusPill } from "../components/StatusPill";
import { HomeView } from "../features/projects/HomeView";
import { ProjectView } from "../features/projects/ProjectView";
import { SettingsPanel } from "../features/settings/SettingsPanel";
import { useStore } from "../state/store";

export function App() {
  const { state, dispatch } = useStore();
  const { runtime } = state;
  const hasProject = runtime.project !== null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◉</span>
          <span className="brand-name">RootRay</span>
          <span className="brand-tag">Point at the UI. Reach the source.</span>
        </div>
        <div className="header-right">
          <StatusPill phase={runtime.phase} />
          <button
            type="button"
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => dispatch({ type: "toggle-settings" })}
          >
            ⚙
          </button>
        </div>
      </header>

      {state.notice && (
        <div className="notice" role="alert">
          <span>{state.notice}</span>
          <button
            type="button"
            className="notice-dismiss"
            onClick={() => dispatch({ type: "notice", message: null })}
          >
            ×
          </button>
        </div>
      )}

      <main className="app-main">{!hasProject ? <HomeView /> : <ProjectView />}</main>

      {state.settingsOpen && <SettingsPanel />}
    </div>
  );
}
