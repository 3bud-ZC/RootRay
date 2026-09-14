/**
 * Bundles the plugin + runner as self-contained CJS files.
 * `vite` stays external — the runner resolves the *project's* copy.
 */
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  logLevel: "info",
  external: ["vite"],
};

await build({ ...shared, entryPoints: ["src/plugin.ts"], outfile: "dist/plugin.cjs" });
await build({ ...shared, entryPoints: ["src/runner.ts"], outfile: "dist/runner.cjs" });
