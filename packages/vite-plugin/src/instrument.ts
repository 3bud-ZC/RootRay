/**
 * JSX source instrumentation.
 *
 * Stamps `data-rootray-*` attributes onto *intrinsic* (lowercase DOM) JSX
 * elements so the browser runtime can map a rendered node back to the file,
 * line and column that produced it. Works purely on the transform result —
 * files on disk are never touched and production builds never reach this
 * code (`apply: "serve"` on the plugin).
 *
 * Implementation: real parse via `@babel/parser`, source edits via
 * `magic-string` (source maps preserved). No regex JSX parsing.
 */

import path from "node:path";
import { parse } from "@babel/parser";
import { ROOTRAY_PROTOCOL_VERSION } from "@rootray/source-protocol";
import MagicString from "magic-string";

export const ATTR_FILE = "data-rootray-file";
export const ATTR_LINE = "data-rootray-line";
export const ATTR_COLUMN = "data-rootray-column";
export const ATTR_COMPONENT = "data-rootray-component";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SKIP_DIR_MARKERS = ["node_modules", "/dist/", "/coverage/", "/.git/", "__generated__"];

export interface InstrumentOptions {
  /** Vite module id (absolute path, possibly with query). */
  id: string;
  /** Canonical absolute project root. */
  projectRoot: string;
  code: string;
}

export interface InstrumentResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  changed: boolean;
}

/** Decides whether a module id is project-owned, instrumentable source. */
export function shouldInstrument(id: string, projectRoot: string): boolean {
  if (id.includes("\0") || id.includes("?")) return false;
  if (id.endsWith(".d.ts")) return false;
  if (!CODE_EXTENSIONS.has(path.extname(id).toLowerCase())) return false;
  const normalized = id.replace(/\\/g, "/");
  if (SKIP_DIR_MARKERS.some((m) => normalized.includes(m))) return false;
  const rel = path.relative(projectRoot, id).replace(/\\/g, "/");
  // Only project-owned files — never external/linked packages.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

/** Project-relative POSIX path used in DOM metadata. */
export function relativeSourcePath(id: string, projectRoot: string): string | null {
  const rel = path.relative(projectRoot, id).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("\\")) return null;
  return rel;
}

// --- AST walk ------------------------------------------------------------------

type AnyNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  name?: unknown;
  id?: unknown;
  attributes?: unknown;
  [key: string]: unknown;
};

const NON_NODE_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "raw",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
]);

function isNode(v: unknown): v is AnyNode {
  return typeof v === "object" && v !== null && typeof (v as AnyNode).type === "string";
}

/** Boundaries that may own a component name. */
const COMPONENT_BOUNDARIES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "ClassMethod",
  "ClassPrivateMethod",
  "ObjectMethod",
]);

function nameFromParent(parent: AnyNode | null): string | null {
  if (!parent) return null;
  if (
    parent.type === "VariableDeclarator" &&
    isNode(parent.id) &&
    parent.id.type === "Identifier"
  ) {
    return typeof parent.id.name === "string" ? parent.id.name : null;
  }
  if (
    parent.type === "AssignmentExpression" &&
    isNode(parent.left) &&
    parent.left.type === "Identifier"
  ) {
    return typeof parent.left.name === "string" ? parent.left.name : null;
  }
  if (
    (parent.type === "ObjectProperty" || parent.type === "Property") &&
    isNode(parent.key) &&
    parent.key.type === "Identifier"
  ) {
    return typeof parent.key.name === "string" ? parent.key.name : null;
  }
  return null;
}

/** Component name a boundary introduces, or null when anonymous/ambiguous. */
function boundaryName(node: AnyNode, parent: AnyNode | null): string | null {
  switch (node.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return isNode(node.id) && typeof node.id.name === "string" ? node.id.name : null;
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
      return isNode(node.id) && typeof node.id.name === "string"
        ? node.id.name
        : nameFromParent(parent);
    default:
      return null; // methods push a null frame so lookup falls through to the class
  }
}

