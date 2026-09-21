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

async function emitState(
  page: import("@playwright/test").Page,
  over: Record<string, unknown>,
  workspace: Record<string, unknown> = WORKSPACE,
) {
  const runtime = {
    phase: "running",
    workspace,
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
  if (!created) throw new Error("preview_create call missing");
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

  // The editor acceptance is rendered source, not merely line-number chrome.
  await emitInspector(page, selection("src/App.tsx", 1));
  await expect(page.locator(".cm-content")).toContainText("// src/App.tsx");
  await expect(page.locator(".cm-rootray-marked-line")).toContainText("// src/App.tsx");
  await expect(page.locator(".source-preview")).toHaveCount(0);
  await expect(page.locator(".sel-file-name")).toHaveText("App.tsx");
  await expect(page.locator(".sel-pos")).toHaveText("1:5");
  // The preview host is still there — the reveal happens beside it.
  await expect(page.locator(".preview-host")).toBeVisible();
});

test("workbench: slow editor mount shows loading, never numbered blank code", async ({ page }) => {
  let delayed = false;
  await page.route(/\/assets\/CodeEditor-.*\.js$/, async (route) => {
    delayed = true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await goLive(page);
  await emitInspector(page, selection("src/App.tsx", 1));
  await expect.poll(() => delayed).toBe(true);
  await expect(page.locator(".qe-loading")).toContainText("Loading source", {
    timeout: 5_000,
  });
  await expect(page.locator(".cm-content")).toContainText("// src/App.tsx", {
    timeout: 15_000,
  });
  await expect(page.locator(".cm-line").filter({ hasText: "// src/App.tsx" })).toBeVisible();
  await expect(page.locator(".qe-cm-state")).not.toBeVisible();
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

// ---- flexible layout -----------------------------------------------------

test("workbench: Explorer collapses and restores with its state intact", async ({ page }) => {
  await goLive(page);

  const explorer = page.locator(".wb-left");
  const toggle = page.getByRole("button", { name: /toggle explorer/i });
  await expect(explorer).toBeVisible();

  // Expand "src" so there's component state worth preserving.
  await explorer.getByRole("button", { name: /src/ }).click();
  await expect(explorer.getByRole("button", { name: "App.tsx" })).toBeVisible();

  // Hide via the toolbar toggle — the pane leaves the layout entirely.
  await toggle.click();
  await expect(explorer).not.toBeVisible();

  // Restore — width and the expanded directory come back.
  await toggle.click();
  await expect(explorer).toBeVisible();
  await expect(explorer.getByRole("button", { name: "App.tsx" })).toBeVisible();

  // Ctrl+B does the same round-trip.
  await page.keyboard.press("Control+b");
  await expect(explorer).not.toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(explorer).toBeVisible();
});

test("workbench: Inspector hides without losing the current selection", async ({ page }) => {
  await goLive(page);
  await emitInspector(page, selection("src/App.tsx", 12));
  await expect(page.locator(".sel-file")).toHaveText("src/App.tsx");

  const inspector = page.locator(".wb-right");
  const toggle = page.getByRole("button", { name: /toggle inspector/i });
  await toggle.click();
  await expect(inspector).not.toBeVisible();
  // Code pane still opened — Inspector is optional for source reveal.
  await expect(page.locator(".qeditor")).toBeVisible({ timeout: 10_000 });

  await toggle.click();
  await expect(inspector).toBeVisible();
  await expect(page.locator(".sel-file")).toHaveText("src/App.tsx");
});

test("workbench: Output collapses to a bar, keeps logs, resizes vertically", async ({ page }) => {
  await goLive(page);
  const logpanel = page.locator('[data-testid="logpanel"]');

  // Emit server output so the panel has content.
  await page.evaluate(() =>
    (window as unknown as { __RR_EMIT__: (e: string, p: unknown) => void }).__RR_EMIT__(
      "rootray://process-event",
      { kind: "stdout", line: "vite ready" },
    ),
  );

  // Default is collapsed — just the bar with a line count.
  await expect(logpanel).toContainText("1 line");
  await expect(page.locator(".logbox")).toHaveCount(0);

  // Expand → the log text is right there (nothing was lost).
  await page.getByRole("button", { name: /expand output/i }).click();
  await expect(page.locator(".logbox")).toContainText("vite ready");

  // Keyboard resize on the top-edge splitter.
  const h0 = (await logpanel.boundingBox())!.height;
  await page.locator(".splitter-horizontal").press("ArrowUp");
  const h1 = (await logpanel.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 8);
  await page.locator(".splitter-horizontal").press("ArrowDown");
  const h2 = (await logpanel.boundingBox())!.height;
  expect(h2).toBeLessThan(h1);

  // Ctrl+J collapses; the bar stays with logs intact.
  await page.keyboard.press("Control+j");
  await expect(page.locator(".logbox")).toHaveCount(0);
  await expect(logpanel).toContainText("1 line");
});

test("workbench: Split ratio drags across a wide range via the divider", async ({ page }) => {
  await goLive(page);
  await page.getByRole("tab", { name: "Split" }).click();

  const divider = page.locator(".preview-body > .splitter");
  await expect(divider).toBeVisible();
  const host = page.locator(".preview-host");
  const w0 = (await host.boundingBox())!.width;

  // ArrowLeft shrinks the preview share; ArrowRight grows it.
  await divider.press("ArrowLeft");
  const w1 = (await host.boundingBox())!.width;
  expect(w1).toBeLessThan(w0);
  for (let i = 0; i < 6; i++) await divider.press("ArrowRight");
  const w2 = (await host.boundingBox())!.width;
  expect(w2).toBeGreaterThan(w1 + 40);

  // Double-click restores the default ratio.
  await divider.dblclick();
  const w3 = (await host.boundingBox())!.width;
  expect(Math.abs(w3 - w0)).toBeLessThanOrEqual(24);
});

test("workbench: Split prioritizes Preview and Code at constrained widths", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await goLive(page);
  await page.getByRole("tab", { name: "Split" }).click();

  // The user preference stays on, but the Inspector is transiently hidden
  // so Preview + Code each retain their practical minimum width.
  await expect(page.locator(".wb-right")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /toggle inspector/i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await page.locator(".preview-host").boundingBox())!.width).toBeGreaterThanOrEqual(360);
  expect((await page.locator(".wb-code").boundingBox())!.width).toBeGreaterThanOrEqual(360);

  // Widening restores the requested Inspector state without changing it.
  await page.setViewportSize({ width: 1_600, height: 900 });
  await expect(page.locator(".wb-right")).toBeVisible();

  // A deliberate user hide remains hidden after responsive state clears.
  await page.getByRole("button", { name: /toggle inspector/i }).click();
  await expect(page.locator(".wb-right")).not.toBeVisible();
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(".wb-right")).not.toBeVisible();
});

test("workbench: desktop sizes keep panes usable without global scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_080 });
  await goLive(page);
  await page.getByRole("tab", { name: "Split" }).click();

  for (const width of [1_920, 1_600, 1_366]) {
    await page.setViewportSize({ width, height: 768 });
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      const body = document.querySelector<HTMLElement>(".wb-body");
      const toolbar = document.querySelector<HTMLElement>(".preview-toolbar");
      const preview = document.querySelector<HTMLElement>(".preview-host");
      const code = document.querySelector<HTMLElement>(".wb-code");
      const inspector = document.querySelector<HTMLElement>(".wb-right");
      return {
        shellOverflow: shell ? shell.scrollHeight - shell.clientHeight : 0,
        bodyOverflow: body ? body.scrollWidth - body.clientWidth : 0,
        toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
        previewWidth: preview?.getBoundingClientRect().width ?? 0,
        codeWidth: code?.getBoundingClientRect().width ?? 0,
        inspectorWidth: inspector?.getBoundingClientRect().width ?? 0,
        inspectorVisible: Boolean(inspector && getComputedStyle(inspector).display !== "none"),
      };
    });
    expect(metrics.shellOverflow, `${width}px shell`).toBeLessThanOrEqual(1);
    expect(metrics.bodyOverflow, `${width}px workbench`).toBeLessThanOrEqual(1);
    expect(metrics.toolbarOverflow, `${width}px toolbar`).toBeLessThanOrEqual(1);
    expect(metrics.previewWidth, `${width}px preview`).toBeGreaterThanOrEqual(360);
    expect(metrics.codeWidth, `${width}px code`).toBeGreaterThanOrEqual(360);
    if (metrics.inspectorVisible) {
      expect(metrics.inspectorWidth, `${width}px inspector`).toBeGreaterThanOrEqual(300);
    }
  }
});

