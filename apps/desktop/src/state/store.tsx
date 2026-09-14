import type { ProcessEventPayload, RuntimeState } from "@rootray/shared";
import { listen } from "@tauri-apps/api/event";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer } from "react";
import { getRuntimeState, getSettings, openBrowser } from "../lib/ipc";
import { initialUiState, type UiAction, type UiState, uiReducer } from "./reducer";

const StoreContext = createContext<{
  state: UiState;
  dispatch: React.Dispatch<UiAction>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);

  useEffect(() => {
    // Initial snapshot (e.g. after a frontend hot-reload mid-session).
    getRuntimeState()
      .then((s) => dispatch({ type: "runtime", state: s }))
      .catch(() => {});

    const unlistenState = listen<RuntimeState>("rootray://state", (e) =>
      dispatch({ type: "runtime", state: e.payload }),
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
