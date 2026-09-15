import type {
  EditorEventPayload,
  InspectorState,
  ProcessEventPayload,
  RuntimeState,
} from "@rootray/shared";
import { listen } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { handleEditorEvent } from "../features/editor/controller";
import { getInspectorState, getRuntimeState, getSettings, openBrowser } from "../lib/ipc";
import { initialUiState, type UiAction, type UiState, uiReducer } from "./reducer";

const StoreContext = createContext<{
  state: UiState;
  dispatch: React.Dispatch<UiAction>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  // Editor events arrive asynchronously — keep a live ref so the listener
  // sees the current session status rather than a stale mount-time one.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // Initial snapshot (e.g. after a frontend hot-reload mid-session).
    getRuntimeState()
      .then((s) => dispatch({ type: "runtime", state: s }))
      .catch(() => {});
    getInspectorState()
      .then((s) => dispatch({ type: "inspector", state: s }))
      .catch(() => {});

    const unlistenState = listen<RuntimeState>("rootray://state", (e) =>
      dispatch({ type: "runtime", state: e.payload }),
    );
    const unlistenInspector = listen<InspectorState>("rootray://inspector-state", (e) =>
      dispatch({ type: "inspector", state: e.payload }),
    );
    const unlistenEditor = listen<EditorEventPayload>("rootray://editor-event", (e) =>
      handleEditorEvent(e.payload, () => stateRef.current, dispatch),
    );
    const unlistenEvents = listen<ProcessEventPayload>("rootray://process-event", (e) => {
      const payload = e.payload;
      dispatch({ type: "process-event", event: payload });
      if (payload.kind === "url-detected") {
        // Honor the "open browser automatically" preference.
        getSettings()
          .then((s) => {
            if (s.openBrowserAutomatically) {
              openBrowser(payload.url).catch(() => {});
            }
          })
          .catch(() => {});
      }
    });
    return () => {
      unlistenState.then((f) => f());
      unlistenInspector.then((f) => f());
      unlistenEditor.then((f) => f());
      unlistenEvents.then((f) => f());
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside AppProvider");
  return ctx;
}
