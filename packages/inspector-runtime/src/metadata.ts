/**
 * Reads RootRay instrumentation metadata off real DOM elements.
 * Framework-independent — only DOM APIs and `data-rootray-*` attributes.
 */

import type { ElementFacts, SourceLocation } from "@rootray/source-protocol";
import { fiberComponentName } from "./fiber";

export const ATTR_FILE = "data-rootray-file";
export const ATTR_LINE = "data-rootray-line";
export const ATTR_COLUMN = "data-rootray-column";
export const ATTR_COMPONENT = "data-rootray-component";

/** CSS selector matching any instrumented element. */
export const INSTRUMENTED_SELECTOR = `[${ATTR_FILE}]`;

const MAX_TEXT_PREVIEW = 80;
const MAX_FIELD = 256;

/** Walks up from `target` to the nearest instrumented ancestor (inclusive). */
export function findInstrumentedElement(target: unknown): Element | null {
  if (
    target &&
    typeof target === "object" &&
    "closest" in target &&
    typeof (target as Element).closest === "function"
  ) {
    return (target as Element).closest(INSTRUMENTED_SELECTOR);
  }
  return null;
}

/**
 * Project-relative path contract — mirrors `is_safe_relative_path` in
 * `crates/rootray-core/src/inspector/protocol.rs` and the validator in
 * `@rootray/source-protocol`. Stamped metadata is untrusted input: a
 * value that doesn't satisfy this is dropped, never interpreted.
 */
export function isSafeRelativePath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= MAX_FIELD &&
    !p.includes("..") &&
    !p.includes("\\") &&
    !p.startsWith("/") &&
    !/^[a-zA-Z]:/.test(p)
  );
}

/**
 * Extracts the source identity stamped on an element by instrumentation.
 * Reads THIS element only — no ancestor walk — so a dynamically created
 * node never inherits a misleading mapping from an authored container.
 */
export function readSourceLocation(el: Element): SourceLocation | null {
  const file = el.getAttribute(ATTR_FILE);
  if (!file || !isSafeRelativePath(file)) return null;
  const line = Number(el.getAttribute(ATTR_LINE));
  const column = Number(el.getAttribute(ATTR_COLUMN));
  if (!Number.isInteger(line) || line < 1) return null;
  if (!Number.isInteger(column) || column < 1) return null;
  const component = el.getAttribute(ATTR_COMPONENT);
  const loc: SourceLocation = { relativePath: file, line, column, confidence: "exact" };
  if (component && component.length <= MAX_FIELD) {
    loc.componentName = component;
  } else {
    // Attrs give the exact JSX site but not always a name (e.g. anonymous
    // scopes); the dev-only fiber owner chain can still identify it.
    const hinted = fiberComponentName(el);
    if (hinted) loc.componentName = hinted;
  }
  return loc;
}

/** Builds the compact, bounded element description sent with a selection. */
export function elementFacts(el: Element): ElementFacts {
  const facts: ElementFacts = { tagName: el.tagName.toLowerCase().slice(0, 64) };
  if (el.id) facts.id = el.id.slice(0, MAX_FIELD);
  const cls = typeof el.className === "string" ? el.className : el.getAttribute("class");
  if (cls) facts.className = cls.trim().slice(0, MAX_FIELD);
  const text = collapseWhitespace(el.textContent ?? "");
  if (text) facts.textPreview = text.slice(0, MAX_TEXT_PREVIEW);
  return facts;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
