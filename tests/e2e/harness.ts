/**
 * Shared E2E harness for RootRay inspector/editing specs.
 *
 * - `MockBridge`: protocol-faithful stand-in for the Rust WebSocket
 *   bridge (the native side is covered by `inspector_bridge` tests).
 * - `safeRead`/`safeSave`: a Node mirror of the Rust `editor::file`
 *   contract — SHA-256 optimistic concurrency + temp-file/rename atomic
 *   write — so specs exercise the same semantics the native API
 *   guarantees (the native implementation itself is covered by the
 *   `source_edit` Rust suite).
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const FIXTURE = join(REPO_ROOT, "fixtures", "vite-react-inspector");
export const RUNNER = join(REPO_ROOT, "packages", "vite-plugin", "dist", "runner.cjs");
export const PLUGIN = join(REPO_ROOT, "packages", "vite-plugin", "dist", "plugin.cjs");
export const RUNTIME_BUNDLE = join(
  REPO_ROOT,
  "packages",
  "inspector-runtime",
  "dist",
  "runtime.js",
);

export const SESSION_ID = `e2e-${randomBytes(6).toString("hex")}`;
export const SESSION_TOKEN = randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------

/** Protocol-faithful stand-in for the Rust inspector bridge. */
export class MockBridge {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  port = 0;
  ready = false;
  helloPageUrl = "";
  selections: unknown[] = [];
  runtimeInspectSets: boolean[] = [];
  rejected: string[] = [];

  async start(): Promise<void> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.wss = wss;
    await new Promise<void>((res) =>
      wss.on("listening", () => {
        const addr = wss.address();
        if (typeof addr === "object" && addr) this.port = addr.port;
        res();
      }),
    );
    wss.on("connection", (ws) => {
      this.socket = ws;
      ws.on("message", (data) => this.onMessage(ws, data.toString()));
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      ws.close(4000, "malformed");
      return;
    }
    if (msg.version !== 1) {
      this.rejected.push("version");
      ws.send(
        JSON.stringify({ version: 1, type: "session:rejected", reason: "protocol-mismatch" }),
      );
      ws.close();
      return;
    }
    switch (msg.type) {
      case "runtime:hello": {
        if (msg.token !== SESSION_TOKEN || msg.sessionId !== SESSION_ID) {
          this.rejected.push("auth");
          ws.send(JSON.stringify({ version: 1, type: "session:rejected", reason: "auth" }));
          ws.close();
          return;
        }
        this.helloPageUrl = String(msg.pageUrl ?? "");
        ws.send(JSON.stringify({ version: 1, type: "session:accepted", sessionId: SESSION_ID }));
        return;
      }
      case "runtime:ready":
        this.ready = true;
        return;
      case "element:selected":
        this.selections.push(msg);
        return;
      case "inspect:set":
        this.runtimeInspectSets.push(Boolean(msg.enabled));
        return;
      default:
        ws.close(4001, "unknown-message");
    }
  }

  sendInspectSet(enabled: boolean): void {
    this.socket?.send(JSON.stringify({ version: 1, type: "inspect:set", enabled }));
  }

