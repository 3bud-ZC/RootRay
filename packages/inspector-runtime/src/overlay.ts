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
    border: 1.5px solid #ff6b0c;
    background: rgba(255, 107, 12, 0.08);
    box-shadow: 0 0 12px rgba(255, 107, 12, 0.25), inset 0 0 8px rgba(255, 107, 12, 0.12);
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
    font: 11px/1.4 ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
    color: #e8ecf4;
    background: rgba(13, 15, 18, 0.94);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 107, 12, 0.38);
    border-radius: 4px;
    padding: 3px 8px;
    max-width: 460px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6), 0 0 8px rgba(255, 107, 12, 0.2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rr-label .rr-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #ff6b0c;
    box-shadow: 0 0 6px #ff6b0c;
    margin-right: 6px;
    vertical-align: middle;
  }
  .rr-label .rr-name { color: #ff9d5c; font-weight: 600; }
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
    const dot = this.doc.createElement("span");
    dot.className = "rr-dot";
    dot.setAttribute("aria-hidden", "true");
    this.labelName = this.doc.createElement("span");
    this.labelName.className = "rr-name";
    this.labelLoc = this.doc.createElement("span");
    this.labelLoc.className = "rr-loc";
    this.label.append(dot, this.labelName, this.labelLoc);
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
