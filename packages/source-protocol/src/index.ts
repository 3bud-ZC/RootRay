/**
 * RootRay inspector wire protocol — version 1.
 *
 * One protocol, two directions over a loopback WebSocket:
 *   runtime → bridge : hello (auth), element selection, goodbye
 *   bridge → runtime : session accept/reject, inspect on/off
 *
 * Everything crossing the trust boundary is validated field-by-field —
 * never `JSON.parse` into a privileged action. The Rust bridge keeps a
 * mirror implementation in `crates/rootray-core/src/inspector/protocol.rs`;
 * the JSON shapes here are the contract.
 */

export const ROOTRAY_PROTOCOL_VERSION = 1;

export const ROOTRAY_BRIDGE_PATH = "/rootray";

// --- shared shapes ----------------------------------------------------------

/** Project-relative source identity of a rendered DOM element. */
export interface SourceLocation {
  /** Forward-slash path relative to the project root — never absolute. */
  relativePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Nearest owning component, when it could be determined reliably. */
  componentName?: string;
}

/** Compact element facts the runtime reports with a selection. */
export interface ElementFacts {
  tagName: string;
  id?: string;
  className?: string;
  /** Bounded plain-text preview (whitespace-collapsed). */
  textPreview?: string;
}

// --- style details (collected on selection only — never on hover) ---------

/** Four CSS box edges in px. */
export interface BoxEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Geometry + box model of the selected element. */
export interface BoxModel {
  x: number;
  y: number;
  width: number;
  height: number;
  margin: BoxEdges;
  padding: BoxEdges;
  border: BoxEdges;
}

export interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
}

/** A CSS rule that actually matched the selected element. */
export interface MatchedCssRule {
  selector: string;
  declarations: CssDeclaration[];
  /**
   * Project-relative stylesheet path when it could be resolved
   * reliably (e.g. a Vite `data-vite-dev-id` hint). Omitted when
   * the rule's source is ambiguous — never a guess.
   */
  sourcePath?: string;
}

/** Bounded style snapshot attached to an element selection. */
export interface StyleDetails {
  /** Actual class tokens on the element (max 32). */
  classes: string[];
  elementId?: string;
  box: BoxModel;
  /** Curated computed-style subset (max 24 entries). */
  computed: Record<string, string>;
  /** Matching CSSOM rules (max 24), cross-origin sheets skipped. */
  matchedRules: MatchedCssRule[];
}

// --- runtime → bridge ---------------------------------------------------------

export interface RuntimeHelloMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "runtime:hello";
  sessionId: string;
  /** Ephemeral auth token issued by RootRay for this session only. */
  token: string;
  pageUrl: string;
}

export interface RuntimeReadyMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "runtime:ready";
  sessionId: string;
}

export interface ElementSelectedMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "element:selected";
  sessionId: string;
  element: ElementFacts;
  source: SourceLocation;
  /** Style snapshot — present when the runtime could collect it. */
  styles?: StyleDetails;
}

/**
 * `inspect:set` travels in both directions:
 *   bridge → runtime : authoritative command
 *   runtime → bridge : request (e.g. the user pressed Escape)
 */
export type RuntimeMessage =
  | RuntimeHelloMessage
  | RuntimeReadyMessage
  | ElementSelectedMessage
  | InspectSetMessage;

// --- bridge → runtime ---------------------------------------------------------

export interface SessionAcceptedMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "session:accepted";
  sessionId: string;
}

export interface SessionRejectedMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "session:rejected";
  reason: string;
}

export interface InspectSetMessage {
  version: typeof ROOTRAY_PROTOCOL_VERSION;
  type: "inspect:set";
  enabled: boolean;
}

export type BridgeMessage = SessionAcceptedMessage | SessionRejectedMessage | InspectSetMessage;

// --- construction helpers -----------------------------------------------------

export function helloMessage(
  sessionId: string,
  token: string,
  pageUrl: string,
): RuntimeHelloMessage {
  return { version: ROOTRAY_PROTOCOL_VERSION, type: "runtime:hello", sessionId, token, pageUrl };
}

export function readyMessage(sessionId: string): RuntimeReadyMessage {
  return { version: ROOTRAY_PROTOCOL_VERSION, type: "runtime:ready", sessionId };
}

export function elementSelectedMessage(
  sessionId: string,
  element: ElementFacts,
  source: SourceLocation,
  styles?: StyleDetails,
): ElementSelectedMessage {
  const msg: ElementSelectedMessage = {
    version: ROOTRAY_PROTOCOL_VERSION,
    type: "element:selected",
    sessionId,
    element,
    source,
  };
  if (styles) msg.styles = styles;
  return msg;
}

export function inspectSetMessage(enabled: boolean): InspectSetMessage {
  return { version: ROOTRAY_PROTOCOL_VERSION, type: "inspect:set", enabled };
}