  async waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`bridge timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async stop(): Promise<void> {
    this.socket?.close();
    if (this.wss) await new Promise((res) => this.wss?.close(() => res(undefined)));
  }
}

// ---------------------------------------------------------------------------

export interface SafeRead {
  /** LF-normalized text — the editor buffer. */
  content: string;
  /** SHA-256 of raw disk bytes — the optimistic-concurrency token. */
  hash: string;
  lineEnding: "lf" | "crlf";
  bom: boolean;
}

export class SourceEditConflict extends Error {
  constructor(public diskHash: string) {
    super("SOURCE_EDIT_CONFLICT");
    this.name = "SourceEditConflict";
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Mirror of `editor::file::read_source_file`. */
export function safeRead(absPath: string): SafeRead {
  const raw = readFileSync(absPath);
  if (raw.subarray(0, 8192).includes(0)) throw new Error("SOURCE_FILE_BINARY");
  const bom = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = (bom ? raw.subarray(3) : raw).toString("utf8");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/\n/g) ?? []).length - crlf;
  const lineEnding = crlf > bareLf ? "crlf" : "lf";
  return {
    content: lineEnding === "crlf" ? text.replaceAll("\r\n", "\n") : text,
    hash: sha256Hex(raw),
    lineEnding,
    bom,
  };
}

/** Mirror of `editor::file::write_source_file` — hash-checked atomic write. */
export function safeSave(absPath: string, content: string, expectedHash: string): string {
  const disk = readFileSync(absPath);
  const diskHash = sha256Hex(disk);
  if (diskHash !== expectedHash) throw new SourceEditConflict(diskHash);
  const session = safeRead(absPath);
  const body = session.lineEnding === "crlf" ? content.replaceAll("\n", "\r\n") : content;
  const bytes = session.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")])
    : Buffer.from(body, "utf8");
  const dir = join(absPath, "..");
  const name = absPath.split(/[\\/]/).pop() ?? "rootray";
  const tmp = join(dir, `.${name}.rootray-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, bytes);
    // Windows: a dev server's file watcher can hold a transient handle on the
    // target, making rename-over-existing fail with EPERM/EBUSY. Retry on a
    // bounded backoff — the mirror should behave like the production writer.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, absPath);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 20) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
  return sha256Hex(bytes);
}

// ---------------------------------------------------------------------------

/** Hash every project-owned file (never node_modules / dist) into one digest. */
export function projectDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (["node_modules", "dist", ".git"].includes(entry)) continue;
      const abs = join(dir, relPath);
      if (statSync(abs).isDirectory()) walk(relPath);
      else {
        hash.update(relPath);
        hash.update(readFileSync(abs));
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

/** Find the 1-based line of the first line containing `needle`. */
export function sourceLineOf(file: string, needle: string): number {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`${needle} not found in ${file}`);
  return idx + 1;
}

export function npm(args: string, cwd: string): void {
  execSync(`npm ${args}`, { cwd, stdio: "pipe" });
}

export function waitForRunnerUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = "";
    const timer = setTimeout(
      () => rejectPromise(new Error(`runner URL timeout. Output:\n${out}`)),
      90_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip Vite ANSI colors
      const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
      const m = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
      if (m) {
        clearTimeout(timer);
        resolvePromise(m[0]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`runner exited (${code}). Output:\n${out}`));
    });
  });
}

export interface FixtureRun {
  workDir: string;
  appUrl: string;
  bridge: MockBridge;
  runner: ChildProcess;
}

/**
 * Copies the fixture into a repo-local `.e2e-work/` dir (see the comment
 * in `inspector.spec.ts` — it must live inside the Vite workspace root and
 * outside its watch-ignore list), installs deps, and starts the real
 * runner against a fresh mock bridge.
 */
