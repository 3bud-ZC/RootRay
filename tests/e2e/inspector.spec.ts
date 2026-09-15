/**
 * RootRay inspector end-to-end test.
 *
 * Runs a REAL React/Vite fixture through the real inspector runner
 * (`packages/vite-plugin/dist/runner.cjs`) in a real Chromium browser. The
 * WebSocket bridge is a protocol-faithful mock standing in for the Rust
 * bridge (the Rust side is covered by `inspector_bridge` tests) — it performs
 * the same token/version validation and speaks the same versioned protocol.
 *
 * Proves: runtime injection → bridge auth → inspect mode → hover overlay →
 * click → real file/line/column selection → click suppression → HMR →
 * zero project-source mutation.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { type WebSocket, WebSocketServer } from "ws";

// beforeAll performs a cold `npm install` in a temp fixture copy — on CI
// that can take minutes, well beyond Playwright's default 60s budget.
test.setTimeout(300_000);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "fixtures", "vite-react-inspector");
const RUNNER = join(REPO_ROOT, "packages", "vite-plugin", "dist", "runner.cjs");
const PLUGIN = join(REPO_ROOT, "packages", "vite-plugin", "dist", "plugin.cjs");
const RUNTIME_BUNDLE = join(REPO_ROOT, "packages", "inspector-runtime", "dist", "runtime.js");

const SESSION_ID = `e2e-${randomBytes(6).toString("hex")}`;
const SESSION_TOKEN = randomBytes(32).toString("hex");
const VITE_PORT = 5444;

// ---------------------------------------------------------------------------

/** Protocol-faithful stand-in for the Rust inspector bridge. */
class MockBridge {
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

let workDir = "";
let runner: ChildProcess | null = null;
const bridge = new MockBridge();
let appUrl = "";

/** Hash every project-owned file (never node_modules / dist) into one digest. */
function projectDigest(dir: string): string {
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
function sourceLineOf(file: string, needle: string): number {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`${needle} not found in ${file}`);
  return idx + 1;
}

function npm(args: string, cwd: string): void {
  execSync(`npm ${args}`, { cwd, stdio: "pipe" });
}

function waitForRunnerUrl(child: ChildProcess): Promise<string> {
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

// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });
let integrityBaseline = "";

test.beforeAll(async () => {
  // The working copy must live inside the repo: hosted runners set TMPDIR
  // to an 8.3 short path (C:\Users\RUNNER~1\...) that fails Vite's realpath
  // fs.allow check with a 403. It cannot live under test-results/ or
  // playwright-report/ — Vite's default watch-ignore list covers those
  // dirs, which silently disables HMR. .e2e-work/ is gitignored.
  const workParent = join(REPO_ROOT, ".e2e-work");
  mkdirSync(workParent, { recursive: true });
  workDir = mkdtempSync(join(workParent, "fixture-"));
  cpSync(FIXTURE, workDir, { recursive: true });
  npm("install --no-audit --no-fund --loglevel=error", workDir);
  integrityBaseline = projectDigest(workDir);

  await bridge.start();
  runner = spawn(
    process.execPath,
    [RUNNER, "--root", workDir, "--port", String(VITE_PORT), "--strictPort"],
    {
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
  // Keep the host exactly as Vite prints it — hosted runners may bind
  // localhost to ::1 only, so rewriting to 127.0.0.1 breaks the page load.
  appUrl = await waitForRunnerUrl(runner);
});

test.afterAll(async () => {
  runner?.kill("SIGTERM");
  await bridge.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

/** Dump page state + console errors so CI failures are diagnosable. */
async function gotoAndWaitForApp(page: import("@playwright/test").Page): Promise<void> {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(appUrl);
  try {
    await expect(page.locator("text=Inspector fixture")).toBeVisible();
  } catch (e) {
    const html = (await page.content()).slice(0, 3000);
    console.error(
      `[e2e] app did not render.\nurl=${page.url()}\ntitle=${await page.title()}\n` +
        `consoleErrors=${JSON.stringify(consoleErrors)}\nhtml=${html}`,
    );
    throw e;
  }
}

test("runtime injects, authenticates, and reaches ready state", async ({ page }) => {
  await gotoAndWaitForApp(page);

  // Runtime bootstrap + client present in the page.
  const hasRuntime = await page.evaluate(
    () =>
      typeof (window as unknown as { __ROOTRAY_RUNTIME__?: unknown }).__ROOTRAY_RUNTIME__ ===
      "object",
  );
  expect(hasRuntime).toBe(true);

  // Bridge handshake completed with the correct token.
  await bridge.waitFor(() => bridge.ready, "runtime:ready");
  expect(bridge.rejected).toEqual([]);
  expect(bridge.helloPageUrl).toContain(`:${VITE_PORT}`);
});

test("inspect → hover → overlay → click → real source selection", async ({ page }) => {
  await gotoAndWaitForApp(page);
  await bridge.waitFor(() => bridge.ready, "runtime:ready");
  bridge.sendInspectSet(true);

  const button = page.locator("button", { hasText: "Count is" });
  await expect(button).toBeVisible();

  // Instrumented element carries source metadata in the DOM.
  const file = await button.getAttribute("data-rootray-file");
  expect(file).toBe("src/components/ActionButton.tsx");

  await button.hover();

  // Shadow-DOM overlay: highlight box + label naming the real source file.
  await expect(page.locator(".rr-box")).toBeVisible();
  const buttonSourceFile = join(workDir, "src", "components", "ActionButton.tsx");
  const expectedLine = sourceLineOf(buttonSourceFile, "<button");
  await expect(page.locator(".rr-label .rr-name")).toHaveText("ActionButton");
  await expect(page.locator(".rr-label .rr-loc")).toContainText(
    `src/components/ActionButton.tsx:${expectedLine}`,
  );

  await button.click();

  await bridge.waitFor(() => bridge.selections.length > 0, "element:selected");
  const sel = bridge.selections[0] as {
    sessionId: string;
    element: { tagName: string; textPreview?: string };
    source: { relativePath: string; line: number; column: number; componentName?: string };
  };
  expect(sel.sessionId).toBe(SESSION_ID);
  expect(sel.element.tagName).toBe("button");
  expect(sel.source.relativePath).toBe("src/components/ActionButton.tsx");
  expect(sel.source.line).toBe(expectedLine);
  expect(sel.source.column).toBeGreaterThan(0);
  expect(sel.source.componentName).toBe("ActionButton");

  // The inspected click must NOT have fired the app's onClick.
  await expect(button).toHaveText("Count is 0");

  // Inspection itself left the project source untouched.
  expect(projectDigest(workDir)).toBe(integrityBaseline);

  // Disable inspection → normal app behavior returns.
  bridge.sendInspectSet(false);
  await button.click();
  await expect(button).toHaveText("Count is 1");
});

test("HMR works through RootRay instrumentation and stays instrumented", async ({ page }) => {
  await gotoAndWaitForApp(page);
  // Let the Vite HMR websocket connect before editing — an update emitted
  // before the client subscribes is silently dropped.
  await page.waitForTimeout(1_500);

  const cardFile = join(workDir, "src", "components", "Card.tsx");
  const original = readFileSync(cardFile, "utf8");
  writeFileSync(cardFile, original.replace("{title}", "HMR live edit"));

  await expect(page.locator("h2", { hasText: "HMR live edit" })).toBeVisible({ timeout: 30_000 });

  // HMR-updated DOM still carries source metadata.
  const heading = page.locator("h2", { hasText: "HMR live edit" });
  await expect(heading).toHaveAttribute("data-rootray-file", "src/components/Card.tsx");
});
