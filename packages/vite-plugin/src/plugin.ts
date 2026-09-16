/**
 * RootRay Vite plugin — development only.
 *
 * - `transform` (enforce: "pre") stamps JSX source identity before the
 *   React plugin compiles it away.
 * - `transformIndexHtml` injects the session bootstrap + runtime script.
 * - `configureServer` serves the bundled inspector runtime from memory.
 *
 * `apply: "serve"` guarantees nothing here ever touches production builds.
 */

import { readFileSync } from "node:fs";
import { bootstrapConfig, instrumentSource, shouldInstrument } from "@rootray/jsx-instrument";
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

    transformIndexHtml(html) {
      const cfg = JSON.stringify(
        bootstrapConfig({
          bridgeUrl: opts.bridgeUrl,
          sessionId: opts.sessionId,
          token: opts.sessionToken,
          projectRoot: opts.projectRoot,
        }),
      ).replace(/</g, "\\u003c");
      return {
        html,
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
  };
}
