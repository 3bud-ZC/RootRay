/**
 * Bounded static analysis of React/JSX sources.
 *
 * Parses each file with `@babel/parser` — the same parser the Vite
 * instrumentation uses — and walks the AST as DATA. Project source is
 * never executed, never `require`d, and regex is never the parser.
 *
 * What it finds:
 *   - component definitions: `function C()`, `const C = () =>`,
 *     `class C extends React.Component`
 *   - JSX usages of capitalized tags
 *   - local import resolution: `./x`, `../x`, explicit extensions and
 *     `index.*` re-exports — only when the resolution is unambiguous
 *
 * Hard caps keep huge projects cheap; `truncated` reports when a cap
 * cut the analysis short.
 */

import { parse } from "@babel/parser";

export interface SourceRef {
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface ComponentDef extends SourceRef {
  name: string;
  kind: "function" | "arrow" | "class";
  exports: { named: boolean; default: boolean };
}

export interface ComponentUsage {
  /** JSX tag as written (`<Card />` → "Card"). */
  name: string;
  /** Where the tag appears. */
  usedIn: SourceRef;
  /** The resolved component definition — null when unresolved. */
  definedIn: SourceRef | null;
  resolved: boolean;
  /** Why resolution failed, when it did. */
  note?: string;
}

export interface ProjectIntel {
  components: ComponentDef[];
  usages: ComponentUsage[];
  filesAnalyzed: number;
  /** Files that failed to parse — analysis continued past them. */
  filesFailed: number;
  truncated: boolean;
}

export const MAX_COMPONENTS = 2_000;
export const MAX_USAGES = 4_000;

const RESOLVE_EXTS = ["tsx", "ts", "jsx", "js", "mts", "cts", "mjs", "cjs"];
const MAX_REEXPORT_DEPTH = 2;

// --- minimal AST typing (same approach as the instrumentation package) ---

type AnyNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
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

function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (NON_NODE_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  return out;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// --- per-file extraction --------------------------------------------------

interface ImportBinding {
  /** Local name used in this file's JSX. */
  local: string;
  /** "default" | "*" | the exported name. */
  imported: string;
  source: string;
}

interface ReExport {
  /** Exported name visible to importers. */
  exported: string;
  /** Name in the target module, or "*" for export-all. */
  imported: string;
  source: string;
}

interface FileFacts {
  path: string;
  components: ComponentDef[];
  /** `export default X` identifier bindings. */
  defaultExported: Set<string>;
  /** `export { X }` / `export const X` names. */
  namedExported: Set<string>;
  usages: { name: string; line: number; column: number }[];
  imports: ImportBinding[];
  reExports: ReExport[];
}

/** True when the subtree contains JSX (heuristic for "is a component"). */
function containsJsx(node: AnyNode, depth = 0): boolean {
  if (depth > 60) return false;
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  return children(node).some((c) => containsJsx(c, depth + 1));
}

function locOf(node: AnyNode): { line: number; column: number } | null {
  const loc = node.loc?.start;
  if (!loc) return null;
  return { line: loc.line, column: loc.column + 1 }; // Babel columns are 0-based
}

function isReactComponentSuper(node: AnyNode): boolean {
  const sc = node.superClass;
  if (!isNode(sc)) return false;
  if (sc.type === "Identifier") {
    return sc.name === "Component" || sc.name === "PureComponent";
  }
  if (sc.type === "MemberExpression" && isNode(sc.object) && isNode(sc.property)) {
    return (
      sc.object.type === "Identifier" &&
      sc.object.name === "React" &&
      (sc.property.name === "Component" || sc.property.name === "PureComponent")
    );
  }
  return false;
}

/** Registers a component def, honoring the component cap. */
function pushDef(
  facts: FileFacts,
  def: Omit<ComponentDef, "exports">,
  exported: { named?: boolean; default?: boolean },
): void {
  const existing = facts.components.find(
    (c) => c.name === def.name && c.line === def.line && c.column === def.column,
  );
  const target = existing ?? { ...def, exports: { named: false, default: false } };
  if (!existing) facts.components.push(target);
  if (exported.named) {
    target.exports.named = true;
    facts.namedExported.add(def.name);
  }
  if (exported.default) {
    target.exports.default = true;
    facts.defaultExported.add(def.name);
  }
}

function inspectDecl(
  node: AnyNode,
  facts: FileFacts,
  exported: { named?: boolean; default?: boolean },
): void {
  switch (node.type) {
    case "FunctionDeclaration": {
      const id = node.id;
      const loc = isNode(id) ? (locOf(id) ?? locOf(node)) : locOf(node);
      if (
        isNode(id) &&
        typeof id.name === "string" &&
        isComponentName(id.name) &&
        containsJsx(node) &&
        loc
      ) {
        pushDef(facts, { name: id.name, kind: "function", path: facts.path, ...loc }, exported);
      }
      return;
    }
    case "ClassDeclaration": {
      const id = node.id;
      const loc = isNode(id) ? (locOf(id) ?? locOf(node)) : locOf(node);
      if (
        isNode(id) &&
        typeof id.name === "string" &&
        isComponentName(id.name) &&
        isReactComponentSuper(node) &&
        loc
      ) {
        pushDef(facts, { name: id.name, kind: "class", path: facts.path, ...loc }, exported);
      }
      return;
    }
    case "VariableDeclaration": {
      for (const d of Array.isArray(node.declarations) ? node.declarations : []) {
        if (!isNode(d) || d.type !== "VariableDeclarator") continue;
        const id = d.id;
        const init = d.init;
        if (!isNode(id) || id.type !== "Identifier" || typeof id.name !== "string") continue;
        if (!isComponentName(id.name) || !isNode(init)) continue;
        const kind = init.type === "ArrowFunctionExpression" ? "arrow" : "function";
        if (
          (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") &&
          containsJsx(init)
        ) {
          const loc = locOf(id) ?? locOf(d);
          if (loc) pushDef(facts, { name: id.name, kind, path: facts.path, ...loc }, exported);
        }
      }
      return;
    }
    default:
      return;
  }
}

function extract(path: string, content: string): FileFacts | null {
  const isTs = /\.(ts|tsx|mts|cts)$/.test(path);
  let ast: AnyNode;
  try {
    ast = parse(content, {
      sourceType: "unambiguous",
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: ["jsx", ...(isTs ? (["typescript"] as const) : ([] as const))],
    }) as unknown as AnyNode;
  } catch {
    return null;
  }
  const program = isNode(ast.program) ? ast.program : ast;
  const body = Array.isArray(program.body) ? program.body.filter(isNode) : [];

  const facts: FileFacts = {
    path,
    components: [],
    defaultExported: new Set(),
    namedExported: new Set(),
    usages: [],
    imports: [],
    reExports: [],
  };

  for (const node of body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const source =
          isNode(node.source) && typeof node.source.value === "string" ? node.source.value : null;
        if (!source) break;
        for (const spec of Array.isArray(node.specifiers) ? node.specifiers : []) {
          if (!isNode(spec)) continue;
          const local =
            isNode(spec.local) && typeof spec.local.name === "string" ? spec.local.name : null;
          if (!local) continue;
          if (spec.type === "ImportDefaultSpecifier") {
            facts.imports.push({ local, imported: "default", source });
          } else if (spec.type === "ImportNamespaceSpecifier") {
            facts.imports.push({ local, imported: "*", source });
          } else if (spec.type === "ImportSpecifier") {
            const imported = isNode(spec.imported)
              ? typeof spec.imported.name === "string"
                ? spec.imported.name
                : typeof spec.imported.value === "string"
                  ? spec.imported.value
                  : null
              : null;
            if (imported) facts.imports.push({ local, imported, source });
          }
        }
        break;
      }
      case "ExportNamedDeclaration": {
        const decl = node.declaration;
        if (isNode(decl)) inspectDecl(decl, facts, { named: true });
        // `export { X, Y as Z }` (local or re-export with source).
        const source =
          isNode(node.source) && typeof node.source.value === "string" ? node.source.value : null;
        for (const spec of Array.isArray(node.specifiers) ? node.specifiers : []) {
          if (!isNode(spec) || spec.type !== "ExportSpecifier") continue;
          const exportedName = isNode(spec.exported)
            ? typeof spec.exported.name === "string"
              ? spec.exported.name
              : null
            : null;
          const localName =
            isNode(spec.local) && typeof spec.local.name === "string" ? spec.local.name : null;
          if (!exportedName || !localName) continue;
          if (source) {
            facts.reExports.push({ exported: exportedName, imported: localName, source });
          } else {
            facts.namedExported.add(exportedName);
            const comp = facts.components.find((c) => c.name === localName);
            if (comp && exportedName === localName) comp.exports.named = true;
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const decl = node.declaration;
        if (isNode(decl)) {
          if (decl.type === "Identifier" && typeof decl.name === "string") {
            facts.defaultExported.add(decl.name);
            const comp = facts.components.find((c) => c.name === decl.name);
            if (comp) comp.exports.default = true;
          } else {
            inspectDecl(decl, facts, { default: true });
          }
        }
        break;
      }
      case "ExportAllDeclaration": {
        const source =
          isNode(node.source) && typeof node.source.value === "string" ? node.source.value : null;
        if (source) facts.reExports.push({ exported: "*", imported: "*", source });
        break;
      }
      default:
        inspectDecl(node, facts, {});
    }
  }

  // Second pass for `export { X }` that appeared before the def.
  for (const node of body) {
    if (node.type !== "ExportNamedDeclaration" || isNode(node.source)) continue;
    for (const spec of Array.isArray(node.specifiers) ? node.specifiers : []) {
      if (!isNode(spec) || spec.type !== "ExportSpecifier") continue;
      const localName =
        isNode(spec.local) && typeof spec.local.name === "string" ? spec.local.name : null;
      if (!localName) continue;
      const comp = facts.components.find((c) => c.name === localName);
      if (comp) comp.exports.named = true;
    }
  }

  // JSX usages anywhere in the file. Counting only JSXOpeningElement —
  // its JSXElement parent recurses into it, so counting both doubles.
  const walk = (node: AnyNode): void => {
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      if (isNode(name) && name.type === "JSXIdentifier" && typeof name.name === "string") {
        if (isComponentName(name.name)) {
          const loc = locOf(name) ?? locOf(node);
          if (loc) facts.usages.push({ name: name.name, ...loc });
        }
      } else if (isNode(name) && name.type === "JSXMemberExpression") {
        const loc = locOf(node);
        if (loc) facts.usages.push({ name: "(member)", ...loc });
      }
    }
    for (const c of children(node)) walk(c);
  };
  walk(program);
  return facts;
}

// --- import resolution ------------------------------------------------------

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Lexically resolves `./x`/`../x` segments — filesystem untouched. */
function joinRelative(fromDir: string, spec: string): string | null {
  const parts = (fromDir ? `${fromDir}/` : "").split("/").concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length === 0) return null; // escapes the project
      out.pop();
    } else {
      out.push(p);
    }
  }
  return out.join("/");
}

