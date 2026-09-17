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
  label,
  valueNow,
  valueMin,
  valueMax,
}: {
  /** Pixels moved since drag start — parent applies them to its width. */
  onDelta: (dx: number) => void;
  /** true on drag start, false on release — used to hide the preview. */
  onDragState: (dragging: boolean) => void;
  /** Keyboard nudge in value space — positive grows the pane. */
  onNudge: (d: number) => void;
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
}) {
  const startX = useRef(0);
  const [dragging, setDragging] = useState(false);

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
    startX.current = e.clientX;
    setDragging(true);
    onDragState(true);
    moveRef.current = (ev: MouseEvent) => onDelta(ev.clientX - startX.current);
    upRef.current = () => end();
    window.addEventListener("mousemove", moveRef.current);
    window.addEventListener("mouseup", upRef.current);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNudge(-16);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(16);
    }
  };

  return (
    <hr
      className={`splitter ${dragging ? "dragging" : ""}`}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      tabIndex={0}
      onMouseDown={start}
      onKeyDown={onKeyDown}
    />
  );
}
