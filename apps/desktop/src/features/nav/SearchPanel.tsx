import type { WorkspaceSearchResult } from "@rootray/shared";
import { errorMessage } from "@rootray/shared";
import { useEffect, useRef, useState } from "react";
import { searchWorkspace } from "../../lib/ipc";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";

const DEBOUNCE_MS = 200;

/**
 * Ctrl+Shift+F workspace search — bounded native text search over safe
 * source files. A monotonic request id guarantees stale results can
 * never overwrite a newer query.
 */
export function SearchPanel({
  initialQuery = "",
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      setError(null);
      setSearching(false);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchWorkspace(q)
        .then((r) => {
          if (reqId.current === id) {
            setResult(r);
            setError(null);
            setSearching(false);
          }
        })
        .catch((e) => {
          if (reqId.current === id) {
            setError(errorMessage(e));
            setResult(null);
            setSearching(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const open = (path: string, line: number, column: number) => {
    onClose();
    void quickEdit(state, dispatch, path, { relativePath: path, line, column });
  };

  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="backdrop-dismiss"
        aria-label="Close workspace search"
        onClick={onClose}
      />
      <div className="palette" role="dialog" aria-label="Workspace search">
        <input
          className="palette-input"
          placeholder="Search in project files…"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: command palettes must focus the input on open
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" role="listbox" aria-label="Search results">
          {searching && <div className="muted palette-empty">Searching…</div>}
          {error && <div className="palette-empty bad">{error}</div>}
          {!searching && result && result.matches.length === 0 && (
            <div className="muted palette-empty">No matches</div>
          )}
          {result?.matches.map((m, i) => (
            <button
              key={`${m.relativePath}:${m.line}:${m.column}:${i}`}
              type="button"
              role="option"
              aria-selected={false}
              className="palette-item search-item"
              onClick={() => open(m.relativePath, m.line, m.column)}
            >
              <span className="palette-loc">
                {m.relativePath}:{m.line}
              </span>
              <span className="palette-preview muted">{m.preview}</span>
            </button>
          ))}
        </div>
        {result && (
          <div className="palette-foot muted">
            {result.matches.length} match{result.matches.length === 1 ? "" : "es"} ·{" "}
            {result.filesScanned} files scanned
            {result.truncated ? " · results truncated" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
