/**
 * Bundles the inspector runtime into a single IIFE the Vite plugin serves
 * to inspected pages. No external deps at runtime — everything inlined.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/runtime.js",
  sourcemap: false,
  minify: true,
  logLevel: "info",
});
