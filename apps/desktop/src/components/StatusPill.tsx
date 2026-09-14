import type { RuntimePhase } from "@rootray/shared";

const LABELS: Record<RuntimePhase, string> = {
  idle: "Idle",
  analyzing: "Analyzing…",
  ready: "Ready",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  stopped: "Stopped",
  failed: "Failed",
};

export function StatusPill({ phase }: { phase: RuntimePhase }) {
  return (
    <span className={`pill pill-${phase}`}>
      <span className="pill-dot" aria-hidden />
      {LABELS[phase]}
    </span>
  );
}
