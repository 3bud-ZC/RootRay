import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "../../lib/fuzzy";
import { listProjectFiles } from "../../lib/ipc";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";

const RESULT_CAP = 50;

/**
 * Ctrl+P file picker. The file list is fetched lazily once per project
 * and cached; filtering is pure local fuzzy matching. Selection routes
 * through `quickEdit`, so the dirty-editor guard still applies.
 */
export function QuickOpen({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const root = state.runtime.project?.root ?? "";
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[] | null>(null);
  const [active, setActive] = useState(0);
  const cache = useRef<{ root: string; paths: string[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    if (cache.current?.root === root) {
      setPaths(cache.current.paths);
      return;
    }
    listProjectFiles()
      .then((l) => {
        if (!live) return;
        cache.current = { root, paths: l.paths };
        setPaths(l.paths);
      })
      .catch(() => live && setPaths([]));
    return () => {
      live = false;
    };
  }, [root]);

  const results = useMemo(() => fuzzyFilter(query, paths ?? [], RESULT_CAP), [query, paths]);
  const clamped = Math.min(active, Math.max(0, results.length - 1));

  const pick = (rel: string) => {
    onClose();
    void quickEdit(state, dispatch, rel, { relativePath: rel, line: 1, column: 1 });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[clamped];
      if (target) pick(target);
    }
  };

  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="backdrop-dismiss"
        aria-label="Close quick open"
        onClick={onClose}
      />
      <div className="palette" role="dialog" aria-label="Quick open">
        <input
          className="palette-input"
          placeholder="Quick Open — type a file path…"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: command palettes must focus the input on open
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {paths === null && <div className="muted palette-empty">Loading files…</div>}
          {paths !== null && results.length === 0 && (
            <div className="muted palette-empty">No matching files</div>
          )}
          {results.map((p, i) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={i === clamped}
              className={`palette-item ${i === clamped ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              <span className="palette-name">{p.split("/").pop()}</span>
              <span className="palette-path muted">{p}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
