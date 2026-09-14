import type { RuntimeState } from "@rootray/shared";
import { describe, expect, it } from "vitest";
import { emptyRuntime, initialUiState, LOG_CAP, type UiState, uiReducer } from "./reducer";

function runtime(over: Partial<RuntimeState>): RuntimeState {
  return { ...emptyRuntime, ...over };
}

describe("uiReducer", () => {
  it("applies runtime snapshots", () => {
    const s = uiReducer(initialUiState, {
      type: "runtime",
      state: runtime({ phase: "running", pid: 1234 }),
    });
    expect(s.runtime.phase).toBe("running");
    expect(s.runtime.pid).toBe(1234);
  });

  it("appends log events and caps the buffer", () => {
    let s: UiState = initialUiState;
    for (let i = 0; i < LOG_CAP + 50; i++) {
      s = uiReducer(s, {
        type: "process-event",
        event: { kind: "stdout", line: `line ${i}` },
      });
    }
    expect(s.logs).toHaveLength(LOG_CAP);
    expect(s.logs[LOG_CAP - 1]?.line).toBe(`line ${LOG_CAP + 49}`);
    expect(s.logs[0]?.line).toBe("line 50");
  });

  it("tags stderr lines distinctly", () => {
    const s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "stderr", line: "boom" },
    });
    expect(s.logs[0]?.stream).toBe("stderr");
  });

  it("clears the log tail when a new run starts", () => {
    let s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "stdout", line: "old" },
    });
    s = uiReducer(s, {
      type: "runtime",
      state: runtime({ phase: "starting" }),
    });
    expect(s.logs).toHaveLength(0);
  });

  it("ignores non-log process events for the log buffer", () => {
    const s = uiReducer(initialUiState, {
      type: "process-event",
      event: { kind: "url-detected", url: "http://localhost:5173/", port: 5173 },
    });
    expect(s.logs).toHaveLength(0);
  });

  it("toggles settings and records notices", () => {
    let s = uiReducer(initialUiState, { type: "toggle-settings" });
    expect(s.settingsOpen).toBe(true);
    s = uiReducer(s, { type: "toggle-settings", open: false });
    expect(s.settingsOpen).toBe(false);
    s = uiReducer(s, { type: "notice", message: "failed" });
    expect(s.notice).toBe("failed");
    s = uiReducer(s, { type: "notice", message: null });
    expect(s.notice).toBeNull();
  });
});
