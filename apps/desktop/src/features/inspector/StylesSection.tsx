import type { BoxModel, StyleDetails } from "@rootray/shared";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";
import { usePreferredLauncher } from "./useLauncher";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Compact visual box model: margin ⊃ border ⊃ padding ⊃ content. */
export function BoxModelView({ box }: { box: BoxModel }) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: decorative box-model diagram; contents are readable text
    <div className="boxmodel" aria-label="Box model">
      <div className="bm-margin">
        <span className="bm-label">margin</span>
        <span className="bm-v bm-t">{fmt(box.margin.top)}</span>
        <span className="bm-v bm-r">{fmt(box.margin.right)}</span>
        <span className="bm-v bm-b">{fmt(box.margin.bottom)}</span>
        <span className="bm-v bm-l">{fmt(box.margin.left)}</span>
        <div className="bm-border">
          <span className="bm-label">border</span>
          <span className="bm-v bm-t">{fmt(box.border.top)}</span>
          <span className="bm-v bm-r">{fmt(box.border.right)}</span>
          <span className="bm-v bm-b">{fmt(box.border.bottom)}</span>
          <span className="bm-v bm-l">{fmt(box.border.left)}</span>
          <div className="bm-padding">
            <span className="bm-label">padding</span>
            <span className="bm-v bm-t">{fmt(box.padding.top)}</span>
            <span className="bm-v bm-r">{fmt(box.padding.right)}</span>
            <span className="bm-v bm-b">{fmt(box.padding.bottom)}</span>
            <span className="bm-v bm-l">{fmt(box.padding.left)}</span>
            <div className="bm-content">
              {fmt(box.width)} × {fmt(box.height)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Styles section of the selected-element card: classes, box model,
 * curated computed styles and matched CSS rules — with safe navigation
 * to stylesheet sources when the runtime resolved one reliably.
 */
export function StylesSection({
  styles,
  onSearch,
}: {
  styles: StyleDetails;
  onSearch: (query: string) => void;
}) {
  const { state, dispatch } = useStore();
  const launcher = usePreferredLauncher();

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const openStyle = (path: string) =>
    void quickEdit(state, dispatch, path, { relativePath: path, line: 1, column: 1 });

  return (
    <div className="intel-section">
      <h4 className="section-title">Styles</h4>

      {styles.classes.length > 0 && (
        <div className="styles-group">
          <span className="muted styles-label">Classes</span>
          <div className="class-chips">
            {styles.classes.map((c) => (
              <span key={c} className="class-chip">
                <code>{c}</code>
                <button
                  type="button"
                  className="chip-btn"
                  title={`Copy ${c}`}
                  aria-label={`Copy class ${c}`}
                  onClick={() => copy(c)}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  title={`Search project for ${c}`}
                  aria-label={`Search project for class ${c}`}
                  onClick={() => onSearch(c)}
                >
                  ⌕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {styles.elementId && (
        <div className="styles-group">
          <span className="muted styles-label">ID</span>
          <code>#{styles.elementId}</code>
        </div>
      )}

      <div className="styles-group">
        <span className="muted styles-label">Box model</span>
        <BoxModelView box={styles.box} />
        <div className="muted bm-pos">
          x {fmt(styles.box.x)} · y {fmt(styles.box.y)}
        </div>
      </div>

      {Object.keys(styles.computed).length > 0 && (
        <div className="styles-group">
          <span className="muted styles-label">Computed</span>
          <div className="computed-grid">
            {Object.entries(styles.computed).map(([k, v]) => (
              <div key={k} className="computed-row">
                <span className="computed-prop muted">{k}</span>
                <span className="computed-val" title={v}>
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {styles.matchedRules.length > 0 && (
        <div className="styles-group">
          <span className="muted styles-label">Matched rules</span>
          <ul className="rule-list">
            {styles.matchedRules.map((r, i) => (
              <li key={`${r.selector}-${i}`} className="rule">
                <code className="rule-sel">{r.selector}</code>
                <span className="rule-actions">
                  {r.sourcePath ? (
                    <>
                      <button
                        type="button"
                        className="link-btn"
                        title={`Quick Edit ${r.sourcePath}`}
                        onClick={() => openStyle(r.sourcePath as string)}
                      >
                        {r.sourcePath}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Open stylesheet in external editor"
                        aria-label={`Open ${r.sourcePath} externally`}
                        onClick={() => launcher?.openAt(r.sourcePath as string, 1, 1)}
                      >
                        ↗
                      </button>
                    </>
                  ) : (
                    <span className="muted">source unresolved</span>
                  )}
                </span>
                <div className="rule-decls muted">
                  {r.declarations
                    .map((d) => `${d.property}: ${d.value}${d.important ? " !important" : ""}`)
                    .join("; ")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
