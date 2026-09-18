/**
 * Drag divider for the workbench panes.
 *
 * Native child webviews are separate HWNDs: while the pointer is over
 * the preview surface the main webview receives no mouse events at all.
 * So a drag that could cross the preview must hide the surface first —
 * `onDragState` reports start/end and the parent handles hide/show.
 */

import { useCallback, useRef, useState } from "react";

export function Splitter({
  onDelta,
  onDragState,
  onNudge,
  onReset,
  orientation = "vertical",
  label,
  valueNow,
  valueMin,
  valueMax,
  valueText,
}: {
  /** Pixels moved since drag start — parent applies them to its width. */
  onDelta: (d: number) => void;
  /** true on drag start, false on release — used to hide the preview. */
  onDragState: (dragging: boolean) => void;
  /** Keyboard nudge in value space — positive grows the pane. */
  onNudge: (d: number) => void;
  /** Double-click restore (e.g. reset to the default size). */
  onReset?: () => void;
  /**
   * "vertical" = upright divider between columns (drag on X);
   * "horizontal" = flat divider between rows (drag on Y).
   */
  orientation?: "vertical" | "horizontal";
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  valueText?: string;
}) {
  const startPos = useRef(0);
  const [dragging, setDragging] = useState(false);
  const horizontal = orientation === "horizontal";

  const moveRef = useRef<(e: MouseEvent) => void>(() => {});
  const upRef = useRef(() => {});

  const end = useCallback(() => {
    setDragging(false);
    onDragState(false);
    window.removeEventListener("mousemove", moveRef.current);
    window.removeEventListener("mouseup", upRef.current);
  }, [onDragState]);

  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = horizontal ? e.clientY : e.clientX;
    setDragging(true);
    onDragState(true);
    moveRef.current = (ev: MouseEvent) =>
      onDelta((horizontal ? ev.clientY : ev.clientX) - startPos.current);
    upRef.current = () => end();
    window.addEventListener("mousemove", moveRef.current);
    window.addEventListener("mouseup", upRef.current);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const prevKey = horizontal ? "ArrowUp" : "ArrowLeft";
    const nextKey = horizontal ? "ArrowDown" : "ArrowRight";
    if (e.key === prevKey) {
      e.preventDefault();
      onNudge(-16);
    } else if (e.key === nextKey) {
      e.preventDefault();
      onNudge(16);
    }
  };

  return (
    <hr
      className={`splitter splitter-${orientation} ${dragging ? "dragging" : ""}`}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuetext={valueText}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
