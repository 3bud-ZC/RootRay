import type { RootRaySettings } from "@rootray/shared";
import { errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { BrandLoader } from "../../components/BrandLoader";
import { analyzeProject, getSettings, pickProjectDirectory } from "../../lib/ipc";
import { useStore } from "../../state/store";

export function HomeView() {
  const { dispatch } = useStore();
  const [settings, setSettings] = useState<RootRaySettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getSettings()
      .then(async (s) => {
        if (!live) return;
        setSettings(s);
        // Session recovery: re-analyze the last open project (read-only —
        // the dev server is never started automatically). A deleted or
        // invalid project degrades back to this home view with a notice.
        if (!s.lastProject) return;
        setBusy(true);
        try {
          await analyzeProject(s.lastProject);
        } catch (e) {
          if (live) {
            dispatch({
              type: "notice",
              message: `Could not restore last project — ${errorMessage(e)}`,
            });
          }
        } finally {
          if (live) setBusy(false);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dispatch]);

  const openProject = async (path?: string) => {
    const dir = path ?? (await pickProjectDirectory());
    if (!dir) return;
    setBusy(true);
    dispatch({ type: "notice", message: null });
    try {
      await analyzeProject(dir);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const recents = settings?.recentProjects ?? [];

  return (
    <div className="home">
      <div className="home-hero">
        <img className="home-lockup brand-img" src="/brand/lockup.png" alt="" />
        <h1>Open a workspace</h1>
        <p className="muted">
          Select a local project or workspace. RootRay discovers its structure, technologies and
          targets — and where supported, lets you point at the rendered UI to reach the source.
        </p>
        {busy ? (
          <BrandLoader label="Analyzing workspace…" />
        ) : (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => openProject()}>
            Open Project
          </button>
        )}
      </div>

      <section className="recents">
        <h2 className="section-title">Recent Projects</h2>
        {recents.length === 0 ? (
          <p className="muted empty-hint">
            No recent projects yet. Open any local project or workspace to get started.
          </p>
        ) : (
          <ul className="recent-list">
            {recents.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className="recent-item"
                  disabled={busy}
                  onClick={() => openProject(p)}
                  title={p}
                >
                  <span className="recent-name">{p.split(/[\\/]/).filter(Boolean).pop()}</span>
                  <span className="recent-path">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
