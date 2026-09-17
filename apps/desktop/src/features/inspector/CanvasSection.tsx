/**
 * Canvas context — what RootRay can and cannot say about a <canvas>.
 *
 * A canvas is one DOM element; the game/objects rendered inside it are
 * runtime pixels, not DOM nodes. RootRay never fabricates a source for
 * drawn content. What we CAN honestly report:
 *
 * - the canvas element itself — authored source when stamped, unresolved
 *   when runtime-created;
 * - that its contents are runtime-rendered (not a bug, a fact of canvas);
 * - when Phaser is detected in the project, a bounded list of *possible*
 *   related files — candidates found by static search, explicitly NOT
 *   labeled as the selected element's source.
 */

import { activeTarget, errorMessage } from "@rootray/shared";
import { useEffect, useState } from "react";
import { searchWorkspace } from "../../lib/ipc";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";

const MAX_CANDIDATES = 6;

export function CanvasSection({ hasSource }: { hasSource: boolean }) {
  const { state, dispatch } = useStore();
  const [candidates, setCandidates] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const workspace = state.runtime.workspace;
  const target = workspace ? activeTarget(workspace) : null;
  const isPhaser =
    target?.technologies.some((t) => /phaser/i.test(t.name)) ??
    workspace?.technologies.some((t) => /phaser/i.test(t.name)) ??
    false;

  // Static candidates: files that construct or configure Phaser. These are
  // evidence of where the canvas came from — not a source mapping.
  useEffect(() => {
    if (!isPhaser) return;
    let cancelled = false;
    setSearching(true);
    Promise.all([searchWorkspace("Phaser.Scene"), searchWorkspace("new Phaser.Game")])
      .then(([a, b]) => {
        if (cancelled) return;
        const files = [...a.matches, ...b.matches]
          .map((m) => m.relativePath)
          .filter((p, i, arr) => arr.indexOf(p) === i)
          .slice(0, MAX_CANDIDATES);
        setCandidates(files);
      })
      .catch((e) => dispatch({ type: "notice", message: errorMessage(e) }))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [isPhaser, dispatch]);

  return (
    <div className="canvas-section">
      <h4 className="section-title">Canvas</h4>
      <p className="muted">
        Canvas contents are runtime-rendered pixels — individual game objects are not DOM nodes
        {hasSource ? "" : ", and this canvas was created at runtime"}.
      </p>
      {isPhaser && (
        <div className="canvas-phaser">
          <div className="canvas-fw">
            Framework: <code>Phaser</code>
          </div>
          {(candidates.length > 0 || searching) && (
            <>
              <div className="muted canvas-candidates-label">Possible related files</div>
              <ul className="canvas-candidates">
                {searching && candidates.length === 0 && <li className="muted">Searching…</li>}
                {candidates.map((rel) => (
                  <li key={rel}>
                    <button
                      type="button"
                      className="canvas-candidate"
                      onClick={() =>
                        quickEdit(state, dispatch, rel, {
                          relativePath: rel,
                          line: 1,
                          column: 1,
                        })
                      }
                    >
                      {rel}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
