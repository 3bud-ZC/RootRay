import type { DirListing, ProjectEntry } from "@rootray/shared";
import { useCallback, useEffect, useState } from "react";
import { listProjectDir } from "../../lib/ipc";
import { getRecentFiles } from "../../lib/recents";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";
import { usePreferredLauncher } from "../inspector/useLauncher";

type DirState = DirListing | "loading" | "error";

/**
 * Lazy project explorer — directories load only when expanded; the tree
 * is never fully materialized. Actions are navigation only: Quick Edit,
 * open external, copy path. No delete/rename/move.
 */
export function ExplorerPanel({ onSearch }: { onSearch: (query: string) => void }) {
  const { state, dispatch } = useStore();
  const root = state.runtime.workspace?.root ?? "";
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [, forceRecents] = useState(0);
  const launcher = usePreferredLauncher();

  const loadDir = useCallback(async (rel: string) => {
    setDirs((m) => new Map(m).set(rel, "loading"));
    try {
      const listing = await listProjectDir(rel);
      setDirs((m) => new Map(m).set(rel, listing));
    } catch {
      setDirs((m) => new Map(m).set(rel, "error"));
    }
  }, []);

  // Load the root once per project.
  useEffect(() => {
    setExpanded(new Set());
    setDirs(new Map());
    if (root) void loadDir("");
  }, [root, loadDir]);

  const toggle = (rel: string) => {
    const next = new Set(expanded);
    if (next.has(rel)) {
      next.delete(rel);
    } else {
      next.add(rel);
      if (!dirs.has(rel)) void loadDir(rel);
    }
    setExpanded(next);
  };

  const openQuickEdit = (rel: string, line = 1) => {
    void quickEdit(state, dispatch, rel, { relativePath: rel, line, column: 1 }).then(() =>
      forceRecents((n) => n + 1),
    );
  };

  const openExternal = (rel: string) => {
    launcher?.openAt(rel, 1, 1);
  };

  const copyPath = (rel: string) => {
    navigator.clipboard.writeText(rel).catch(() => {});
  };

  const renderRows = (rel: string, depth: number): React.ReactNode => {
    const listing = dirs.get(rel);
    if (listing === "loading") {
      return (
        <div className="ex-row muted" style={{ paddingLeft: 14 + depth * 14 }}>
          Loading…
        </div>
      );
    }
    if (listing === "error" || !listing) return null;
    return listing.entries.map((entry) => (
      <ExplorerRow
        key={entry.relativePath}
        entry={entry}
        depth={depth}
        open={expanded.has(entry.relativePath)}
        onToggle={toggle}
        onQuickEdit={openQuickEdit}
        onExternal={openExternal}
        onCopy={copyPath}
        onSearch={onSearch}
        renderRows={renderRows}
      />
    ));
  };

  const recents = root ? getRecentFiles(root) : [];

  return (
    <section className="explorer">
      <div className="explorer-head">
        <h3 className="section-title">Explorer</h3>
      </div>
      {recents.length > 0 && (
        <div className="ex-recents">
          <div className="ex-group muted">Recent</div>
          {recents.map((rel) => (
            <button
              key={rel}
              type="button"
              className="ex-row ex-file ex-recent"
              onClick={() => openQuickEdit(rel)}
              title={rel}
            >
              {rel.split("/").pop()}
              <span className="ex-rel muted">{rel}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ex-tree">{renderRows("", 0)}</div>
    </section>
  );
}

function ExplorerRow({
  entry,
  depth,
  open,
  onToggle,
  onQuickEdit,
  onExternal,
  onCopy,
  onSearch,
  renderRows,
}: {
  entry: ProjectEntry;
  depth: number;
  open: boolean;
  onToggle: (rel: string) => void;
  onQuickEdit: (rel: string) => void;
  onExternal: (rel: string) => void;
  onCopy: (rel: string) => void;
  onSearch: (query: string) => void;
  renderRows: (rel: string, depth: number) => React.ReactNode;
}) {
  const pad = { paddingLeft: 14 + depth * 14 };
  if (entry.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          className="ex-row ex-dir"
          style={pad}
          onClick={() => onToggle(entry.relativePath)}
          aria-expanded={open}
        >
          <span className={`ex-caret ${open ? "open" : ""}`}>▸</span>
          {entry.name}
        </button>
        {open && renderRows(entry.relativePath, depth + 1)}
      </div>
    );
  }
  return (
    <div className="ex-row ex-file-row" style={pad}>
      <button
        type="button"
        className="ex-file"
        onClick={() => onQuickEdit(entry.relativePath)}
        title={
          entry.editable
            ? `Quick Edit ${entry.relativePath}`
            : `${entry.relativePath} — not editable in RootRay`
        }
        disabled={!entry.editable}
      >
        {entry.name}
      </button>
      <span className="ex-actions">
        <button
          type="button"
          className="icon-btn"
          title="Search in project"
          aria-label={`Search for ${entry.name} in project`}
          onClick={() => onSearch(entry.name.replace(/\.[^.]+$/, ""))}
        >
          ⌕
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Open in external editor"
          aria-label={`Open ${entry.name} in external editor`}
          onClick={() => onExternal(entry.relativePath)}
        >
          ↗
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Copy relative path"
          aria-label={`Copy path of ${entry.name}`}
          onClick={() => onCopy(entry.relativePath)}
        >
          ⧉
        </button>
      </span>
    </div>
  );
}
