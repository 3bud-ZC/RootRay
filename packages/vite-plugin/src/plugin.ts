/**
 * RootRay Vite plugin — development only.
 *
 * - `transform` (enforce: "pre") stamps JSX source identity before the
 *   React plugin compiles it away.
 * - `transformIndexHtml` stamps authored HTML source identity and injects
 *   the session bootstrap + runtime script.
 * - `configureServer` serves the bundled inspector runtime from memory.
 *
 * `apply: "serve"` guarantees nothing here ever touches production builds.
 */

import { readFileSync } from "node:fs";
import { instrumentHtml } from "@rootray/html-instrument";
import {
  bootstrapConfig,
  instrumentSource,
  relativeSourcePath,
  shouldInstrument,
} from "@rootray/jsx-instrument";
import type { Plugin } from "vite";

export const RUNTIME_URL = "/__rootray/runtime.js";

export interface RootRayInspectorOptions {
  /** ws://127.0.0.1:<port>/rootray */
  bridgeUrl: string;
  sessionId: string;
  sessionToken: string;
  /** Absolute path to the bundled inspector-runtime `runtime.js`. */
  runtimePath: string;
  /** Canonical absolute project root — source paths are relative to it. */
  projectRoot: string;
  /**
   * Runtime element-picking mode:
   * - `jsx-meta` (default) — nearest instrumented ancestor; used for
   *   React projects.
   * - `generic-dom` — every DOM element is inspectable; used for Vite
   *   projects without React. JSX stamping still runs (a JSX-using
   *   project without React, e.g. Solid/Preact, keeps element mapping).
   */
  mode?: "generic-dom" | "jsx-meta";
  /** Same-origin SSE endpoint for save-driven reload (static server only). */
  reloadUrl?: string;
}

export default function rootrayInspector(opts: RootRayInspectorOptions): Plugin {
  let runtimeCode: string | null = null;
  const loadRuntime = (): string => {
    if (runtimeCode === null) runtimeCode = readFileSync(opts.runtimePath, "utf8");
    return runtimeCode;
  };

  return {
    name: "rootray-inspector",
    apply: "serve",
    enforce: "pre",

    transform(code, id) {
      if (!shouldInstrument(id, opts.projectRoot)) return null;
      try {
        const result = instrumentSource({ id, projectRoot: opts.projectRoot, code });
        return result ? { code: result.code, map: result.map } : null;
      } catch {
        // Never break the user's dev server over instrumentation.
        return null;
      }
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] === RUNTIME_URL) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(loadRuntime());
          return;
        }
        next();
      });
    },

    // `order: "pre"` is required (not just plugin `enforce: "pre"`): Vite's
    // internal `devHtmlHook` — which prepends `/@vite/client` to <head> —
    // runs after "pre" hooks but before "normal" hooks. Stamping positions
    // from the raw authored HTML keeps line/column numbers factual against
    // the file on disk.
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        // Parser-based HTML instrumentation: every authored element gets a
        // data-rootray-* identity stamped from its real source location,
        // and authored spoofed attributes are stripped. Applies to BOTH
        // modes — authored index.html elements (app shells, canvases,
        // static markup outside a framework root) map to their source.
        //
        // Stamps are only applied when the served markup is byte-identical
        // to the file on disk. SSR frameworks can pipe *rendered* output
        // through this hook — positions in that string would point at the
        // wrong source lines, which is worse than no mapping. Runtime
        // injection below still happens either way; only stamping is
        // skipped for synthesized HTML.
        let stampedHtml = html;
        try {
          const rel = relativeSourcePath(ctx.filename, opts.projectRoot);
          if (rel && readFileSync(ctx.filename, "utf8") === html) {
            stampedHtml = instrumentHtml(html, rel).code;
          }
        } catch {
          // Never break the dev server over HTML instrumentation.
        }
        const cfg = JSON.stringify(
          bootstrapConfig({
            bridgeUrl: opts.bridgeUrl,
            sessionId: opts.sessionId,
            token: opts.sessionToken,
            projectRoot: opts.projectRoot,
            ...(opts.mode ? { mode: opts.mode } : {}),
            ...(opts.reloadUrl ? { reloadUrl: opts.reloadUrl } : {}),
          }),
        ).replace(/</g, "\\u003c");
        return {
          html: stampedHtml,
          tags: [
            {
              tag: "script",
              injectTo: "head-prepend",
              children: `window.__ROOTRAY__=${cfg};`,
            },
            {
              tag: "script",
              injectTo: "head-prepend",
              attrs: { src: RUNTIME_URL },
            },
          ],
        };
      },
    },
  };
}
