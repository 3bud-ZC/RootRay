import type {
  EditorEventPayload,
  InspectorState,
  PreviewState,
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
import {
  disposePreview,
  markPreviewStopped,
  markPreviewWaiting,
} from "../features/preview/controller";
import { getInspectorState, getRuntimeState, getSettings, previewState } from "../lib/ipc";
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
    previewState()
      .then((s) => {
        // Stubbed shells resolve commands with undefined — never let a
        // missing snapshot clobber the reducer's preview slice.
        if (s) dispatch({ type: "preview-state", state: s });
      })
      .catch(() => {});
    // The preview auto-open preference is settings-backed.
    getSettings()
      .then((s) => dispatch({ type: "auto-preview", enabled: s.openPreviewAutomatically }))
      .catch(() => {});

    const unlistenState = listen<RuntimeState>("rootray://state", (e) =>
      dispatch({ type: "runtime", state: e.payload }),
    );
    const unlistenInspector = listen<InspectorState>("rootray://inspector-state", (e) =>
      dispatch({ type: "inspector", state: e.payload }),
    );
    const unlistenPreview = listen<PreviewState>("rootray://preview-state", (e) =>
      dispatch({ type: "preview-state", state: e.payload }),
    );
    const unlistenEditor = listen<EditorEventPayload>("rootray://editor-event", (e) =>
      handleEditorEvent(e.payload, () => stateRef.current, dispatch),
    );
    const unlistenEvents = listen<ProcessEventPayload>("rootray://process-event", (e) =>
      dispatch({ type: "process-event", event: e.payload }),
    );
    return () => {
      unlistenState.then((f) => f());
      unlistenInspector.then((f) => f());
      unlistenPreview.then((f) => f());
      unlistenEditor.then((f) => f());
      unlistenEvents.then((f) => f());
    };
  }, []);

  // Runtime phase drives the preview lifecycle marks. Creation itself
  // needs the layout rect, so PreviewPanel handles that half; the marks
  // here keep the native snapshot truthful across run/stop/analyze.
  const prevPhase = useRef(state.runtime.phase);
  useEffect(() => {
    const phase = state.runtime.phase;
    if (phase === prevPhase.current) return;
    prevPhase.current = phase;
    if (phase === "starting") {
      markPreviewWaiting();
    } else if (phase === "stopped" || phase === "failed") {
      markPreviewStopped();
    } else if (phase === "idle" || phase === "analyzing" || phase === "ready") {
      disposePreview();
    }
  }, [state.runtime.phase]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside AppProvider");
  return ctx;
}
