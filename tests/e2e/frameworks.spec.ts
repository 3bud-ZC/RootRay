/**
 * Broader-framework end-to-end coverage (v0.2.0 final).
 *
 * Real Vue 3 + Vite and Svelte 5 + Vite fixtures run through the real
 * inspector runner in `generic-dom` mode — the same adapter every
 * Vite-driven stack shares. Proves the Tier B contract:
 *
 *   framework renders real DOM → bridge connects → authored index.html
 *   elements keep exact source stamps → framework-rendered nodes select
 *   with facts/styles but NO source (never fabricated) → project source
 *   stays untouched.
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
  waitForRunnerUrl,
} from "./harness";

// beforeAll performs a cold `npm install` in a temp fixture copy.
test.setTimeout(300_000);
test.describe.configure({ mode: "serial" });

interface Selection {
  element: { tagName: string; id?: string };
  source?: { relativePath: string; line: number; column: number };
  styles?: { classes: string[] };
}

interface StackRun {
  workDir: string;
  appUrl: string;
  bridge: MockBridge;
  runner: ChildProcess;
  baseline: string;
}

async function startStack(fixtureName: string, vitePort: number): Promise<StackRun> {
  const workParent = join(REPO_ROOT, ".e2e-work");
  mkdirSync(workParent, { recursive: true });
  const workDir = mkdtempSync(join(workParent, `${fixtureName}-`));
  cpSync(join(REPO_ROOT, "fixtures", fixtureName), workDir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  npm("install --no-audit --no-fund --loglevel=error", workDir);
  const baseline = projectDigest(workDir);

  const bridge = new MockBridge();
  await bridge.start();
  const runner = spawn(
    process.execPath,
    [RUNNER, "--root", workDir, "--port", String(vitePort), "--strictPort"],
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
        ROOTRAY_INSPECTOR_MODE: "generic-dom",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appUrl = await waitForRunnerUrl(runner);
  return { workDir, appUrl, bridge, runner, baseline };
}

async function stopStack(run: StackRun | undefined): Promise<void> {
  if (!run) return;
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

const STACKS = [
  {
    name: "Vue + Vite",
    fixture: "vue-vite",
    port: 5448,
    rendered: { selector: "#vue-counter", tag: "button", text: /Count is/ },
    authored: { selector: "h1", text: "Vue + Vite fixture" },
  },
  {
    name: "Svelte + Vite",
    fixture: "svelte-vite",
    port: 5449,
    rendered: { selector: "#svelte-counter", tag: "button", text: /Count is/ },
    authored: { selector: "h1", text: "Svelte + Vite fixture" },
  },
];

for (const stack of STACKS) {
  test.describe(stack.name, () => {
    let run: StackRun | undefined;

    test.beforeAll(async () => {
      run = await startStack(stack.fixture, stack.port);
    });
    test.afterAll(async () => {
      await stopStack(run);
    });

    test(`${stack.name}: bridge connects and authored HTML maps exactly`, async ({ page }) => {
      await page.goto(run!.appUrl);
      const heading = page.locator(stack.authored.selector, { hasText: stack.authored.text });
      await expect(heading).toBeVisible();
      await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready");
      expect(run!.bridge.rejected).toEqual([]);

      // The authored shell element carries an exact index.html stamp.
      await expect(heading).toHaveAttribute("data-rootray-file", "index.html");

      run!.bridge.sendInspectSet(true);
      const before = run!.bridge.selections.length;
      await heading.click();
      await run!.bridge.waitFor(() => run!.bridge.selections.length > before, "element:selected");
      const sel = run!.bridge.selections[run!.bridge.selections.length - 1] as Selection;
      expect(sel.source?.relativePath).toBe("index.html");
      expect(sel.source?.line).toBeGreaterThan(0);
    });

    test(`${stack.name}: framework-rendered DOM selects honestly — no fabricated source`, async ({
      page,
    }) => {
      await page.goto(run!.appUrl);
      await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready");

      const rendered = page.locator(stack.rendered.selector);
      await expect(rendered).toBeVisible();
      // Vue/Svelte produce this node at runtime — it has no authored stamp.
      expect(await rendered.getAttribute("data-rootray-file")).toBeNull();

      run!.bridge.sendInspectSet(true);
      const before = run!.bridge.selections.length;
      await rendered.click();
      await run!.bridge.waitFor(() => run!.bridge.selections.length > before, "element:selected");
      const sel = run!.bridge.selections[run!.bridge.selections.length - 1] as Selection;
      expect(sel.element.tagName).toBe(stack.rendered.tag);
      expect("source" in sel).toBe(false);
      // Style intelligence still attaches without a source.
      expect(sel.styles).toBeTruthy();

      // The inspection run left project source untouched.
      expect(projectDigest(run!.workDir)).toBe(run!.baseline);
    });
  });
}