function isIntrinsicJsx(node: AnyNode): string | null {
  if (node.type !== "JSXOpeningElement") return null;
  const name = node.name;
  if (!isNode(name) || name.type !== "JSXIdentifier") return null;
  const tag = name.name;
  if (typeof tag !== "string" || !/^[a-z]/.test(tag)) return null;
  return tag;
}

function alreadyInstrumented(node: AnyNode): boolean {
  if (!Array.isArray(node.attributes)) return false;
  return node.attributes.some(
    (a) => isNode(a) && a.type === "JSXAttribute" && isNode(a.name) && a.name.name === ATTR_FILE,
  );
}

interface CollectedInsertion {
  /** Absolute offset in `code` where attributes are appended. */
  at: number;
  attrs: string;
}

function collectInsertions(ast: AnyNode, relativePath: string): CollectedInsertion[] {
  const out: CollectedInsertion[] = [];
  // Stack of boundary names; innermost non-null is the owning component.
  const stack: (string | null)[] = [];

  const owningComponent = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const name = stack[i];
      if (name != null) return name;
    }
    return null;
  };

  const walk = (node: AnyNode, parent: AnyNode | null): void => {
    const boundary = COMPONENT_BOUNDARIES.has(node.type);
    if (boundary) stack.push(boundaryName(node, parent));

    const tag = isIntrinsicJsx(node);
    if (tag && !alreadyInstrumented(node) && node.loc && isNode(node.name)) {
      const nameNode = node.name;
      if (typeof nameNode.end === "number") {
        const line = node.loc.start.line;
        const column = node.loc.start.column + 1; // Babel columns are 0-based
        let attrs =
          ` ${ATTR_FILE}="${relativePath}"` +
          ` ${ATTR_LINE}={${line}}` +
          ` ${ATTR_COLUMN}={${column}}`;
        const component = owningComponent();
        if (component && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(component)) {
          attrs += ` ${ATTR_COMPONENT}="${component}"`;
        }
        out.push({ at: nameNode.end, attrs });
      }
    }

    for (const key of Object.keys(node)) {
      if (NON_NODE_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const child of v) if (isNode(child)) walk(child, node);
      } else if (isNode(v)) {
        walk(v, node);
      }
    }

    if (boundary) stack.pop();
  };

  walk(ast, null);
  return out;
}

// --- public API --------------------------------------------------------------------

/**
 * Instruments `code` if it contains JSX. Returns null when parsing fails —
 * callers treat that as "leave the file alone".
 */
export function instrumentSource(opts: InstrumentOptions): InstrumentResult | null {
  const relativePath = relativeSourcePath(opts.id, opts.projectRoot);
  if (!relativePath) return null;

  const ext = path.extname(opts.id).toLowerCase();
  const isTs = ext === ".ts" || ext === ".tsx";
  let ast: AnyNode;
  try {
    ast = parse(opts.code, {
      sourceType: "unambiguous",
      allowImportExportEverywhere: true,
      errorRecovery: false,
      plugins: ["jsx", ...(isTs ? (["typescript"] as const) : ([] as const))],
    }) as unknown as AnyNode;
  } catch {
    // Unparseable source — leave the file alone.
    return null;
  }

  const insertions = collectInsertions(ast.program as AnyNode, relativePath);
  if (insertions.length === 0) return null;

  const ms = new MagicString(opts.code);
  // Apply right-to-left so earlier offsets stay valid.
  for (const ins of insertions.sort((a, b) => b.at - a.at)) {
    ms.appendLeft(ins.at, ins.attrs);
  }
  return {
    code: ms.toString(),
    map: ms.generateMap({ hires: true, source: opts.id }),
    changed: true,
  };
}

/** Session config the plugin stamps onto `window.__ROOTRAY__`. */
export interface RuntimeBootstrap {
  bridgeUrl: string;
  sessionId: string;
  token: string;
  version: number;
  /** Absolute project root — lets the runtime relativize stylesheet hints. */
  projectRoot: string;
}

export function bootstrapConfig(opts: {
  bridgeUrl: string;
  sessionId: string;
  token: string;
  projectRoot: string;
}): RuntimeBootstrap {
  return { ...opts, version: ROOTRAY_PROTOCOL_VERSION };
}
