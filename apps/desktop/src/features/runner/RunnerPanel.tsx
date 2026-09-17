import { errorMessage, isLoopbackUrl } from "@rootray/shared";
import { useEffect, useState } from "react";
import { formatElapsed } from "../../lib/format";
import { openBrowser, restartDevServer, stopDevServer } from "../../lib/ipc";
import { useStore } from "../../state/store";

export function RunnerPanel() {
  const { state, dispatch } = useStore();
  const { runtime } = state;
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<"stop" | "restart" | null>(null);

  const running = runtime.phase === "running";
  const busyPhase = runtime.phase === "starting" || runtime.phase === "stopping";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const act = async (which: "stop" | "restart") => {
    setBusy(which);
    dispatch({ type: "notice", message: null });
    try {
      if (which === "stop") await stopDevServer();
      else await restartDevServer(true);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    if (!runtime.url) return;
    try {
      await openBrowser(runtime.url);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    }
  };

  const urlSafe = runtime.url ? isLoopbackUrl(runtime.url) : false;

  return (
    <section className="runner">
      <div className="runner-row">
        <span className={`run-dot ${running ? "on" : ""}`} aria-hidden />
        <span className="run-state">{running ? "Running" : runtime.phase}</span>
        {runtime.url && (
          <button
            type="button"
            className="url-chip"
            title={urlSafe ? "Open in browser" : "URL failed loopback validation"}
            onClick={open}
            disabled={!urlSafe}
          >
            {runtime.url}
          </button>
        )}
        {runtime.pid && <span className="meta">PID {runtime.pid}</span>}
        <span className="meta">{formatElapsed(runtime.startedAt, now)}</span>
      </div>

      <div className="runner-actions">
        <button
          type="button"
          className="btn"
          disabled={!running || !urlSafe}
          onClick={open}
          title="Open the project URL in the system browser"
        >
          Open External
        </button>
        <button
          type="button"
          className="btn"
          disabled={busyPhase || busy !== null}
          onClick={() => act("restart")}
        >
          {busy === "restart" ? "Restarting…" : "Restart"}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={(!running && runtime.phase !== "starting") || busy !== null}
          onClick={() => act("stop")}
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
      </div>
    </section>
  );
}
