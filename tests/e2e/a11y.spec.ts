/**
 * Accessibility + keyboard-flow pass on the REAL built desktop UI.
 *
 * The RootRay frontend is served statically (vite preview of dist/) with
 * `window.__TAURI_INTERNALS__` stubbed — commands resolve to canned data
 * and `rootray://` events can be pushed from the test. This is the only
 * way to exercise the production shell without a WebView2 driver, and it
 * keeps every assertion honest: the DOM, CSS, focus handling and keyboard
 * paths under test are the shipped ones.
 *
 * Covers: axe critical/serious violations on Home and Project views,
 * visible focus, labeled controls, Ctrl+P / Ctrl+Shift+F keyboard flow,
 * Escape dismissal, and the error-boundary recovery surface.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { stubTauri } from "./stub";

test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

const DESKTOP = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "desktop");
const PORT = 5611;
const URL = `http://localhost:${PORT}/`;

let server: ChildProcess | undefined;

// ---- Tauri internals stub ----------------------------------------------------

const CAP = { state: "available" };
const FULL_CAPS = {
  workspaceBrowse: CAP,
  workspaceSearch: CAP,
  quickOpen: CAP,
  quickEdit: CAP,
  safeWrite: CAP,
  openExternal: CAP,
  run: CAP,
  browserOpen: CAP,
  domInspect: CAP,
  styleInspect: CAP,
  sourceMapping: CAP,
  componentIntelligence: CAP,
  hmrAware: CAP,
};

const CANNED_TARGET = {
  id: "root",
  name: "demo-app",
  relativeRoot: "",
  absoluteRoot: "C:/fixture/project",
  kind: "web-app",
  framework: "vite-react",
  frameworkVersion: "7.0.0",
  languages: ["TypeScript"],
  technologies: [
    { name: "React", version: "19.0.0", evidence: ["package.json dependency"] },
    { name: "Vite", version: "7.0.0", evidence: ["package.json dependency"] },
  ],
  packageManager: "pnpm",
  devScript: "vite",
  runnerCandidates: [
    {
      scriptName: "dev",
      display: "pnpm run dev",
      confidence: 100,
      reason: 'conventional dev script: "dev": "vite"',
    },
  ],
  selectedRunner: {
    executable: "pnpm.cmd",
    args: ["run", "dev"],
    display: "pnpm run dev",
    cwd: "C:/fixture/project",
  },
  capabilities: FULL_CAPS,
  evidence: [],
};

const CANNED_ANALYSIS = {
  root: "C:/fixture/project",
  name: "demo-app",
  workspaceKind: "single-package",
  packageManager: "pnpm",
  manifests: ["package.json"],
  technologies: CANNED_TARGET.technologies,
  targets: [CANNED_TARGET],
  activeTargetId: "root",
  capabilities: FULL_CAPS,
  findings: [],
  warnings: [],
  discovery: {
    dirsVisited: 3,
    manifestsRead: 1,
    metadataBytes: 512,
    targetsFound: 1,
    elapsedMs: 1,
    truncated: false,
  },
};

const RUNTIME_WITH_PROJECT = {
  phase: "ready",
  workspace: CANNED_ANALYSIS,
  pid: null,
  command: null,
  url: null,
  port: null,
  startedAt: null,
  error: null,
  recentLogs: [],
};

const CANNED: Record<string, unknown> = {
  get_runtime_state: {
    phase: "idle",
    workspace: null,
    pid: null,
    command: null,
    url: null,
    port: null,
    startedAt: null,
    error: null,
    recentLogs: [],
  },
  get_inspector_state: {
    phase: "inactive",
    sessionId: null,
    port: null,
    pageUrl: null,
    connectedAt: null,
    inspectionEnabled: false,
    lastSelection: null,
    error: null,
  },
  get_editor_state: { active: false, relativePath: null, dirty: false, status: "closed" },
  get_settings: {
    recentProjects: [],
    preferredLauncher: "vscode",
    openBrowserAutomatically: false,
    lastProject: null,
  },
  detect_editors: [
    { id: "vscode", name: "VS Code", executablePath: "code.cmd", available: true },
    { id: "cursor", name: "Cursor", executablePath: null, available: false },
  ],
  analyze_project: CANNED_ANALYSIS,
  list_project_files: {
    paths: ["src/App.tsx", "src/components/Navbar.tsx", "src/styles/app.css", "package.json"],
    truncated: false,
  },
  search_workspace: {
    query: "ActionButton",
    truncated: false,
    filesScanned: 4,
    matches: [
      {
        relativePath: "src/components/Card.tsx",
        line: 8,
        column: 7,
        preview: "<ActionButton />",
      },
    ],
  },
  collect_source_files: { files: [], truncated: false, totalBytes: 0 },
  get_diagnostics: { version: "0.1.0", os: "windows", arch: "x86_64" },
  "plugin:dialog|open": null,
};

async function emitRuntime(page: import("@playwright/test").Page) {
  await page.evaluate(
    (rt) =>
      (window as unknown as { __RR_EMIT__: (e: string, p: unknown) => void }).__RR_EMIT__(
        "rootray://state",
        rt,
      ),
    RUNTIME_WITH_PROJECT,
  );
}

// ---- server -------------------------------------------------------------------

test.beforeAll(async () => {
  test.skip(
    !existsSync(join(DESKTOP, "dist", "index.html")),
    "apps/desktop/dist missing — run `pnpm --filter @rootray/desktop build` first",
  );
  server = spawn("pnpm", ["exec", "vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: DESKTOP,
    shell: true,
    stdio: "pipe",
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("vite preview did not start");
});

test.afterAll(() => {
  server?.kill();
});

// ---- tests ---------------------------------------------------------------------

test("home view passes axe serious/critical checks", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await expect(page.locator("text=Open a workspace")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(bad, JSON.stringify(bad.map((v) => v.id))).toEqual([]);
});

test("project view passes axe serious/critical checks", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible({ timeout: 10_000 });
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(bad, JSON.stringify(bad.map((v) => v.id))).toEqual([]);
});

test("Ctrl+P opens Quick Open; keyboard selects a file into Quick Edit", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible();

  await page.keyboard.press("Control+p");
  const input = page.locator(".palette-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused(); // autofocus — palette is keyboard-first

  await page.keyboard.type("nav");
  const item = page.locator(".palette-item", { hasText: "Navbar.tsx" });
  await expect(item).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  // The pick must reach open_source_editor through Quick Edit.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as unknown as { __RR_CALLS__: { cmd: string }[] }).__RR_CALLS__.some(
          (c) => c.cmd === "open_source_editor",
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator(".palette")).not.toBeVisible();
});

test("Ctrl+Shift+F opens Workspace Search; Escape closes", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible();

  await page.keyboard.press("Control+Shift+F");
  const input = page.locator(".palette-input");
  await expect(input).toBeVisible();
  await page.keyboard.type("ActionButton");
  await expect(page.locator(".palette-item").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).not.toBeVisible();
});

test("explorer tree is keyboard navigable", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible();

  const rows = page.locator(".ex-row");
  const before = await rows.count();
  const srcRow = page.locator(".ex-row", { hasText: "src" }).first();
  await srcRow.focus();
  await page.keyboard.press("Enter"); // expand — canned listing fills children
  await expect.poll(async () => rows.count()).toBeGreaterThan(before);
  // A directory row must remain focusable (button, not bare div).
  await expect(srcRow).toHaveJSProperty("tagName", "BUTTON");
});

test("malformed backend payload never blanks the shell", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible();

  // A bad wire payload must degrade to a notice, not a white screen.
  await page.evaluate(() => {
    const w = window as unknown as { __RR_EMIT__: (e: string, p: unknown) => void };
    w.__RR_EMIT__("rootray://state", { phase: 42, workspace: "not-an-object" });
  });
  await expect(page.locator("body")).not.toBeEmpty();
  // The project view (or boundary recovery) must still be present.
  await expect(page.locator(".app-shell, .crash-view").first()).toBeVisible();
});

// ---- v0.1.1 regression: Open Project must reach the project view ---------

test("Open Project transitions to ProjectView when state is emitted", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await expect(page.locator("text=Open a workspace")).toBeVisible();

  await page.getByRole("button", { name: "Open Project" }).click();

  // The emitted rootray://state snapshot must switch the shell.
  await expect(page.locator("text=demo-app")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=React + Vite 7.0.0")).toBeVisible();
  await expect(page.getByText("pnpm", { exact: true })).toBeVisible();
  await expect(page.locator("text=pnpm run dev")).toBeVisible();
});

test("Change Project re-analysis updates the visible project", async ({ page }) => {
  await stubTauri(page, { canned: CANNED, runtime: RUNTIME_WITH_PROJECT });
  await page.goto(URL);
  await emitRuntime(page);
  await expect(page.locator("text=demo-app")).toBeVisible();

  // "Change project" re-picks a directory and re-analyzes — the stub emits
  // the new project snapshot before resolving. The frontend calls the
  // serialized change_project command (stop+analyze under one hold).
  const change = page.getByRole("button", { name: "Change…" });
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.locator("text=demo-app")).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __RR_CALLS__: { cmd: string }[] }).__RR_CALLS__.filter(
            (c) => c.cmd === "change_project",
          ).length,
      ),
    )
    .toBe(1); // emitRuntime bypassed analyze; the change click is call #1
});
