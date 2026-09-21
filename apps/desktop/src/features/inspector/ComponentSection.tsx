import type { SourceLocation } from "@rootray/shared";
import { useEffect, useState } from "react";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";
import { type ComponentSummary, describeComponent } from "../intelligence/controller";

/**
 * Component intelligence for the selected element: the owning
 * component's definition and every resolved caller, each navigable via
 * Quick Edit. Unresolved cases are labeled, never fabricated.
 */
export function ComponentSection({ source }: { source: SourceLocation }) {
  const { state, dispatch } = useStore();
  const root = state.runtime.workspace?.root ?? "";
  const [summary, setSummary] = useState<ComponentSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const name = source.componentName;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the selected element's source changes so a post-edit selection refreshes intelligence
  useEffect(() => {
    let live = true;
    setSummary(null);
    setFailed(false);
    if (!root || !name) return;
    describeComponent(root, name, source.relativePath)
      .then((s) => live && setSummary(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [root, name, source.relativePath, source.line]);

  if (!name) return null;

  const open = (path: string, line: number, column: number) =>
    void quickEdit(state, dispatch, path, { relativePath: path, line, column });

  const def = summary?.def ?? null;
  const usedBy = summary?.usedBy ?? [];

  return (
    <div className="intel-section inspector-detail-body">
      <div className="intel-name">{name}</div>
      {failed && <p className="muted">Component analysis unavailable.</p>}
      {summary && !def && <p className="muted">Definition not resolved in analyzed sources.</p>}
      {def && (
        <>
          <div className="intel-row">
            <span className="muted">Defined</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => open(def.path, def.line, def.column)}
            >
              {def.path}:{def.line}
            </button>
            <span className="muted">({def.kind})</span>
          </div>
          {usedBy.length > 0 && (
            <div className="intel-usedby">
              <span className="muted">Used by</span>
              <ul>
                {usedBy.map((u) => (
                  <li key={`${u.path}:${u.line}:${u.column}`}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => open(u.path, u.line, u.column)}
                    >
                      {u.path}:{u.line}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {summary?.truncated && <p className="muted">Analysis truncated at project-size caps.</p>}
    </div>
  );
}
