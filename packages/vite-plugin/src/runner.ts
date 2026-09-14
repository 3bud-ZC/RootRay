/**
 * RootRay inspector-enabled Vite dev runner.
 *
 * Replaces `npm run dev` for inspector sessions: resolves Vite *from the
 * selected project* (never a bundled copy), loads the user's own
 * vite.config, merges the RootRay plugin in memory, starts the dev server
 * programmatically and prints its real local URLs — the existing RootRay
 * URL detector keeps working unchanged.
 *
 * Configuration arrives exclusively via environment variables so the
 * session token never appears on a command line:
 *   ROOTRAY_PROJECT_ROOT   absolute project root
 *   ROOTRAY_BRIDGE_URL     ws://127.0.0.1:<port>/rootray
 *   ROOTRAY_SESSION_ID     session id
 *   ROOTRAY_SESSION_TOKEN  ephemeral auth token
 *   ROOTRAY_PLUGIN_PATH    absolute path to bundled plugin.cjs
 *   ROOTRAY_RUNTIME_PATH   absolute path to bundled runtime.js
 *
 * A small whitelist of `vite` CLI flags is accepted on argv:
 *   --root <dir> (fallback for ROOTRAY_PROJECT_ROOT)
 *   --host [h] --port <n> --strictPort --mode <m> --force --clearScreen
 */

import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ViteFlags {
  host?: string | boolean;
  port?: number;
  strictPort?: boolean;
  mode?: string;
  force?: boolean;
  clearScreen?: boolean;
}

function fail(message: string, code = 2): never {
  console.error(`[rootray] ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): { root: string | undefined; flags: ViteFlags } {
  const flags: ViteFlags = {};
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    let inlineValue: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return fail(`missing value for ${arg}`, 2);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--root":
        root = takeValue();
        break;
      case "--host": {
        const next = argv[i + 1];
        if (inlineValue !== undefined) flags.host = inlineValue;
        else if (next !== undefined && !next.startsWith("--")) {
          flags.host = next;
          i += 1;
        } else {
          flags.host = true;
        }
        break;
      }
      case "--port": {
        const n = Number(takeValue());
        if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid --port value`, 2);
        flags.port = n;
        break;
      }
      case "--strictPort":
        flags.strictPort = true;
        break;
      case "--mode":
        flags.mode = takeValue();
        break;
      case "--force":
        flags.force = true;
        break;
      case "--clearScreen": {
        const next = argv[i + 1];
        let v = inlineValue;
        if (v === undefined) {
          if (next !== undefined && !next.startsWith("--")) {
            v = next;
            i += 1;
          } else {
            v = "true";
          }
        }
        flags.clearScreen = v !== "false";
        break;
      }
      default:
        fail(`unsupported argument: ${arg}`, 2);
    }
  }
  return { root, flags };
}

async function main(): Promise<void> {
  const { root: rootArg, flags } = parseArgs(process.argv.slice(2));

  const projectRoot = resolve(rootArg ?? process.env.ROOTRAY_PROJECT_ROOT ?? "");
  if (!projectRoot || projectRoot === resolve(".")) {
    fail("no project root provided (ROOTRAY_PROJECT_ROOT or --root)");
  }
  const bridgeUrl = process.env.ROOTRAY_BRIDGE_URL ?? fail("ROOTRAY_BRIDGE_URL is not set");
  const sessionId = process.env.ROOTRAY_SESSION_ID ?? fail("ROOTRAY_SESSION_ID is not set");
  const sessionToken =
    process.env.ROOTRAY_SESSION_TOKEN ?? fail("ROOTRAY_SESSION_TOKEN is not set");
  const pluginPath = process.env.ROOTRAY_PLUGIN_PATH ?? fail("ROOTRAY_PLUGIN_PATH is not set");
  const runtimePath = process.env.ROOTRAY_RUNTIME_PATH ?? fail("ROOTRAY_RUNTIME_PATH is not set");
  if (!isAbsolute(pluginPath) || !isAbsolute(runtimePath)) {
    fail("plugin/runtime paths must be absolute");
  }

  // Resolve Vite from the inspected project — never a bundled copy — so the
  // project runs on its own Vite version with its own config and plugins.
  const projectRequire = createRequire(pathToFileURL(join(projectRoot, "package.json")));
  let vite: typeof import("vite");
  try {
    vite = projectRequire("vite") as typeof import("vite");
  } catch (e) {
    fail(`could not resolve "vite" from the project — are dependencies installed? (${e})`, 3);
  }

  const pluginModule = (await import(pathToFileURL(pluginPath).href)) as Record<string, unknown>;
  const ns = (pluginModule.default ?? pluginModule) as Record<string, unknown>;
  const factory = [ns, pluginModule]
    .map((m) => m.default ?? m.rootrayInspector ?? m)
    .find((c): c is (o: Record<string, string>) => unknown => typeof c === "function");
  if (!factory) fail("inspector plugin bundle does not export a factory function");
  const plugin = (factory as (o: Record<string, string>) => unknown)({
    bridgeUrl,
    sessionId,
    sessionToken,
    runtimePath,
    projectRoot,
  });

  const server = await vite.createServer({
    root: projectRoot,
    // configFile intentionally not set — the project's own vite.config.*
    // loads normally and its plugins/aliases are preserved.
    plugins: [plugin as never],
    ...(flags.mode !== undefined ? { mode: flags.mode } : {}),
    ...(flags.clearScreen !== undefined ? { clearScreen: flags.clearScreen } : {}),
    ...(flags.force ? { optimizeDeps: { force: true } } : {}),
    server: {
      ...(flags.host !== undefined ? { host: flags.host } : {}),
      ...(flags.port !== undefined ? { port: flags.port } : {}),
      ...(flags.strictPort !== undefined ? { strictPort: flags.strictPort } : {}),
    },
  });

  await server.listen();
  server.printUrls();

  const shutdown = async (signal: string) => {
    try {
      await server.close();
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => fail(`dev server failed: ${e instanceof Error ? e.message : e}`, 4));
