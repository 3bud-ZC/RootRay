/**
 * Bundles the Next adapter's shim + loader as self-contained CJS files.
 * Both run inside the inspected project's `next dev` process, so only
 * Node builtins may stay external.
 */
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  logLevel: "info",
  // `module` must stay a real require — the shim hooks Module._load.
  packages: "bundle",
};

await build({ ...shared, entryPoints: ["src/shim.ts"], outfile: "dist/next-shim.cjs" });
await build({ ...shared, entryPoints: ["src/loader.ts"], outfile: "dist/jsx-loader.cjs" });
