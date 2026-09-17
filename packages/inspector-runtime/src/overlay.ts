/**
 * RootRay inspection overlay — a Shadow-DOM-isolated, fixed-position
 * highlight box + source label. Zero layout impact on the inspected page:
 * everything is `position: fixed`, `pointer-events: none`, injected on
 * `documentElement` (not `body`) and fully removed on destroy.
 */

import type { ElementFacts, SourceLocation } from "@rootray/source-protocol";

export const OVERLAY_HOST_ATTR = "data-rootray-overlay";

const STYLES = `
  .rr-box {
    position: fixed;
    border: 2px solid #4f8cff;
    background: rgba(79, 140, 255, 0.12);
    border-radius: 2px;
    pointer-events: none;
    z-index: 2147483647;
    display: none;
  }
  .rr-label {
    position: fixed;
    pointer-events: none;
    z-index: 2147483647;
    display: none;
    font: 11px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: #e8ecf4;
    background: #11151d;
    border: 1px solid #2a3244;
    border-radius: 4px;
    padding: 3px 7px;
    max-width: 420px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rr-label .rr-name { color: #8fb8ff; font-weight: 600; }
  .rr-label .rr-loc { color: #9aa4b8; }
`;

export class InspectorOverlay {
  private host: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;
  private labelName: HTMLSpanElement | null = null;
  private labelLoc: HTMLSpanElement | null = null;
  private target: Element | null = null;
  private doc: Document;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  /** Idempotent attach — safe to call more than once. */
  attach(): void {
    if (this.host) return;
    const host = this.doc.createElement("div");
    host.setAttribute(OVERLAY_HOST_ATTR, "");
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = STYLES;
    this.box = this.doc.createElement("div");
    this.box.className = "rr-box";
    this.label = this.doc.createElement("div");
    this.label.className = "rr-label";
    this.labelName = this.doc.createElement("span");
    this.labelName.className = "rr-name";
    this.labelLoc = this.doc.createElement("span");
    this.labelLoc.className = "rr-loc";
    this.label.append(this.labelName, this.labelLoc);
    shadow.append(style, this.box, this.label);
    this.doc.documentElement.appendChild(host);
    this.host = host;
  }

  /**
   * Highlights `el` and shows its label. `source` may be null — a
   * runtime-created DOM element has no authored location and the label
   * says so instead of hiding the highlight.
   */
  show(el: Element, facts: ElementFacts, source: SourceLocation | null): void {
    this.attach();
    this.target = el;
    if (this.labelName) this.labelName.textContent = source?.componentName ?? facts.tagName;
    if (this.labelLoc) {
      this.labelLoc.textContent = source
        ? `  ${source.relativePath}:${source.line}`
        : "  no source";
    }
    this.render();
  }

  hide(): void {
    this.target = null;
    if (this.box) this.box.style.display = "none";
    if (this.label) this.label.style.display = "none";
  }

  /** Recomputes geometry for the current target (scroll/resize). */
  refresh(): void {
    if (this.target) this.render();
  }

  private render(): void {
    if (!this.target || !this.box || !this.label) return;
    const rect = this.target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hide();
      return;
    }
    this.box.style.display = "block";
    this.box.style.left = `${rect.left}px`;
    this.box.style.top = `${rect.top}px`;
    this.box.style.width = `${rect.width}px`;
    this.box.style.height = `${rect.height}px`;

    this.label.style.display = "block";
    const labelHeight = 24;
    const above = rect.top >= labelHeight + 6;
    this.label.style.left = `${Math.max(4, rect.left)}px`;
    this.label.style.top = above ? `${rect.top - labelHeight - 4}px` : `${rect.bottom + 4}px`;
  }

  /** Removes every injected node. The page is left untouched. */
  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.box = null;
    this.label = null;
    this.labelName = null;
    this.labelLoc = null;
    this.target = null;
  }
}
