/**
 * Generic (non-React) inspector end-to-end test.
 *
 * Runs a real vanilla-TS Vite fixture through the real inspector runner
 * in `generic-dom` mode — no JSX, no React, no framework instrumentation.
 * The plugin's `transformIndexHtml` stamps authored index.html elements;
 * runtime-created DOM is reported WITHOUT a source.
 *
 * Proves: authored HTML elements map exactly to index.html source →
 * runtime-created elements select with facts/styles but no source →
 * authored <canvas> maps → click suppression works for unmapped nodes →
 * zero project-source mutation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  MockBridge,
  npm,
  PLUGIN,
  projectDigest,
  REPO_ROOT,
  RUNNER,
  RUNTIME_BUNDLE,
  SESSION_ID,
  SESSION_TOKEN,
  sourceLineOf,
  waitForRunnerUrl,
} from "./harness";

// beforeAll performs a cold `npm install` in a temp fixture copy.
test.setTimeout(300_000);

const FIXTURE = join(REPO_ROOT, "fixtures", "vite-vanilla");
const VITE_PORT = 5447;

test.describe.configure({ mode: "serial" });

let workDir = "";
let runner: ChildProcess | null = null;
const bridge = new MockBridge();
let appUrl = "";
let integrityBaseline = "";

test.beforeAll(async () => {
  const workParent = join(REPO_ROOT, ".e2e-work");
  mkdirSync(workParent, { recursive: true });
  workDir = mkdtempSync(join(workParent, "generic-"));
  cpSync(FIXTURE, workDir, { recursive: true });
  npm("install --no-audit --no-fund --loglevel=error", workDir);
  integrityBaseline = projectDigest(workDir);

  await bridge.start();
  runner = spawn(
    process.execPath,
    [RUNNER, "--root", workDir, "--port", String(VITE_PORT), "--strictPort"],
    {
      cwd: workDir,
      env: {
        ...process.env,
        ROOTRAY_PROJECT_ROOT: workDir,
        ROOTRAY_BRIDGE_URL: `ws://127.0.0.1:${bridge.port}/rootray`,
        ROOTRAY_SESSION_ID: SESSION_ID,
        ROOTRAY_SESSION_TOKEN: SESSION_TOKEN,
        ROOTRAY_PLUGIN_PATH: PLUGIN,
        ROOTRAY_RUNTIME_PATH: RUNTIME_BUNDLE,
        // The non-React Vite path — every DOM element is inspectable.
        ROOTRAY_INSPECTOR_MODE: "generic-dom",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  appUrl = await waitForRunnerUrl(runner);
});

test.afterAll(async () => {
  // The runner's cwd is the work dir — Windows holds a lock on it until
  // the process tree is fully gone, so wait for exit before removing.
  // (Same contract as `stopFixture` in harness.ts.)
  const exited = runner
    ? new Promise<void>((r) => runner!.once("exit", () => r()))
    : Promise.resolve();
  runner?.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  await bridge.stop();
  if (workDir) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(workDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i === 19) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

async function gotoApp(page: import("@playwright/test").Page): Promise<void> {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(appUrl);
  try {
    await expect(page.locator("text=Vanilla Vite fixture")).toBeVisible();
    await expect(page.locator("#dynamic-note")).toBeVisible();
  } catch (e) {
    const html = (await page.content()).slice(0, 3000);
    console.error(
      `[e2e] generic app did not render.\nurl=${page.url()}\n` +
        `consoleErrors=${JSON.stringify(consoleErrors)}\nhtml=${html}`,
    );
    throw e;
  }
  await bridge.waitFor(() => bridge.ready, "runtime:ready");
}

interface Selection {
  sessionId: string;
  element: { tagName: string; id?: string };
  source?: { relativePath: string; line: number; column: number };
  styles?: { classes: string[] };
}

test("runtime connects in generic-dom mode and reaches ready", async ({ page }) => {
  await gotoApp(page);
  const hasRuntime = await page.evaluate(
    () =>
      typeof (window as unknown as { __ROOTRAY_RUNTIME__?: unknown }).__ROOTRAY_RUNTIME__ ===
      "object",
  );
  expect(hasRuntime).toBe(true);
  expect(bridge.rejected).toEqual([]);
  expect(bridge.helloPageUrl).toContain(`:${VITE_PORT}`);
});

test("authored HTML elements map exactly to index.html", async ({ page }) => {
  await gotoApp(page);
  bridge.sendInspectSet(true);

  const heading = page.locator("h1", { hasText: "Vanilla Vite fixture" });
  await expect(heading).toBeVisible();
  // The authored h1 carries a real index.html stamp.
  await expect(heading).toHaveAttribute("data-rootray-file", "index.html");

  const before = bridge.selections.length;
  await heading.click();
  await bridge.waitFor(() => bridge.selections.length > before, "element:selected");
  const sel = bridge.selections[bridge.selections.length - 1] as Selection;
  const expectedLine = sourceLineOf(join(workDir, "index.html"), "<h1>");
  expect(sel.element.tagName).toBe("h1");
  expect(sel.source?.relativePath).toBe("index.html");
  expect(sel.source?.line).toBe(expectedLine);
  expect(sel.source?.column).toBeGreaterThan(0);
});

test("runtime-created DOM selects with facts and styles but no source", async ({ page }) => {
  await gotoApp(page);
  bridge.sendInspectSet(true);

  const note = page.locator("#dynamic-note");
  await expect(note).toBeVisible();
  // Created by main.ts — never authored in index.html.
  expect(await note.getAttribute("data-rootray-file")).toBeNull();

  const before = bridge.selections.length;
  await note.click();
  await bridge.waitFor(() => bridge.selections.length > before, "element:selected");
  const sel = bridge.selections[bridge.selections.length - 1] as Selection;
  expect(sel.element.tagName).toBe("p");
  expect(sel.element.id).toBe("dynamic-note");
  // Honest: no fabricated source.
  expect("source" in sel).toBe(false);
  // Styles still attach independently of a source mapping.
  expect(sel.styles).toBeTruthy();
  expect(sel.styles?.classes).toBeDefined();
});

test("authored canvas maps to index.html; inspection suppresses app clicks", async ({ page }) => {
  await gotoApp(page);
  bridge.sendInspectSet(true);

  const canvas = page.locator("#arena");
  await expect(canvas).toHaveAttribute("data-rootray-file", "index.html");

  const before = bridge.selections.length;
  await canvas.click();
  await bridge.waitFor(() => bridge.selections.length > before, "element:selected");
  const sel = bridge.selections[bridge.selections.length - 1] as Selection;
  expect(sel.element.tagName).toBe("canvas");
  expect(sel.source?.relativePath).toBe("index.html");
  const expectedLine = sourceLineOf(join(workDir, "index.html"), "<canvas");
  expect(sel.source?.line).toBe(expectedLine);

  // Suppression: the inspected click must not reach app handlers.
  const clicks = await page.evaluate(() => {
    const el = document.getElementById("dynamic-note");
    let n = 0;
    el?.addEventListener("click", () => n++);
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return n;
  });
  expect(clicks).toBe(0);

  // Inspection left the project source untouched.
  expect(projectDigest(workDir)).toBe(integrityBaseline);
});

test("Escape requests inspection off from the runtime", async ({ page }) => {
  await gotoApp(page);
  bridge.sendInspectSet(true);
  const before = bridge.runtimeInspectSets.length;
  await page.keyboard.press("Escape");
  await bridge.waitFor(
    () => bridge.runtimeInspectSets.length > before,
    "runtime inspect:set(false)",
  );
  expect(bridge.runtimeInspectSets[bridge.runtimeInspectSets.length - 1]).toBe(false);
});
