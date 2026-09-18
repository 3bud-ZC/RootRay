import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface BoundaryState {
  crashed: boolean;
  detail: string | null;
}

/**
 * Last-resort UI containment: a render failure swaps to a compact
 * recovery view instead of a permanently blank window. Diagnostics are
 * self-contained (error name + truncated message) — the full state-aware
 * diagnostics builder isn't reachable because the store may be what
 * crashed, so this stays deliberately dependency-free.
 */
export class ErrorBoundary extends Component<Props, BoundaryState> {
  override state: BoundaryState = { crashed: false, detail: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return {
      crashed: true,
      detail: `${error.name}: ${error.message}`.slice(0, 400),
    };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    // Component stack is truncated — diagnostics stay small and safe.
    this.setState((s) => ({
      detail: `${s.detail ?? ""}\n${(info.componentStack ?? "").slice(0, 600)}`.trim(),
    }));
  }

  private copyDiagnostics = async () => {
    const text = [
      "RootRay UI crash",
      this.state.detail ?? "unknown error",
      `UA: ${navigator.userAgent.slice(0, 200)}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable — the text stays on screen */
    }
  };

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="crash-view" role="alert">
        <div className="crash-card">
          <img className="pane-mascot brand-img" src="/brand/mascot.png" alt="" />
          <h1>RootRay encountered an interface error.</h1>
          <p className="muted">
            Your project files were not touched. You can reload the interface or copy diagnostics
            for a bug report.
          </p>
          <div className="crash-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload Interface
            </button>
            <button type="button" className="btn" onClick={this.copyDiagnostics}>
              Copy Diagnostics
            </button>
          </div>
          {this.state.detail && <pre className="crash-detail">{this.state.detail}</pre>}
        </div>
      </div>
    );
  }
}
