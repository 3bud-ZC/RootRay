/**
 * Inspect-click → source auto-reveal. The whole point of the workbench:
 * clicking an element immediately opens its authored source beside the
 * preview — no "Open Source" round trip.
 *
 * Safety is inherited from the Quick Edit pipeline: a dirty session in a
 * *different* file parks the reveal behind the unsaved-changes prompt
 * instead of clobbering edits. Same-file selections only move the focus
 * marker. Source-less selections (runtime DOM, canvas) change nothing.
 *
 * Rapid clicks are race-safe by the reducer contract: `edit-open` is
 * synchronous, so the newest selection always wins the target path and a
 * stale `edit-opened` for an older path is discarded.
 */

import { useEffect, useRef } from "react";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";

export function useSelectionAutoReveal() {
  const { state, dispatch } = useStore();
  const sel = state.inspector.lastSelection;
  const prev = useRef(sel);

  useEffect(() => {
    if (sel === prev.current) return;
    prev.current = sel;
    const src = sel?.source;
    if (!src) {
      if (state.layout.focusMode === "preview") dispatch({ type: "reveal-offer-clear" });
      return;
    }
    if (state.layout.focusMode === "preview") {
      // Preview Focus stays intact — surface a "Show Source" offer the
      // user can accept deliberately instead of tearing the layout down.
      dispatch({ type: "reveal-offer", relativePath: src.relativePath, source: src });
      return;
    }
    dispatch({ type: "reveal-offer-clear" });
    void quickEdit(state, dispatch, src.relativePath, src);
    // Keep the preview visible — reveal beside it, never instead of it.
    if (state.workspaceTab === "preview") {
      dispatch({ type: "workspace-tab", tab: "split" });
    }
  }, [sel, state, dispatch]);
}