/**
 * Resolves an import specifier to a project-relative file, or null when
 * external/ambiguous. Candidates: exact, extension suffixes, `index.*`.
 */
function resolveSpecifier(fromPath: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // external
  const base = joinRelative(dirname(fromPath), spec);
  if (!base) return null;
  const candidates: string[] = [];
  if (files.has(base)) candidates.push(base);
  for (const ext of RESOLVE_EXTS) {
    const withExt = `${base}.${ext}`;
    if (files.has(withExt)) candidates.push(withExt);
    const index = `${base}/index.${ext}`;
    if (files.has(index)) candidates.push(index);
  }
  const unique = [...new Set(candidates)];
  // More than one hit = genuinely ambiguous — don't guess.
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

/** Finds the definition `imported` refers to inside `fileFacts`, following
 *  unambiguous re-exports. `depth` guards against re-export cycles. */
function findDefIn(
  imported: string,
  filePath: string,
  facts: Map<string, FileFacts>,
  files: Set<string>,
  depth: number,
): ComponentDef | null {
  if (depth > MAX_REEXPORT_DEPTH) return null;
  const f = facts.get(filePath);
  if (!f) return null;

  if (imported === "default") {
    return f.components.find((c) => c.exports.default) ?? null;
  }
  const direct = f.components.find((c) => c.name === imported && c.exports.named);
  if (direct) return direct;

  // Re-export chain — only when it resolves unambiguously.
  const hits: ComponentDef[] = [];
  for (const re of f.reExports) {
    if (re.exported !== "*" && re.exported !== imported) continue;
    if (re.exported === "*" && imported === "*") continue;
    const target = resolveSpecifier(filePath, re.source, files);
    if (!target) continue;
    const nameInTarget = re.exported === "*" ? imported : re.imported;
    const hit = findDefIn(nameInTarget, target, facts, files, depth + 1);
    if (hit) hits.push(hit);
  }
  const unique = [...new Map(hits.map((h) => [`${h.path}:${h.line}:${h.column}`, h])).values()];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

// --- public API ---------------------------------------------------------------

export interface AnalyzeInput {
  relativePath: string;
  content: string;
}

/**
 * Analyzes a bounded collection of project sources into component
 * definitions and JSX usages with resolved relationships.
 */
export function analyzeSources(inputs: AnalyzeInput[]): ProjectIntel {
  const files = new Set(inputs.map((i) => i.relativePath));
  const facts = new Map<string, FileFacts>();
  let filesFailed = 0;
  let truncated = false;

  for (const input of inputs) {
    const f = extract(input.relativePath, input.content);
    if (!f) {
      filesFailed += 1;
      continue;
    }
    facts.set(input.relativePath, f);
  }

  const components: ComponentDef[] = [];
  const usages: ComponentUsage[] = [];
  for (const f of facts.values()) {
    for (const c of f.components) {
      if (components.length >= MAX_COMPONENTS) {
        truncated = true;
        break;
      }
      components.push(c);
    }
  }

  for (const f of facts.values()) {
    for (const u of f.usages) {
      if (usages.length >= MAX_USAGES) {
        truncated = true;
        break;
      }
      const usage: ComponentUsage = {
        name: u.name,
        usedIn: { path: f.path, line: u.line, column: u.column },
        definedIn: null,
        resolved: false,
      };
      // Same-file component first.
      const local = f.components.find((c) => c.name === u.name);
      if (local) {
        usage.definedIn = { path: local.path, line: local.line, column: local.column };
        usage.resolved = true;
        usages.push(usage);
        continue;
      }
      const imp = f.imports.find((i) => i.local === u.name);
      if (!imp) {
        usage.note = u.name === "(member)" ? "member-expression component" : "no local import";
        usages.push(usage);
        continue;
      }
      const target = resolveSpecifier(f.path, imp.source, files);
      if (!target) {
        usage.note = "external or unresolvable import";
        usages.push(usage);
        continue;
      }
      const def = findDefIn(imp.imported, target, facts, files, 0);
      if (!def) {
        usage.note = "import resolved; component not found";
        usages.push(usage);
        continue;
      }
      usage.definedIn = { path: def.path, line: def.line, column: def.column };
      usage.resolved = true;
      usages.push(usage);
    }
  }

  return {
    components,
    usages,
    filesAnalyzed: facts.size,
    filesFailed,
    truncated,
  };
}

/** The definition a JSX usage resolved to, if any. */
export function usageTarget(u: ComponentUsage): SourceRef | null {
  return u.resolved ? u.definedIn : null;
}

/** All resolved usages pointing at `def` ("Used by" list). */
export function usagesOf(intel: ProjectIntel, def: ComponentDef): ComponentUsage[] {
  return intel.usages.filter(
    (u) =>
      u.resolved &&
      u.definedIn !== null &&
      u.definedIn.path === def.path &&
      u.definedIn.line === def.line &&
      u.definedIn.column === def.column,
  );
}

/** Finds a component definition by name + owning file. */
export function findComponent(
  intel: ProjectIntel,
  name: string,
  path: string,
): ComponentDef | null {
  return intel.components.find((c) => c.name === name && c.path === path) ?? null;
}
