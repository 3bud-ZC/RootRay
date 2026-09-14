import type { LogLine, ProcessEventPayload, RuntimeState } from "@rootray/shared";

export const LOG_CAP = 500;

export interface UiState {
  runtime: RuntimeState;
  /** Live-appended log tail (mirrors backend recentLogs, streams realtime). */
  logs: LogLine[];
  settingsOpen: boolean;
  /** Transient user-facing error from the last failed action. */
  notice: string | null;
}

export const emptyRuntime: RuntimeState = {
  phase: "idle",
  project: null,
  pid: null,
  command: null,
  url: null,
  port: null,
  startedAt: null,
  error: null,
  recentLogs: [],
};

export const initialUiState: UiState = {
  runtime: emptyRuntime,
  logs: [],
  settingsOpen: false,
  notice: null,
};

export type UiAction =
  | { type: "runtime"; state: RuntimeState }
  | { type: "process-event"; event: ProcessEventPayload }
  | { type: "toggle-settings"; open?: boolean }
  | { type: "notice"; message: string | null };

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "runtime": {
      // A new run resets the live log tail — backend clears its buffer too.
      const logs = action.state.phase === "starting" ? [] : state.logs;
      return { ...state, runtime: action.state, logs };
    }
    case "process-event": {
      const e = action.event;
      if (e.kind === "stdout" || e.kind === "stderr") {
        const line: LogLine = { stream: e.kind, line: e.line, at: Date.now() };
        const logs =
          state.logs.length >= LOG_CAP ? [...state.logs.slice(1), line] : [...state.logs, line];
        return { ...state, logs };
      }
      return state;
    }
    case "toggle-settings":
      return { ...state, settingsOpen: action.open ?? !state.settingsOpen };
    case "notice":
      return { ...state, notice: action.message };
  }
}
