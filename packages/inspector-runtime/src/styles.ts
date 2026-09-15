/**
 * Style details for the SELECTED element.
 *
 * Runs only on click-selection — never on hover — so there is no
 * continuous style traffic. Everything collected here is read-only DOM /
 * CSSOM data; the runtime never gains a privileged capability.
 *
 * Stylesheet source hints are normalized to project-relative paths
 * before leaving the page — absolute filesystem paths never cross the
 * bridge.
 */

import type {
  BoxEdges,
  BoxModel,
  CssDeclaration,
  MatchedCssRule,
  StyleDetails,
} from "@rootray/source-protocol";

const MAX_CLASSES = 32;
const MAX_RULES = 24;
const MAX_DECLS = 32;
const MAX_LEN = 512;

/** Curated computed-style properties — a useful subset, not a dump. */
const COMPUTED_PROPS = [
  "display",
  "position",
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "width",
  "height",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "gridTemplateColumns",
  "borderRadius",
  "opacity",
  "overflow",
  "margin",
  "padding",
] as const;
const MAX_COMPUTED = 24;

function px(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function edges(cs: CSSStyleDeclaration, prefix: "margin" | "padding" | "border"): BoxEdges {
  const key = (side: string) => (prefix === "border" ? `border${side}Width` : `${prefix}${side}`);
  return {
    top: px(cs.getPropertyValue(key("Top")) || cs[key("Top") as never] || "0"),
    right: px(cs.getPropertyValue(key("Right")) || "0"),
    bottom: px(cs.getPropertyValue(key("Bottom")) || "0"),
    left: px(cs.getPropertyValue(key("Left")) || "0"),
  };
}

/**
 * Normalizes a stylesheet identifier to a project-relative path, or
 * null when it cannot be trusted. Vite stamps `data-vite-dev-id` with
 * the module's absolute (or root-relative) id; `<link>` sheets resolve
 * against the dev server origin. Anything that doesn't map inside the
 * project is reported as unresolved — never guessed.
 */
export function stylesheetSourcePath(
  sheet: CSSStyleSheet | null,
  projectRoot: string,
): string | undefined {
  const owner = sheet?.ownerNode;
  if (!owner || typeof owner !== "object" || !("ownerDocument" in owner)) return undefined;

  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const asRelative = (raw: string): string | undefined => {
    const p = raw.replace(/\\/g, "/");
    let rel: string | undefined;
    if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      rel = p.slice(root.length + 1);
    } else if (p.startsWith("/") && !p.startsWith("//")) {
      // Dev-server root-relative URL path (/src/styles/x.css).
      rel = p.replace(/^\/+/, "");
      if (rel.startsWith("@fs/") || rel.startsWith("@id/")) return undefined;
    }
    if (!rel || rel.includes("..") || /^[a-zA-Z]:/.test(rel) || rel.includes("\\")) {
      return undefined;
    }
    return rel.length <= MAX_LEN ? rel : undefined;
  };

  if (owner instanceof Element) {
    const devId = owner.getAttribute("data-vite-dev-id");
    if (devId) {
      const rel = asRelative(devId.split("?")[0] ?? devId);
      if (rel) return rel;
    }
    if (owner instanceof HTMLLinkElement && owner.href) {
      try {
        const url = new URL(owner.href);
        if (url.origin === window.location.origin) {
          return asRelative(decodeURIComponent(url.pathname));
        }
      } catch {
        /* malformed href — fall through */
      }
    }
  }
  return undefined;
}

function declarationsOf(rule: CSSStyleRule): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  const style = rule.style;
  const n = Math.min(style.length, MAX_DECLS);
  for (let i = 0; i < n; i++) {
    const property = style.item(i);
    if (!property) continue;
    out.push({
      property: property.slice(0, MAX_LEN),
      value: (style.getPropertyValue(property) ?? "").slice(0, MAX_LEN),
      important: style.getPropertyPriority(property) === "important",
    });
  }
  return out;
}

function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false; // selector list with pseudo-elements etc.
  }
}

function collectRules(
  el: Element,
  rules: CSSRuleList,
  sheet: CSSStyleSheet,
  projectRoot: string,
  out: MatchedCssRule[],
  depth: number,
): void {
  if (out.length >= MAX_RULES || depth > 3) return;
  for (const rule of Array.from(rules)) {
    if (out.length >= MAX_RULES) return;
    if (rule instanceof CSSStyleRule) {
      if (matches(el, rule.selectorText)) {
        const matched: MatchedCssRule = {
          selector: rule.selectorText.slice(0, MAX_LEN),
          declarations: declarationsOf(rule),
        };
        const src = stylesheetSourcePath(sheet, projectRoot);
        if (src) matched.sourcePath = src;
        out.push(matched);
      }
    } else {
      const grouped = rule as CSSRule & { cssRules?: CSSRuleList };
      if (grouped.cssRules) {
        collectRules(el, grouped.cssRules, sheet, projectRoot, out, depth + 1);
      }
    }
  }
}

/**
 * Collects the bounded style snapshot for a selected element.
 * Returns null when the platform can't provide computed styles.
 */
export function collectStyleDetails(el: Element, projectRoot: string): StyleDetails | null {
  let cs: CSSStyleDeclaration;
  let rect: DOMRect;
  try {
    cs = getComputedStyle(el);
    rect = el.getBoundingClientRect();
  } catch {
    return null;
  }

  const classes = Array.from(el.classList)
    .filter((c) => typeof c === "string" && c.length > 0)
    .slice(0, MAX_CLASSES);

  const box: BoxModel = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    margin: edges(cs, "margin"),
    padding: edges(cs, "padding"),
    border: edges(cs, "border"),
  };

  const computed: Record<string, string> = {};
  for (const prop of COMPUTED_PROPS.slice(0, MAX_COMPUTED)) {
    const v = cs.getPropertyValue(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    if (v) computed[prop] = v.slice(0, MAX_LEN);
  }

  const matchedRules: MatchedCssRule[] = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      if (matchedRules.length >= MAX_RULES) break;
      let rules: CSSRuleList;
      try {
        // Inaccessible/cross-origin sheets throw SecurityError — skip.
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      collectRules(el, rules, sheet as CSSStyleSheet, projectRoot, matchedRules, 0);
    }
  } catch {
    /* stylesheet enumeration failed — return what we have */
  }

  const details: StyleDetails = { classes, box, computed, matchedRules };
  if (el.id) details.elementId = el.id.slice(0, MAX_LEN);
  return details;
}