test("workbench: Preview Focus maximizes the surface and exits cleanly", async ({ page }) => {
  await goLive(page);
  await expect(page.locator(".wb-left")).toBeVisible();
  await expect(page.locator(".wb-right")).toBeVisible();

  await page.keyboard.press("Control+Shift+P");
  // Panes and Output leave the layout; toolbar keeps minimal controls.
  await expect(page.locator(".wb-left")).not.toBeVisible();
  await expect(page.locator(".wb-right")).not.toBeVisible();
  await expect(page.locator(".wb-code")).toHaveCount(0);
  await expect(page.locator(".logpanel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Exit Focus" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Split" })).toHaveCount(0);
  // The surface stays live — new bounds were pushed for the grown host.
  await expect
    .poll(async () => (await calls(page, "preview_set_bounds")).length)
    .toBeGreaterThan(0);

  // Escape exits focus (not inspecting, so it isn't consumed by Inspect).
  await page.keyboard.press("Escape");
  await expect(page.locator(".wb-left")).toBeVisible();
  await expect(page.locator(".wb-right")).toBeVisible();

  // The toolbar button enters and exits too.
  await page.getByRole("button", { name: "Preview Focus" }).click();
  await expect(page.locator(".wb-left")).not.toBeVisible();
  await page.getByRole("button", { name: "Exit Focus" }).click();
  await expect(page.locator(".wb-left")).toBeVisible();
});

test("workbench: inspect inside Preview Focus offers Show Source instead of breaking focus", async ({
  page,
}) => {
  await goLive(page);
  await page.keyboard.press("Control+Shift+P");

  await emitInspector(page, selection("src/App.tsx", 12));
  // Focus survives — the offer chip shows the resolved file.
  await expect(page.locator(".focus-reveal")).toBeVisible();
  await expect(page.locator(".focus-reveal-path")).toContainText("src/App.tsx:12");
  await expect(page.locator(".wb-left")).not.toBeVisible();

  // Accepting the offer deliberately leaves focus to a Split reveal.
  await page.getByRole("button", { name: "Show Source" }).click();
  await expect(page.locator(".qeditor")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".qe-path")).toContainText("src/App.tsx");
  await expect(page.locator(".wb-left")).toBeVisible();
});

test("workbench: Code Focus gives the editor the workbench", async ({ page }) => {
  await goLive(page);
  await emitInspector(page, selection("src/App.tsx", 12));
  await expect(page.locator(".qeditor")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Code Focus" }).click();
  await expect(page.locator(".preview-host")).toHaveCount(0);
  await expect(page.locator(".wb-left")).not.toBeVisible();
  await expect(page.locator(".wb-right")).not.toBeVisible();
  await expect(page.locator(".qeditor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit Focus" })).toBeVisible();

  await page.getByRole("button", { name: "Exit Focus" }).click();
  await expect(page.locator(".preview-host")).toBeVisible();
  await expect(page.locator(".qeditor")).toBeVisible();
});

test("workbench: Reset Layout restores defaults after chaos", async ({ page }) => {
  await goLive(page);

  // Chaos: hide explorer + inspector, focus preview.
  await page.getByRole("button", { name: /toggle explorer/i }).click();
  await page.getByRole("button", { name: /toggle inspector/i }).click();
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".wb-left")).not.toBeVisible();

  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(page.locator(".wb-left")).toBeVisible();
  await expect(page.locator(".wb-right")).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit Focus" })).toHaveCount(0);
});

