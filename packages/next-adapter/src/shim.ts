/**
 * RootRay Next.js inspector shim — loaded into the `next dev` process via
 * `NODE_OPTIONS=--require <next-shim.cjs>`.
 *
 * How it works: Next's swc-compiled `server/config.js` exposes `loadConfig`
 * as a *non-configurable* getter (`default`), so it cannot be redefined on
 * the exports object. Instead we hook `Module._load`: every module that
 * requires `next/dist/server/config.js` receives a wrapped exports object
 * whose `default` merges RootRay's instrumentation into whatever config the
 * project declared — `turbopack.rules`/`resolveAlias` on Turbopack, or a
 * `webpack()` wrapper on the `--webpack` fallback. Nothing is written to
 * the user's project; if injection fails the dev server runs normally.
 *
 * Env contract (set by the RootRay launch adapter):
 *   ROOTRAY_NEXT_LOADER     absolute path to bundled jsx-loader.cjs
 *   ROOTRAY_NEXT_ENTRY      absolute path to the session entry module
 *   ROOTRAY_PROJECT_ROOT    absolute Next target root
 */

import Module from "node:module";

const LOADER_PATH = process.env.ROOTRAY_NEXT_LOADER;
const ENTRY_PATH = process.env.ROOTRAY_NEXT_ENTRY;
const PROJECT_ROOT = process.env.ROOTRAY_PROJECT_ROOT;

if (!LOADER_PATH || !ENTRY_PATH || !PROJECT_ROOT) {
  console.error("[rootray] next-shim env incomplete — inspector disabled");
} else {
  install();
}

function install() {
  const loaderSpec = {
    loader: LOADER_PATH,
    options: { projectRoot: PROJECT_ROOT, entryPath: ENTRY_PATH },
  };
  // Cover nested paths — turbopack rule keys are globs against the module
  // path relative to the project.
  const RULE_GLOBS = [
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
  ];

  function injectTurbopack(config: Record<string, unknown>) {
    if (!config.turbopack || typeof config.turbopack !== "object") config.turbopack = {};
    const tp = config.turbopack as Record<string, unknown>;
    if (!tp.rules || typeof tp.rules !== "object") tp.rules = {};
    const rules = tp.rules as Record<string, unknown>;
    for (const glob of RULE_GLOBS) {
      const existing = rules[glob];
      const item = { loaders: [loaderSpec] };
      if (!existing) rules[glob] = item;
      else if (Array.isArray(existing)) rules[glob] = [item, ...existing];
      else rules[glob] = [item, existing];
    }
  }

  function injectWebpack(config: Record<string, unknown>) {
    type WpConfig = Record<string, unknown> & {
      entry?: unknown;
      resolve?: Record<string, unknown> & { alias?: Record<string, unknown> };
      module?: Record<string, unknown> & { rules?: unknown[] };
    };
    const userWebpack = config.webpack;
    config.webpack = function (
      this: unknown,
      wpConfig: WpConfig,
      ctx: { dev?: boolean; isServer?: boolean },
    ) {
      const c: WpConfig =
        typeof userWebpack === "function" ? userWebpack.call(this, wpConfig, ctx) : wpConfig;
      if (!c || !ctx || ctx.dev !== true) return c;
      if (c.entry && ctx.isServer === false) {
        const origEntry = c.entry;
        c.entry = async () => {
          const e = (typeof origEntry === "function" ? await origEntry() : origEntry) as Record<
            string,
            unknown
          >;
          for (const k of Object.keys(e)) {
            if (Array.isArray(e[k]) && !e[k].includes(ENTRY_PATH)) e[k].unshift(ENTRY_PATH);
          }
          return e;
        };
      }
      if (!c.resolve || typeof c.resolve !== "object") c.resolve = {};
      const resolve = c.resolve;
      resolve.alias = { ...resolve.alias };
      if (!c.module || typeof c.module !== "object") c.module = {};
      const module_ = c.module;
      if (!Array.isArray(module_.rules)) module_.rules = [];
      const rules = module_.rules;
      rules.push({
        test: /\.(tsx?|jsx?|mjs|cjs)$/,
        include: [PROJECT_ROOT],
        exclude: /node_modules/,
        enforce: "pre",
        use: [loaderSpec],
      });
      return c;
    };
  }

  function injectConfig(config: unknown): unknown {
    if (!config || typeof config !== "object") return config;
    try {
      injectTurbopack(config as Record<string, unknown>);
      injectWebpack(config as Record<string, unknown>);
    } catch (err) {
      console.error("[rootray] config injection failed:", (err as Error)?.message);
    }
    return config;
  }

  const wrappedByFile = new Map<string, unknown>();
  const mod = Module as unknown as {
    _load: (request: string, parent: { filename: string } | null, isMain?: boolean) => unknown;
    _resolveFilename: (request: string, parent: unknown) => string;
  };
  const origLoad = mod._load;
  mod._load = function (
    this: unknown,
    request: string,
    parent: { filename: string } | null,
    ...rest: unknown[]
  ) {
    const m = origLoad.call(this, request, parent, ...(rest as [boolean?]));
    try {
      const resolved = mod._resolveFilename(request, parent).replace(/\\/g, "/");
      if (!/\/next\/dist\/server\/config\.js$/.test(resolved)) return m;
      if (!m || typeof m !== "object") return m;
      const exp = m as Record<string, unknown>;
      if (exp.__rootrayWrapped) return m;
      if (wrappedByFile.has(resolved)) return wrappedByFile.get(resolved);
      const orig = exp.default;
      if (typeof orig !== "function") return m;
      const wrapped = async function (this: unknown, ...args: unknown[]) {
        const config = await (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
        return injectConfig(config);
      };
      const out = { ...exp, __esModule: true, __rootrayWrapped: true, default: wrapped };
      wrappedByFile.set(resolved, out);
      return out;
    } catch {
      return m;
    }
  };
}