// --- validation -----------------------------------------------------------------

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: string };

const MAX_TEXT_PREVIEW = 200;
const MAX_STRING_FIELD = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING_FIELD;
}

function optStr(v: unknown): v is string | undefined {
  return v === undefined || (typeof v === "string" && v.length <= MAX_STRING_FIELD);
}

function intAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

function versionOk(v: unknown): boolean {
  return v === ROOTRAY_PROTOCOL_VERSION;
}

export function parseSourceLocation(v: unknown): SourceLocation | null {
  if (!isRecord(v)) return null;
  if (!str(v.relativePath)) return null;
  if (v.relativePath.includes("..") || v.relativePath.includes("\\")) return null;
  if (/^[a-zA-Z]:/.test(v.relativePath) || v.relativePath.startsWith("/")) return null;
  if (!intAtLeast(v.line, 1) || !intAtLeast(v.column, 1)) return null;
  if (!optStr(v.componentName)) return null;
  const out: SourceLocation = {
    relativePath: v.relativePath,
    line: v.line,
    column: v.column,
  };
  if (typeof v.componentName === "string") out.componentName = v.componentName;
  return out;
}

export function parseElementFacts(v: unknown): ElementFacts | null {
  if (!isRecord(v)) return null;
  if (!str(v.tagName) || v.tagName.length > 64) return null;
  if (!optStr(v.id) || !optStr(v.className) || !optStr(v.textPreview)) return null;
  const out: ElementFacts = { tagName: v.tagName };
  if (typeof v.id === "string" && v.id) out.id = v.id;
  if (typeof v.className === "string" && v.className) out.className = v.className;
  if (typeof v.textPreview === "string" && v.textPreview) {
    out.textPreview = v.textPreview.slice(0, MAX_TEXT_PREVIEW);
  }
  return out;
}

const MAX_STYLE_CLASSES = 32;
const MAX_STYLE_RULES = 24;
const MAX_STYLE_DECLS = 32;
const MAX_STYLE_COMPUTED = 24;
const MAX_STYLE_STRING = 512;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseEdges(v: unknown): BoxEdges | null {
  if (!isRecord(v)) return null;
  const { top, right, bottom, left } = v;
  if (!isFiniteNum(top) || !isFiniteNum(right) || !isFiniteNum(bottom) || !isFiniteNum(left)) {
    return null;
  }
  return { top, right, bottom, left };
}

/**
 * Validates a style snapshot. Returns null on ANY malformed field — the
 * caller treats that as "no styles", never as a reason to drop the whole
 * selection.
 */
export function parseStyleDetails(v: unknown): StyleDetails | null {
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.classes) || v.classes.length > MAX_STYLE_CLASSES) return null;
  const classes: string[] = [];
  for (const c of v.classes) {
    if (typeof c !== "string" || c.length === 0 || c.length > MAX_STYLE_STRING) return null;
    classes.push(c);
  }
  if (
    v.elementId !== undefined &&
    (typeof v.elementId !== "string" || v.elementId.length > MAX_STYLE_STRING)
  )
    return null;

  const box = v.box;
  if (!isRecord(box)) return null;
  if (
    !isFiniteNum(box.x) ||
    !isFiniteNum(box.y) ||
    !isFiniteNum(box.width) ||
    !isFiniteNum(box.height)
  ) {
    return null;
  }
  const margin = parseEdges(box.margin);
  const padding = parseEdges(box.padding);
  const border = parseEdges(box.border);
  if (!margin || !padding || !border) return null;

  if (!isRecord(v.computed)) return null;
  const computedEntries = Object.entries(v.computed);
  if (computedEntries.length > MAX_STYLE_COMPUTED) return null;
  const computed: Record<string, string> = {};
  for (const [k, val] of computedEntries) {
    if (typeof val !== "string" || val.length > MAX_STYLE_STRING) return null;
    if (k.length > MAX_STYLE_STRING) return null;
    computed[k] = val;
  }

  if (!Array.isArray(v.matchedRules) || v.matchedRules.length > MAX_STYLE_RULES) return null;
  const matchedRules: MatchedCssRule[] = [];
  for (const r of v.matchedRules) {
    if (!isRecord(r)) return null;
    if (typeof r.selector !== "string" || r.selector.length > MAX_STYLE_STRING) return null;
    if (!Array.isArray(r.declarations) || r.declarations.length > MAX_STYLE_DECLS) return null;
    const declarations: CssDeclaration[] = [];
    for (const d of r.declarations) {
      if (!isRecord(d)) return null;
      if (typeof d.property !== "string" || d.property.length > MAX_STYLE_STRING) return null;
      if (typeof d.value !== "string" || d.value.length > MAX_STYLE_STRING) return null;
      declarations.push({ property: d.property, value: d.value, important: d.important === true });
    }
    const rule: MatchedCssRule = { selector: r.selector, declarations };
    // sourcePath must satisfy the same project-relative contract.
    if (r.sourcePath !== undefined) {
      if (
        typeof r.sourcePath !== "string" ||
        r.sourcePath.length === 0 ||
        r.sourcePath.length > MAX_STYLE_STRING ||
        r.sourcePath.includes("..") ||
        r.sourcePath.includes("\\") ||
        /^[a-zA-Z]:/.test(r.sourcePath) ||
        r.sourcePath.startsWith("/")
      ) {
        return null;
      }
      rule.sourcePath = r.sourcePath;
    }
    matchedRules.push(rule);
  }

  const out: StyleDetails = {
    classes,
    box: { x: box.x, y: box.y, width: box.width, height: box.height, margin, padding, border },
    computed,
    matchedRules,
  };
  if (typeof v.elementId === "string" && v.elementId) out.elementId = v.elementId;
  return out;
}

