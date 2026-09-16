/**
 * RootRay JSX instrumentation loader — webpack-loader-compatible, which
 * Turbopack also supports via `turbopack.rules`.
 *
 * For every project-owned JS/TS module it stamps `data-rootray-*` on
 * intrinsic JSX elements and imports the session entry module (a relative
 * specifier computed against `entryPath`) so the inspector runtime lands
 * in the client graph without touching project files.
 *
 * Injected entirely in memory by `next-shim` — never written into the
 * project's bundler config.
 */

import path from "node:path";
import { instrumentSource, shouldInstrument } from "@rootray/jsx-instrument";

export interface LoaderOptions {
  /** Canonical absolute project root (the Next target root). */
  projectRoot: string;
  /** Absolute path to the generated session entry module. */
  entryPath: string;
}

interface LoaderContext {
  resourcePath: string;
  query?: unknown;
  getOptions?: () => LoaderOptions;
  callback?: (err: unknown, code?: string, map?: unknown) => void;
}

function optionsFor(ctx: LoaderContext): LoaderOptions {
  if (typeof ctx.getOptions === "function") return ctx.getOptions();
  const q = ctx.query;
  return (typeof q === "object" && q !== null ? q : {}) as LoaderOptions;
}

/** Relative ESM specifier from `fromFile`'s directory to `toFile`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

export default function rootrayJsxLoader(this: LoaderContext, source: string): string | undefined {
  const opts = optionsFor(this);
  const resourcePath = this.resourcePath;
  if (
    !opts.projectRoot ||
    !opts.entryPath ||
    typeof resourcePath !== "string" ||
    !shouldInstrument(resourcePath, opts.projectRoot)
  ) {
    return source;
  }
  try {
    const result = instrumentSource({
      id: resourcePath,
      projectRoot: opts.projectRoot,
      code: source,
      entryImport: relativeSpecifier(resourcePath, opts.entryPath),
    });
    if (!result) return source;
    // Pass the sourcemap as an object — Next's swc layer rejects string maps.
    const map = JSON.parse(result.map.toString());
    if (typeof this.callback === "function") {
      this.callback(null, result.code, map);
      return undefined;
    }
    return result.code;
  } catch {
    // Instrumentation must never break the user's dev server.
    return source;
  }
}
