/**
 * Workbench layout state — purely frontend. Pane visibility, widths,
 * the preview/code split ratio and transient focus modes live here;
 * runtime/project truth stays in the core state machine.
 *
 * Persisted subset (localStorage `rootray.layout.v1`): visibility,
 * widths, output height, split ratio. Focus mode and responsive
 * auto-hides are session-only and never written.
 */

export type FocusMode = "none" | "preview" | "code";

export interface WorkbenchLayout {
  explorerVisible: boolean;
  inspectorVisible: boolean;
  /** Output expanded; false leaves only the header bar. */
  outputVisible: boolean;
  explorerWidth: number;
  inspectorWidth: number;
  outputHeight: number;
  /** Preview fraction of the preview/code row in Split mode. */
  splitRatio: number;
  focusMode: FocusMode;
  /** Narrow-window auto-hides — applied on top of user visibility. */
  autoExplorer: boolean;
  autoInspector: boolean;
}

export const EXPLORER_MIN = 160;
export const EXPLORER_MAX = 480;
export const INSPECTOR_MIN = 220;
export const INSPECTOR_MAX = 560;
export const OUTPUT_MIN = 80;
export const OUTPUT_MAX = 480;
export const SPLIT_MIN = 0.1;
export const SPLIT_MAX = 0.9;
/** Minimum pixel floor for each half of the split row (drag clamp). */
export const PREVIEW_MIN_PX = 200;
export const CODE_MIN_PX = 220;

export const LAYOUT_DEFAULTS: WorkbenchLayout = {
  explorerVisible: true,
  inspectorVisible: true,
  outputVisible: false,
  explorerWidth: 220,
  inspectorWidth: 320,
  outputHeight: 170,
  splitRatio: 0.55,
  focusMode: "none",
  autoExplorer: false,
  autoInspector: false,
};

const STORAGE_KEY = "rootray.layout.v1";

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function clampBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Reads the persisted layout. Corrupt, outdated or out-of-range values
 * fall back to defaults field-by-field — a bad stored width must never
 * make a pane unreachable.
 */
export function loadLayout(): Pick<
  WorkbenchLayout,
  | "explorerVisible"
  | "inspectorVisible"
  | "outputVisible"
  | "explorerWidth"
  | "inspectorWidth"
  | "outputHeight"
  | "splitRatio"
> {
  const d = LAYOUT_DEFAULTS;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return pickPersisted(d);
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      explorerVisible: clampBool(j.explorerVisible, d.explorerVisible),
      inspectorVisible: clampBool(j.inspectorVisible, d.inspectorVisible),
      outputVisible: clampBool(j.outputVisible, d.outputVisible),
      explorerWidth: clampNum(j.explorerWidth, EXPLORER_MIN, EXPLORER_MAX, d.explorerWidth),
      inspectorWidth: clampNum(j.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX, d.inspectorWidth),
      outputHeight: clampNum(j.outputHeight, OUTPUT_MIN, OUTPUT_MAX, d.outputHeight),
      splitRatio: clampNum(j.splitRatio, SPLIT_MIN, SPLIT_MAX, d.splitRatio),
    };
  } catch {
    return pickPersisted(d);
  }
}

function pickPersisted(l: WorkbenchLayout) {
  return {
    explorerVisible: l.explorerVisible,
    inspectorVisible: l.inspectorVisible,
    outputVisible: l.outputVisible,
    explorerWidth: l.explorerWidth,
    inspectorWidth: l.inspectorWidth,
    outputHeight: l.outputHeight,
    splitRatio: l.splitRatio,
  };
}

/** Writes only the persisted subset — focus/auto state stays in memory. */
export function persistLayout(l: WorkbenchLayout): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(pickPersisted(l)));
  } catch {
    // Storage denied/full — layout still works for the session.
  }
}

/** Clamp a partial update into valid ranges. */
export function clampLayoutPatch(p: Partial<WorkbenchLayout>): Partial<WorkbenchLayout> {
  const out = { ...p };
  if (out.explorerWidth !== undefined)
    out.explorerWidth = Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, out.explorerWidth));
  if (out.inspectorWidth !== undefined)
    out.inspectorWidth = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, out.inspectorWidth));
  if (out.outputHeight !== undefined)
    out.outputHeight = Math.min(OUTPUT_MAX, Math.max(OUTPUT_MIN, out.outputHeight));
  if (out.splitRatio !== undefined)
    out.splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, out.splitRatio));
  return out;
}
