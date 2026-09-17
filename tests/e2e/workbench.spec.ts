/**
 * Integrated Browser Workbench specs on the REAL built desktop UI
 * (vite preview + Tauri stub). The stub mirrors the native preview
 * contract — commands mutate a snapshot and emit rootray://preview-state —
 * so these specs cover the workbench's React-side wiring: toolbar,
 * Interact/Inspect modes, click→source auto-reveal, tab/layout switching,
 * modal surface coverage and rapid-selection ordering.
 *
 * Native WebView2 placement, real navigation and IPC isolation are covered
 * by the installed golden (tests/e2e/installed-golden-internal-preview.mjs).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { stubTauri } from "./stub";

test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

const DESKTOP = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "desktop");
const PORT = 5620;
const URL = `http://localhost:${PORT}/`;
const APP_URL = "http://localhost:5173/";

let server: ChildProcess | undefined;

const CAP = { state: "available" };

const TARGET = {
  id: "root",
  name: "fixture-app",
  relativeRoot: "",
  absoluteRoot: "C:/fixture/app",
  kind: "web-app",
  framework: "vite-react",
  frameworkVersion: "7.1.0",
  languages: ["TypeScript"],
  technologies: [
    { name: "React", version: "19.0.0", evidence: ['package.json dependency "react"'] },
    { name: "Vite", version: "7.1.0", evidence: ['package.json dependency "vite"'] },
  ],
  packageManager: "npm",
  devScript: "vite",
  runnerCandidates: [
    {
      scriptName: "dev",
      display: "npm run dev",
      confidence: 100,
      reason: 'conventional dev script: "dev": "vite"',
    },
  ],
  selectedRunner: { executable: "npm.cmd", args: ["run", "dev"], display: "npm run dev" },
  capabilities: {
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
  },
  evidence: ['"vite" dependency: ^7.1.0'],
};

const WORKSPACE = {
  root: "C:/fixture/app",
  name: "fixture-app",
  workspaceKind: "single-package",
  packageManager: "npm",
  manifests: ["package.json"],
  technologies: TARGET.technologies,
  targets: [TARGET],
  activeTargetId: "root",
  capabilities: TARGET.capabilities,
  findings: [],
  warnings: [],
  discovery: {
    dirsVisited: 4,
    manifestsRead: 1,
    metadataBytes: 640,
    targetsFound: 1,
    elapsedMs: 2,
    truncated: false,
  },
};

const INSPECTOR_CONNECTED = {
  phase: "connected",
  sessionId: "s-1",
  port: 4700,
  pageUrl: APP_URL,
  connectedAt: Date.now(),
  inspectionEnabled: false,
  lastSelection: null,
  error: null,
};

function selection(path: string, line: number, tag = "button") {
  return {
    ...INSPECTOR_CONNECTED,
    phase: "inspecting",
    inspectionEnabled: true,
    lastSelection: {
      element: { tagName: tag, textPreview: "Click" },
      source: { relativePath: path, line, column: 5 },
    },
  };
}

function makeCanned(autoPreview = true) {
  const runtime = {
    phase: "ready",
    workspace: WORKSPACE,
    pid: null,
    command: null,
    url: null,
    port: null,
    startedAt: null,
    error: null,
    recentLogs: [],
  };
  return {
    runtime,
    canned: {
      analyze_project: WORKSPACE,
      start_dev_server: 4321,
      get_runtime_state: { ...runtime, phase: "idle", workspace: null },
      get_inspector_state: { ...INSPECTOR_CONNECTED, phase: "inactive", sessionId: null },
      get_editor_state: {
        open: false,
        relativePath: null,
        baseHash: null,
        diskHash: null,
        watching: false,
        canRevert: false,
      },
      get_settings: {
        recentProjects: [],
        preferredLauncher: "vscode",
        openBrowserAutomatically: autoPreview,
        openPreviewAutomatically: autoPreview,
        lastProject: null,
      },
      detect_editors: [],
      list_project_files: { paths: ["src/App.tsx"], truncated: false },
      search_workspace: { query: "x", truncated: false, filesScanned: 1, matches: [] },
      collect_source_files: { files: [], truncated: false, totalBytes: 0 },
      "plugin:dialog|open": null,
    } as Record<string, unknown>,
  };
}

async function calls(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate(
    (c) =>
      (
        window as unknown as { __RR_CALLS__: { cmd: string; args: Record<string, unknown> }[] }
      ).__RR_CALLS__
        .filter((x) => x.cmd === c)
        .map((x) => x.args),
    cmd,
  );
}

async function emitState(page: import("@playwright/test").Page, over: Record<string, unknown>) {
  const runtime = {
    phase: "running",
    workspace: WORKSPACE,
    pid: 4321,
    command: "npm run dev",
    url: APP_URL,
    port: 5173,
    startedAt: Date.now(),
    error: null,
    recentLogs: [],
  };
  await page.evaluate(
    (s) =>
      (window as unknown as { __RR_EMIT__: (e: string, p: unknown) => void }).__RR_EMIT__(
        "rootray://state",
        s,
      ),
    { ...runtime, ...over },
  );
}

async function emitInspector(
  page: import("@playwright/test").Page,
  state: Record<string, unknown>,
) {
  await page.evaluate(
    (s) =>
      (window as unknown as { __RR_EMIT__: (e: string, p: unknown) => void }).__RR_EMIT__(
        "rootray://inspector-state",
        s,
      ),
    state,
  );
}

async function goLive(page: import("@playwright/test").Page, autoPreview = true) {
  const { canned, runtime } = makeCanned(autoPreview);
  await stubTauri(page, { canned, runtime });
  await page.goto(URL);
  await page.getByRole("button", { name: "Open Project" }).click();
  await expect(page.getByRole("button", { name: "Run Project" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Run Project" }).click();
  await emitState(page, { phase: "starting", url: null });
  await emitState(page, {});
  await expect(page.locator(".preview-toolbar")).toBeVisible({ timeout: 10_000 });
}

// ---- server -----------------------------------------------------------------

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

// ---- specs ------------------------------------------------------------------

test("workbench: run creates the internal preview — no external browser", async ({ page }) => {
  await goLive(page);

  // The workbench layout is live: toolbar, host rect, side panes, logs.
  await expect(page.locator(".wb-left .explorer")).toBeVisible();
  await expect(page.locator(".wb-right .inspector")).toBeVisible();
  await expect(page.locator(".preview-host")).toBeVisible();

  // preview_create fired with the detected loopback URL + a real rect.
  await expect.poll(async () => (await calls(page, "preview_create")).length).toBe(1);
  const [created] = await calls(page, "preview_create");
  expect(created.url).toBe(APP_URL);
  const rect = created.rect as { x: number; y: number; width: number; height: number };
  expect(rect.width).toBeGreaterThan(100);
  expect(rect.height).toBeGreaterThan(100);

  // Chrome was NOT auto-opened — open_browser never fired.
  expect(await calls(page, "open_browser")).toHaveLength(0);

  // Toolbar shows the URL and the Connected phase.
  await expect(page.locator(".preview-url")).toHaveValue(APP_URL);
  await expect(page.locator(".preview-phase")).toContainText("Connected");

  // Bounds were pushed for the native surface.
  await expect
    .poll(async () => (await calls(page, "preview_set_bounds")).length)
    .toBeGreaterThan(0);
});

test("workbench: toolbar navigation + external open reach the native commands", async ({
  page,
}) => {
  await goLive(page);
  await expect.poll(async () => (await calls(page, "preview_create")).length).toBe(1);

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Forward" }).click();
  await page.getByRole("button", { name: "Reload" }).click();
  expect(await calls(page, "preview_back")).toHaveLength(1);
  expect(await calls(page, "preview_forward")).toHaveLength(1);
  expect(await calls(page, "preview_reload")).toHaveLength(1);

  // Editable URL accepts only loopback targets.
  const input = page.locator(".preview-url");
  await input.fill("http://127.0.0.1:5173/settings");
  await input.press("Enter");
  expect(await calls(page, "preview_navigate")).toHaveLength(1);
  await input.fill("https://example.com");
  await input.press("Enter");
  expect(await calls(page, "preview_navigate")).toHaveLength(1);
  await expect(page.locator(".notice")).toContainText("local dev URLs");

  // Open External goes through the loopback-validated path.
  await page.getByRole("button", { name: "External", exact: true }).click();
  expect(await calls(page, "open_browser")).toHaveLength(1);
});

test("workbench: Interact/Inspect toggle drives set_inspection; Ctrl+Shift+C and Escape work", async ({
  page,
}) => {
  await goLive(page);
  await emitInspector(page, INSPECTOR_CONNECTED);

  // Interact is the default — the Inspect segment is clickable.
  const inspectBtn = page.getByRole("button", { name: "Inspect", exact: true });
  const interactBtn = page.getByRole("button", { name: "Interact", exact: true });
  await expect(inspectBtn).toBeEnabled();
  await inspectBtn.click();
  expect((await calls(page, "set_inspection")).at(-1)).toEqual({ enabled: true });

  // Stub echoes the authoritative state → Inspect becomes the active seg.
  await expect(inspectBtn).toHaveClass(/active/);

  // Ctrl+Shift+C flips back to Interact.
  await page.keyboard.press("Control+Shift+C");
  await expect
    .poll(async () => (await calls(page, "set_inspection")).at(-1))
    .toEqual({ enabled: false });
  await expect(interactBtn).toHaveClass(/active/);

  // And back on again via the keyboard.
  await page.keyboard.press("Control+Shift+C");
  await expect
    .poll(async () => (await calls(page, "set_inspection")).at(-1))
    .toEqual({ enabled: true });

  // Escape while inspecting returns to Interact.
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await calls(page, "set_inspection")).at(-1))
    .toEqual({ enabled: false });
});

test("workbench: inspect selection auto-reveals source beside the preview", async ({ page }) => {
  await goLive(page);
  await emitInspector(page, selection("src/App.tsx", 12));

  // The selection renders in the inspector…
  await expect(page.locator(".sel-file")).toHaveText("src/App.tsx");
  // …and the editor opened automatically on the Split tab.
  await expect(page.locator(".qeditor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".qe-path")).toContainText("src/App.tsx");
  await expect(page.getByRole("tab", { name: "Split" })).toHaveAttribute("aria-selected", "true");
  // The preview host is still there — the reveal happens beside it.
  await expect(page.locator(".preview-host")).toBeVisible();
});

test("workbench: rapid selections settle on the newest source", async ({ page }) => {
  await goLive(page);
  // Two selections land back-to-back — the second must win the editor.
  await emitInspector(page, selection("src/App.tsx", 12));
  await emitInspector(page, selection("src/B.tsx", 40, "a"));
  await expect(page.locator(".sel-file")).toHaveText("src/B.tsx");
  await expect(page.locator(".qe-path")).toContainText("src/B.tsx", { timeout: 10_000 });
  // The older A open must not resurrect.
  await emitInspector(page, selection("src/C.tsx", 7, "div"));
  await expect(page.locator(".qe-path")).toContainText("src/C.tsx", { timeout: 10_000 });
});

test("workbench: source-less selection does not fabricate a file", async ({ page }) => {
  await goLive(page);
  await emitInspector(page, {
    ...INSPECTOR_CONNECTED,
    phase: "inspecting",
    inspectionEnabled: true,
    lastSelection: { element: { tagName: "canvas" } },
  });
  await expect(page.locator(".sel-unmapped")).toContainText("created at runtime");
  await expect(page.locator(".canvas-section")).toBeVisible();
  await expect(page.locator(".canvas-section")).toContainText("runtime-rendered pixels");
  // No source → the editor is not force-opened.
  await expect(page.locator(".qeditor")).toHaveCount(0);
});

test("workbench: modals hide the native surface, closing restores it", async ({ page }) => {
  await goLive(page);
  await expect.poll(async () => (await calls(page, "preview_create")).length).toBe(1);

  // Settings overlay covers the preview rect.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect.poll(async () => (await calls(page, "preview_hide")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect.poll(async () => (await calls(page, "preview_show")).length).toBeGreaterThan(0);

  // Quick Open palette does the same.
  await page.keyboard.press("Control+p");
  await expect(page.locator(".palette-input")).toBeVisible();
  await expect.poll(async () => (await calls(page, "preview_hide")).length).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls(page, "preview_show")).length).toBeGreaterThan(1);
});

test("workbench: Code tab hides the surface; stopping closes it", async ({ page }) => {
  await goLive(page);
  await expect.poll(async () => (await calls(page, "preview_create")).length).toBe(1);

  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await expect.poll(async () => (await calls(page, "preview_hide")).length).toBeGreaterThan(0);
  await expect(page.locator(".preview-host")).toHaveCount(0);

  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect.poll(async () => (await calls(page, "preview_show")).length).toBeGreaterThan(0);

  // Stop → the native surface is torn down and the workbench exits back
  // to the analysis view (the preview is gone with the server).
  await emitState(page, { phase: "stopped", url: null, pid: null });
  await expect.poll(async () => (await calls(page, "preview_mark_stopped")).length).toBe(1);
  await expect(page.locator(".preview-toolbar")).toHaveCount(0, { timeout: 10_000 });
});