export async function startFixture(vitePort: number): Promise<FixtureRun> {
  const workParent = join(REPO_ROOT, ".e2e-work");
  mkdirSync(workParent, { recursive: true });
  const workDir = mkdtempSync(join(workParent, "edit-"));
  // The fixture now carries a real package-lock.json + node_modules for the
  // installed-app golden path; the temp copy must not inherit node_modules —
  // `npm install` below rebuilds it deterministically from the lockfile.
  cpSync(FIXTURE, workDir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  npm("install --no-audit --no-fund --loglevel=error", workDir);

  const bridge = new MockBridge();
  await bridge.start();
  const runner = spawn(
    process.execPath,
    [RUNNER, "--root", workDir, "--port", String(vitePort), "--strictPort"],
    {
      // cwd == --root mirrors how RootRay launches the runner for real.
      cwd: workDir,
      env: {
        ...process.env,
        ROOTRAY_PROJECT_ROOT: workDir,
        ROOTRAY_BRIDGE_URL: `ws://127.0.0.1:${bridge.port}/rootray`,
        ROOTRAY_SESSION_ID: SESSION_ID,
        ROOTRAY_SESSION_TOKEN: SESSION_TOKEN,
        ROOTRAY_PLUGIN_PATH: PLUGIN,
        ROOTRAY_RUNTIME_PATH: RUNTIME_BUNDLE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appUrl = await waitForRunnerUrl(runner);
  return { workDir, appUrl, bridge, runner };
}

// ---------------------------------------------------------------------------
// Next.js launch — mirrors crates/rootray-core/src/inspector/launch.rs:
// `node --require <next-shim.cjs> <next-bin> dev <args>` with the shim env
// contract and the session entry at node_modules/.cache/rootray/entry.js
// (stable path — bundler caches may still import it after a session ends).
// ---------------------------------------------------------------------------

export const NEXT_SHIM = join(REPO_ROOT, "packages", "next-adapter", "dist", "next-shim.cjs");
export const NEXT_LOADER = join(REPO_ROOT, "packages", "next-adapter", "dist", "jsx-loader.cjs");

export interface NextFixtureRun {
  workDir: string;
  appUrl: string;
  bridge: MockBridge;
  runner: ChildProcess;
  scratchDir: string;
}

/**
 * Copies a Next fixture into `.e2e-work/`, installs deps, writes the session
 * entry module (same shape as `write_next_entry` in launch.rs) and spawns
 * `next dev` under the RootRay shim.
 */
export async function startNextFixture(
  fixtureDir: string,
  port: number,
  extraNextArgs: string[] = [],
): Promise<NextFixtureRun> {
  const workParent = join(REPO_ROOT, ".e2e-work");
  mkdirSync(workParent, { recursive: true });
  const workDir = mkdtempSync(join(workParent, "next-"));
  cpSync(fixtureDir, workDir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(`${sep()}.next`),
  });
  npm("install --no-audit --no-fund --loglevel=error", workDir);

  const bridge = new MockBridge();
  await bridge.start();

  const scratchDir = join(workDir, "node_modules", ".cache", "rootray");
  mkdirSync(scratchDir, { recursive: true });
  const runtime = readFileSync(RUNTIME_BUNDLE, "utf8");
  const config = JSON.stringify({
    bridgeUrl: `ws://127.0.0.1:${bridge.port}/rootray`,
    sessionId: SESSION_ID,
    token: SESSION_TOKEN,
    version: 1,
    projectRoot: workDir,
  });
  writeFileSync(
    join(scratchDir, "entry.js"),
    `if (typeof window !== "undefined") {\nwindow.__ROOTRAY__=${config};\n${runtime}}\n`,
  );

  const nextBin = join(workDir, "node_modules", "next", "dist", "bin", "next");
  const runner = spawn(
    process.execPath,
    ["--require", NEXT_SHIM, nextBin, "dev", "-p", String(port), ...extraNextArgs],
    {
      cwd: workDir,
      env: {
        ...process.env,
        ROOTRAY_PROJECT_ROOT: workDir,
        ROOTRAY_NEXT_LOADER: NEXT_LOADER,
        ROOTRAY_NEXT_ENTRY: join(scratchDir, "entry.js"),
        ROOTRAY_BRIDGE_URL: `ws://127.0.0.1:${bridge.port}/rootray`,
        ROOTRAY_SESSION_ID: SESSION_ID,
        ROOTRAY_SESSION_TOKEN: SESSION_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appUrl = await waitForRunnerUrl(runner);
  return { workDir, appUrl, bridge, runner, scratchDir };
}

export async function stopNextFixture(run: NextFixtureRun | undefined): Promise<void> {
  if (!run) return;
  const exited = run.runner
    ? new Promise<void>((r) => run.runner.once("exit", () => r()))
    : Promise.resolve();
  run.runner?.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
  // Next spawns router/render workers — on Windows the tree can outlive the
  // parent, so force-kill anything still holding the port before cleanup.
  await run.bridge?.stop();
  if (run.workDir) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run.workDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i === 19) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export async function stopFixture(run: FixtureRun | undefined): Promise<void> {
  if (!run) return;
  // The runner's cwd is the work dir — Windows holds a lock on it until the
  // process tree is fully gone, so wait for exit before removing.
  const exited = run.runner
    ? new Promise<void>((r) => run.runner.once("exit", () => r()))
    : Promise.resolve();
  run.runner?.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  await run.bridge?.stop();
  if (run.workDir) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run.workDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i === 19) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
}