test("workbench: layout persists across reloads and clamps bad values", async ({ page }) => {
  await goLive(page);
  await page.getByRole("button", { name: /toggle explorer/i }).click();

  await expect(page.locator(".wb-left")).not.toBeVisible();

  // The durable subset is written to localStorage.
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("rootray.layout.v1") ?? "{}"),
  );
  expect(stored.explorerVisible).toBe(false);
  expect(stored.focusMode).toBeUndefined();

  // Corrupt entries can't strand a pane — seed garbage, reload.
  await page.evaluate(() =>
    localStorage.setItem(
      "rootray.layout.v1",
      JSON.stringify({ explorerWidth: 1, inspectorVisible: false }),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "Open Project" }).click();
  await expect(page.getByRole("button", { name: "Run Project" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Run Project" }).click();
  await emitState(page, { phase: "starting", url: null });
  await emitState(page, {});
  await expect(page.locator(".preview-toolbar")).toBeVisible({ timeout: 10_000 });

  // Clamped width (not 1px) and persisted inspector pref (hidden).
  const leftBox = await page.locator(".wb-left").boundingBox();
  expect(leftBox!.width).toBeGreaterThanOrEqual(160);
  await expect(page.locator(".wb-right")).not.toBeVisible();
});

test("workbench: the shell never scrolls — panes own their overflow", async ({ page }) => {
  await goLive(page);
  await emitInspector(page, selection("src/App.tsx", 12));
  await expect(page.locator(".qeditor")).toBeVisible({ timeout: 10_000 });
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(scrollable).toBe(false);
});

// ---- lifecycle safety ------------------------------------------------------

test("workbench: Change Project while running stops first — no illegal transition", async ({
  page,
}) => {
  await goLive(page);

  await page.getByRole("button", { name: /Change/ }).click();

  // Ordering contract: change_project is one serialized backend command
  // — it stops the live server then analyzes under a single lifecycle
  // hold, so running→analyzing can never be reached from the UI.
  await expect.poll(async () => (await calls(page, "change_project")).length).toBe(1);
  // No red transition error ever surfaced.
  await expect(page.locator(".notice")).toHaveCount(0);
});

test("workbench: target switching is disabled while running with a clear reason", async ({
  page,
}) => {
  const second = {
    ...TARGET,
    id: "admin",
    name: "fixture-admin",
    relativeRoot: "admin",
  };
  const ws2 = { ...WORKSPACE, targets: [TARGET, second] };
  const { canned, runtime } = makeCanned();
  (runtime as Record<string, unknown>).workspace = ws2;
  (canned as Record<string, unknown>).analyze_project = ws2;
  await stubTauri(page, { canned, runtime });
  await page.goto(URL);
  await page.getByRole("button", { name: "Open Project" }).click();
  await expect(page.getByRole("button", { name: "Run Project" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Run Project" }).click();
  await emitState(page, { phase: "starting", url: null }, ws2);
  await emitState(page, {}, ws2);
  await expect(page.locator(".preview-toolbar")).toBeVisible({ timeout: 10_000 });

  const select = page.locator(".target-select");
  await expect(select).toBeDisabled();
  await expect(select).toHaveAttribute("title", /stop the project/i);
  expect(await calls(page, "set_active_target")).toHaveLength(0);
});