/** Parses and validates a runtime→bridge message. Unknown data is rejected. */
export function parseRuntimeMessage(raw: string): ParseResult<RuntimeMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!isRecord(data)) return { ok: false, reason: "message is not an object" };
  if (!versionOk(data.version)) return { ok: false, reason: "unsupported protocol version" };

  switch (data.type) {
    case "runtime:hello": {
      if (!str(data.sessionId) || !str(data.token) || !str(data.pageUrl)) {
        return { ok: false, reason: "runtime:hello missing required fields" };
      }
      return {
        ok: true,
        message: {
          version: ROOTRAY_PROTOCOL_VERSION,
          type: "runtime:hello",
          sessionId: data.sessionId,
          token: data.token,
          pageUrl: data.pageUrl,
        },
      };
    }
    case "runtime:ready": {
      if (!str(data.sessionId)) {
        return { ok: false, reason: "runtime:ready missing sessionId" };
      }
      return {
        ok: true,
        message: {
          version: ROOTRAY_PROTOCOL_VERSION,
          type: "runtime:ready",
          sessionId: data.sessionId,
        },
      };
    }
    case "inspect:set": {
      // Runtime→bridge direction: a request to change inspection state.
      if (typeof data.enabled !== "boolean") {
        return { ok: false, reason: "inspect:set missing enabled flag" };
      }
      return {
        ok: true,
        message: { version: ROOTRAY_PROTOCOL_VERSION, type: "inspect:set", enabled: data.enabled },
      };
    }
    case "element:selected": {
      if (!str(data.sessionId)) {
        return { ok: false, reason: "element:selected missing sessionId" };
      }
      const element = parseElementFacts(data.element);
      const source = parseSourceLocation(data.source);
      if (!element) return { ok: false, reason: "element:selected has invalid element" };
      if (!source) return { ok: false, reason: "element:selected has invalid source" };
      const message: ElementSelectedMessage = {
        version: ROOTRAY_PROTOCOL_VERSION,
        type: "element:selected",
        sessionId: data.sessionId,
        element,
        source,
      };
      // Optional payload — malformed styles degrade to absent, never to
      // a rejected selection.
      const styles = parseStyleDetails(data.styles);
      if (styles) message.styles = styles;
      return { ok: true, message };
    }
    default:
      return { ok: false, reason: "unknown message type" };
  }
}

/** Parses and validates a bridge→runtime message (used by the inspector runtime). */
export function parseBridgeMessage(raw: string): ParseResult<BridgeMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (!isRecord(data)) return { ok: false, reason: "message is not an object" };
  if (!versionOk(data.version)) return { ok: false, reason: "unsupported protocol version" };

  switch (data.type) {
    case "session:accepted":
      if (!str(data.sessionId)) return { ok: false, reason: "session:accepted missing sessionId" };
      return {
        ok: true,
        message: {
          version: ROOTRAY_PROTOCOL_VERSION,
          type: "session:accepted",
          sessionId: data.sessionId,
        },
      };
    case "session:rejected":
      return {
        ok: true,
        message: {
          version: ROOTRAY_PROTOCOL_VERSION,
          type: "session:rejected",
          reason: typeof data.reason === "string" ? data.reason.slice(0, MAX_STRING_FIELD) : "",
        },
      };
    case "inspect:set":
      if (typeof data.enabled !== "boolean") {
        return { ok: false, reason: "inspect:set missing enabled flag" };
      }
      return {
        ok: true,
        message: { version: ROOTRAY_PROTOCOL_VERSION, type: "inspect:set", enabled: data.enabled },
      };
    default:
      return { ok: false, reason: "unknown message type" };
  }
}

export function serializeMessage(message: RuntimeMessage | BridgeMessage): string {
  return JSON.stringify(message);
}
