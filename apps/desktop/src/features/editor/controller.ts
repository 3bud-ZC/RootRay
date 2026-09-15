/**
 * Quick Edit orchestration — the async shell around the pure reducer.
 * Keeps IPC calls, error mapping and the external-change policy in one
 * place so components stay declarative.
 */

import type { CoreErrorPayload, EditorEventPayload, SourceLocation } from "@rootray/shared";
import {
  closeSourceEditor,
  openSourceEditor,
  peekSourceFile,
  reloadSourceFile,
  revertSourceSave,
  saveSourceFile,
} from "../../lib/ipc";
import type { UiAction, UiState } from "../../state/reducer";

type Dispatch = React.Dispatch<UiAction>;
type GetState = () => UiState;

function asCoreError(err: unknown): CoreErrorPayload {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: unknown; message: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return { code: e.code as CoreErrorPayload["code"], message: e.message };
    }
  }
  return { code: "INTERNAL", message: String(err) };
}

/** `Quick Edit` — opens (or refocuses) the inspected file in-app. */
export async function quickEdit(
  state: UiState,
  dispatch: Dispatch,
  relativePath: string,
  source: SourceLocation,
) {
  const existing = state.editor;
  // Same file: just move the focus marker — never reload dirty content.
  if (existing && existing.relativePath === relativePath) {
    dispatch({ type: "edit-open", relativePath, source });
    return;
  }
  dispatch({ type: "edit-open", relativePath, source });
  // Dirty different file → reducer parked this behind the close prompt;
  // the deferred open happens on "Discard Changes" (see confirmClose).
  if (existing && existing.status !== "clean") return;
  try {
    const read = await openSourceEditor(relativePath);
    dispatch({ type: "edit-opened", read, source });
  } catch (err) {
    dispatch({ type: "edit-closed" });
    const e = asCoreError(err);
    dispatch({
      type: "notice",
      message:
        e.code === "SOURCE_FILE_DENIED" ||
        e.code === "SOURCE_FILE_BINARY" ||
        e.code === "SOURCE_FILE_TOO_LARGE" ||
        e.code === "SOURCE_FILE_ENCODING_UNSUPPORTED"
          ? "This file cannot be edited safely inside RootRay. Open it in your external editor instead."
          : `Quick Edit failed: ${e.message}`,
    });
  }
}

/** Ctrl+S / Save button. No-op unless there is something to write. */
export async function saveEditor(state: UiState, dispatch: Dispatch) {
  const ed = state.editor;
  if (!ed || ed.status !== "dirty") return;
  dispatch({ type: "edit-save-start" });
  try {
    const write = await saveSourceFile(ed.relativePath, ed.currentContent, ed.baseHash);
    dispatch({ type: "edit-saved", write });
  } catch (err) {
    dispatch({ type: "edit-failed", error: asCoreError(err) });
  }
}

/** Discard → restore the last-loaded/saved snapshot. File is untouched. */
export function discardEditor(dispatch: Dispatch) {
  dispatch({ type: "edit-discard" });
}

/**
 * Close request. Dirty sessions park behind the prompt; the caller that
 * set `pendingOpen` is resumed by `confirmClose`.
 */
export function requestCloseEditor(dispatch: Dispatch) {
  dispatch({ type: "edit-close-request" });
}

/** User confirmed discarding unsaved changes — closes the native session. */
export async function confirmCloseEditor(state: UiState, dispatch: Dispatch) {
  const pending = state.pendingOpen;
  try {
    await closeSourceEditor();
  } catch {
    // Session may already be gone — closing must never fail visibly.
  }
  dispatch({ type: "edit-closed" });
  if (pending) {
    // Re-dispatch as a fresh open — the session is now closed so it loads.
    dispatch({ type: "edit-open", relativePath: pending.relativePath, source: pending.source });
    try {
      const read = await openSourceEditor(pending.relativePath);
      dispatch({ type: "edit-opened", read, source: pending.source });
    } catch (err) {
      dispatch({ type: "notice", message: `Quick Edit failed: ${asCoreError(err).message}` });
    }
  }
}

/** "Reload Disk Version" — abandons unsaved edits for the disk truth. */
export async function reloadFromDisk(state: UiState, dispatch: Dispatch) {
  const ed = state.editor;
  if (!ed) return;
  try {
    const read = await reloadSourceFile(ed.relativePath);
    dispatch({ type: "edit-disk-loaded", read });
  } catch (err) {
    dispatch({ type: "notice", message: `Reload failed: ${asCoreError(err).message}` });
  }
}

/** Conflict "Compare" — fetch disk text without touching the session. */
export async function compareWithDisk(state: UiState, dispatch: Dispatch) {
  const ed = state.editor;
  if (!ed) return;
  try {
    const read = await peekSourceFile(ed.relativePath);
    dispatch({ type: "edit-conflict-compare", diskContent: read.content });
  } catch (err) {
    dispatch({ type: "notice", message: `Compare failed: ${asCoreError(err).message}` });
  }
}

export function closeCompare(dispatch: Dispatch) {
  dispatch({ type: "edit-conflict-compare-close" });
}

/** "Revert Last Save" — restores pre-save bytes iff disk is untouched. */
export async function revertLastSave(state: UiState, dispatch: Dispatch) {
  const ed = state.editor;
  if (!ed) return;
  try {
    const read = await revertSourceSave(ed.relativePath);
    dispatch({ type: "edit-reverted", read });
  } catch (err) {
    const e = asCoreError(err);
    if (e.code === "SOURCE_EDIT_CONFLICT") {
      dispatch({ type: "edit-failed", error: e });
    } else {
      dispatch({ type: "notice", message: e.message });
    }
  }
}

/**
 * `rootray://editor-event` — the watcher says the open file's bytes
 * changed underneath us. Clean sessions reload silently; anything with
 * unsaved work becomes a conflict (content is never dropped).
 */
export function handleEditorEvent(
  payload: EditorEventPayload,
  getState: GetState,
  dispatch: Dispatch,
) {
  if (payload.kind !== "externalChange") return;
  const ed = getState().editor;
  if (!ed || ed.relativePath !== payload.relativePath) return;
  if (ed.status === "clean" || ed.status === "loading") {
    // Auto-reload a clean file; the reducer refuses to clobber if the
    // user managed to type before the reload landed.
    reloadSourceFile(ed.relativePath)
      .then((read) => dispatch({ type: "edit-disk-loaded", read }))
      .catch(() => dispatch({ type: "edit-external-change", diskHash: payload.diskHash }));
    return;
  }
  dispatch({ type: "edit-external-change", diskHash: payload.diskHash });
}

/** Inspector selection changed — if it targets the open file, refocus. */
export function focusEditorOnSelection(dispatch: Dispatch, source: SourceLocation) {
  dispatch({ type: "edit-focus", source });
}
