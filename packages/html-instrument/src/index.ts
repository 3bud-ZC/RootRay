/**
 * @rootray/html-instrument — parser-based HTML source instrumentation.
 *
 * Stamps `data-rootray-file` / `-line` / `-column` onto authored HTML
 * elements so the inspector runtime can map DOM selections back to the
 * exact tag in the HTML source. Used by the Vite plugin's
 * `transformIndexHtml` hook; the Rust static server has a native twin in
 * `crates/rootray-core/src/html_instrument.rs` with the same contract.
 *
 * Security model: instrumentation happens at serve time, never inside
 * the page. Any pre-existing `data-rootray-*` attribute in the authored
 * markup is stripped BEFORE stamping, so a document can never spoof a
 * source identity or sneak RootRay metadata into the DOM.
 *
 * The parser is a real HTML5 tree builder (parse5), not regex: comments,
 * CDATA, raw-text script/style bodies, malformed-but-recoverable markup
 * and foreign content (svg/math) are handled by spec parsing and the
 * original byte/line/column locations come from parse5's
 * `sourceCodeLocation` info.
 */

import MagicString from "magic-string";
import type { DefaultTreeAdapterMap } from "parse5";
import { parse } from "parse5";

export const ATTR_FILE = "data-rootray-file";
export const ATTR_LINE = "data-rootray-line";
export const ATTR_COLUMN = "data-rootray-column";
export const ATTR_COMPONENT = "data-rootray-component";

/** Reserved metadata prefix — the page must never author these. */
const RESERVED_PREFIX = "data-rootray";

/**
 * Elements that are never stamped:
 * - non-renderable/structural tags (head internals, script/style…)
 * - `html`/`body` — stamping them would give EVERY element a trivial
 *   `closest([data-rootray-file])` hit, turning source-less dynamic
 *   nodes into falsely "mapped" ones. Source-less is honest; a document-
 *   level catch-all is not.
 */
const SKIP_TAGS = new Set([
  "html",
  "head",
  "body",
  "meta",
  "title",
  "base",
  "link",
  "script",
  "style",
  "noscript",
  "template",
  "frameset",
  "frame",
]);

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Template = DefaultTreeAdapterMap["template"];

export interface HtmlInstrumentResult {
  /** Rewritten HTML. */
  code: string;
  /** Elements stamped with a fresh trusted identity. */
  stamped: number;
  /** Authored `data-rootray-*` attributes removed (spoof attempts). */
  removedReserved: number;
}

function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isElement(node: P5Node): node is P5Element {
  return typeof (node as P5Element).tagName === "string";
}

/**
 * Stamps every authored, stampable element in `code` with source
 * identity. `file` is the target-relative forward-slash path that ends
 * up in `data-rootray-file`.
 *
 * Always returns a result — a document with no stampable elements just
 * reports `stamped: 0`.
 */
export function instrumentHtml(code: string, file: string): HtmlInstrumentResult {
  const doc = parse(code, { sourceCodeLocationInfo: true });
  const ms = new MagicString(code);
  let stamped = 0;
  let removedReserved = 0;

  const visit = (node: P5Node): void => {
    if (isElement(node)) {
      const loc = node.sourceCodeLocation;
      // Strip authored reserved attributes from the start tag — spoof
      // attempts are deleted, never trusted.
      const attrLocs = loc?.attrs;
      if (attrLocs) {
        for (const [name, attrLoc] of Object.entries(attrLocs)) {
          if (name.toLowerCase().startsWith(RESERVED_PREFIX)) {
            ms.remove(attrLoc.startOffset, attrLoc.endOffset);
            removedReserved++;
          }
        }
      }
      if (loc?.startTag && !SKIP_TAGS.has(node.tagName.toLowerCase())) {
        // Insert right after the tag name — before existing attributes —
        // which also lands correctly inside `<tag/>` self-closing syntax.
        const insertAt = loc.startTag.startOffset + 1 + node.tagName.length;
        ms.appendLeft(
          insertAt,
          ` ${ATTR_FILE}="${escapeAttr(file)}"` +
            ` ${ATTR_LINE}="${loc.startTag.startLine}"` +
            ` ${ATTR_COLUMN}="${loc.startTag.startCol}"`,
        );
        stamped++;
      }
      // <template> children live in .content — stamping them means
      // runtime clones still map back to the authored template markup.
      if (node.tagName === "template") {
        for (const child of (node as P5Template).content.childNodes) visit(child);
      }
    }
    const children = (node as { childNodes?: P5Node[] }).childNodes;
    if (children) for (const child of children) visit(child);
  };

  for (const child of doc.childNodes) visit(child);
  return { code: ms.toString(), stamped, removedReserved };
}
