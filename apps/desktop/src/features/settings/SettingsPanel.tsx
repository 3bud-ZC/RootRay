import type { DetectedLauncher, RootRaySettings } from "@rootray/shared";
import { errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { buildDiagnostics } from "../../lib/diagnostics";
import { detectEditors, getSettings, updateSettings } from "../../lib/ipc";
import { useStore } from "../../state/store";

export function SettingsPanel() {
  const { state, dispatch } = useStore();
  const [settings, setSettings] = useState<RootRaySettings | null>(null);
  const [launchers, setLaunchers] = useState<DetectedLauncher[]>([]);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => {});
    detectEditors()
      .then(setLaunchers)
      .catch(() => {});
  }, []);

  const patch = async (p: Parameters<typeof updateSettings>[0], fallback: string) => {
    try {
      setSettings(await updateSettings(p));
    } catch (e) {
      dispatch({ type: "notice", message: `${fallback}: ${errorMessage(e)}` });
    }
  };

  const close = () => dispatch({ type: "toggle-settings", open: false });

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(await buildDiagnostics(state));
      dispatch({ type: "notice", message: "Diagnostics copied", isError: false });
    } catch {
      dispatch({ type: "notice", message: "Copy failed" });
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings">
      <div className="settings-panel">
        <div className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            ×
          </button>
        </div>

        <section className="settings-section">
          <h3 className="section-title">Preferred code editor</h3>
          <ul className="launcher-list">
            {launchers.map((l) => (
              <li key={l.id}>
                <label className={`launcher ${l.available ? "" : "unavailable"}`}>
                  <input
                    type="radio"
                    name="launcher"
                    disabled={!l.available}
                    checked={settings?.preferredLauncher === l.id}
                    onChange={() =>
                      patch({ preferredLauncher: l.id }, "Failed to save editor preference")
                    }
                  />
                  <span className="launcher-name">{l.name}</span>
                  <span className="launcher-state">
                    {l.available ? l.executablePath : "not found"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Preview</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.openPreviewAutomatically ?? true}
              onChange={(e) =>
                patch(
                  { openPreviewAutomatically: e.target.checked },
                  "Failed to save preview preference",
                )
              }
            />
            Open the internal preview automatically when the dev server is ready
          </label>
          <p className="muted">
            The project runs inside RootRay. Use External in the toolbar to open the system browser
            manually.
          </p>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Workbench layout</h3>
          <p className="muted">
            Pane visibility, widths and the preview/code split are saved locally. Reset restores the
            default arrangement.
          </p>
          <button type="button" className="btn" onClick={() => dispatch({ type: "layout-reset" })}>
            Reset Layout
          </button>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Recent projects</h3>
          <p className="muted">{settings?.recentProjects.length ?? 0} saved</p>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => patch({ clearRecentProjects: true }, "Failed to clear recents")}
          >
            Clear recent projects
          </button>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Support</h3>
          <p className="muted">
            Version, platform and runtime state only — never tokens, env vars or source code.
          </p>
          <button type="button" className="btn" onClick={copyDiagnostics}>
            Copy Diagnostics
          </button>
        </section>
      </div>
    </div>
  );
}
