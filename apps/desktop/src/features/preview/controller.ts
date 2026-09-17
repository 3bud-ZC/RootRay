/**
 * Embedded-preview orchestration — owns the calls that create, position
 * and tear down the native child webview so components stay declarative.
 *
 * The preview is a native surface, not DOM: it must be told exactly where
 * its layout rectangle is (logical px, same space as getBoundingClientRect)
 * and hidden whenever a React overlay needs the pixels it occupies.
 */

import { isLoopbackUrl } from "@rootray/shared";
import {
  type PreviewRect,
  previewCreate,
  previewDispose,
  previewHide,
  previewMarkStopped,
  previewMarkWaiting,
  previewSetBounds,
  previewShow,
} from "../../lib/ipc";

/** The last rect the host div reported — lets lifecycle calls find the
 *  surface's home even before the next ResizeObserver tick. */
let lastRect: PreviewRect | null = null;

export function reportPreviewRect(rect: PreviewRect | null) {
  lastRect = rect;
}

/** Sub-pixel-safe equality — ResizeObserver fires on real changes only,
 *  this guards the invoke path against meaningless re-sends. */
export function rectChanged(a: PreviewRect | null, b: PreviewRect): boolean {
  if (!a) return true;
  return (
    Math.abs(a.x - b.x) > 0.5 ||
    Math.abs(a.y - b.y) > 0.5 ||
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.height - b.height) > 0.5
  );
}

/**
 * Pushes the host rect to the native surface when it actually moved.
 * Returns the rect that was last sent, for the caller's change tracking.
 */
export async function syncBounds(
  rect: PreviewRect,
  lastSent: PreviewRect | null,
): Promise<PreviewRect> {
  reportPreviewRect(rect);
  if (!rectChanged(lastSent, rect)) return lastSent ?? rect;
  await previewSetBounds(rect);
  return rect;
}

/** Creates the preview at `url` inside `rect`. Loopback-gated — a
 *  non-local URL can never reach the native layer through this path. */
export async function createPreview(url: string, rect: PreviewRect): Promise<void> {
  if (!isLoopbackUrl(url)) throw new Error("preview URL must be loopback http(s)");
  await previewCreate(url, rect);
}

/** Same as createPreview but uses the last reported host rect. */
export async function createPreviewAtLastRect(url: string): Promise<void> {
  if (!lastRect) return;
  await createPreview(url, lastRect);
}

/** Modal/palette coverage: the native surface hides while a React
 *  overlay owns its pixels, then restores on demand. */
export const hidePreview = () => previewHide().catch(() => {});
export const showPreview = () => previewShow().catch(() => {});

export const markPreviewWaiting = () => previewMarkWaiting().catch(() => {});
export const markPreviewStopped = () => previewMarkStopped().catch(() => {});
export const disposePreview = () => previewDispose().catch(() => {});
