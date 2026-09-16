/**
 * Universal-workspace specs on the REAL built desktop UI (vite preview +
 * Tauri stub). Verifies the v0.2.0 capability model end-to-end in the DOM:
 * Next.js shows version + runner + honest inspection limits, a monorepo
 * gets a working target selector, and a static project stays usable
 * without a runner — none of them hit a global "Unsupported" dead-end.
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
const PORT = 5612;
const URL = `http://localhost:${PORT}/`;

let server: ChildProcess | undefined;

const CAP = { state: "available" };
const UNAVAIL = (reason: string) => ({ state: "unavailable", reason });
const PARTIAL = (reason: string) => ({ state: "partial", reason });
const NA = { state: "not-applicable" };

const UNIVERSAL = {
  workspaceBrowse: CAP,
  workspaceSearch: CAP,
  quickOpen: CAP,
  quickEdit: CAP,
  safeWrite: CAP,
  openExternal: CAP,
};

const NEXT_TARGET = {
  id: "root",
  name: "clientflow-crm",
  relativeRoot: "",
  absoluteRoot: "C:/fixture/clientflow",
  kind: "web-app",
  framework: "next-js",
  frameworkVersion: "16.2.12",
  languages: ["TypeScript"],
  technologies: [
    { name: "Next.js", version: "16.2.12", evidence: ['package.json dependency "next"'] },
    { name: "React", version: "19.0.0", evidence: ['package.json dependency "react"'] },
    { name: "TypeScript", version: "5.6.0", evidence: ['package.json dependency "typescript"'] },
    { name: "Prisma", version: "6.0.0", evidence: ['package.json dependency "prisma"'] },
    { name: "Tailwind CSS", version: "4.0.0", evidence: ['package.json dependency "tailwindcss"'] },
  ],
  packageManager: "npm",
  devScript: "next dev",
  runnerCandidates: [
    {
      scriptName: "dev",
      display: "npm run dev",
      confidence: 100,
      reason: 'conventional dev script: "dev": "next dev"',
    },
  ],
  selectedRunner: {
    executable: "npm.cmd",
    args: ["run", "dev"],
    display: "npm run dev",
    cwd: "C:/fixture/clientflow",
  },
  capabilities: {
    ...UNIVERSAL,
    run: CAP,
    browserOpen: CAP,
    domInspect: UNAVAIL("Next.js runtime adapter is not implemented yet"),
    styleInspect: UNAVAIL("Next.js runtime adapter is not implemented yet"),
    sourceMapping: UNAVAIL("Next.js runtime adapter is not implemented yet"),
    componentIntelligence: PARTIAL("static React analysis only — no rendered-element mapping"),
    hmrAware: UNAVAIL("runtime source adapter for this framework is not implemented yet"),
  },
  evidence: ['"next" dependency: ^16.2.12', "next.config.* found"],
};

const NEXT_WORKSPACE = {
  root: "C:/fixture/clientflow",
  name: "clientflow-crm",
  workspaceKind: "single-package",
  packageManager: "npm",
  manifests: ["package.json"],
  technologies: NEXT_TARGET.technologies,
  targets: [NEXT_TARGET],
  activeTargetId: "root",
  capabilities: { ...UNIVERSAL, ...NEXT_TARGET.capabilities },
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

const MONO_WEB = {
  ...NEXT_TARGET,
  id: "apps/web",
  name: "@mono/web",
  relativeRoot: "apps/web",
  absoluteRoot: "C:/fixture/mono/apps/web",
  packageManager: "pnpm",
  selectedRunner: {
    executable: "pnpm.cmd",
    args: ["run", "dev"],
    display: "pnpm run dev",
    cwd: "C:/fixture/mono/apps/web",
  },
};

const MONO_API = {
  id: "apps/api",
  name: "@mono/api",
  relativeRoot: "apps/api",
  absoluteRoot: "C:/fixture/mono/apps/api",
  kind: "server",
  framework: "node-web",
  frameworkVersion: null,
  languages: ["JavaScript"],
  technologies: [
    { name: "Express", version: "4.21.0", evidence: ['package.json dependency "express"'] },
  ],
  packageManager: "pnpm",
  devScript: "node src/index.js",
  runnerCandidates: [
    {
      scriptName: "dev",
      display: "pnpm run dev",
      confidence: 100,
      reason: 'conventional dev script: "dev": "node src/index.js"',
    },
  ],
  selectedRunner: {
    executable: "pnpm.cmd",
    args: ["run", "dev"],
    display: "pnpm run dev",
    cwd: "C:/fixture/mono/apps/api",
  },
  capabilities: {
    ...UNIVERSAL,
    run: CAP,
    browserOpen: UNAVAIL("server target — no UI inspection"),
    domInspect: NA,
    styleInspect: NA,
    sourceMapping: NA,
    componentIntelligence: NA,
    hmrAware: NA,
  },
  evidence: ["node web framework dependency found"],
};

const MONO_WORKSPACE = {
  root: "C:/fixture/mono",
  name: "mono-fixture",
  workspaceKind: "pnpm-workspace",
  packageManager: "pnpm",
  manifests: ["package.json", "apps/web/package.json", "apps/api/package.json"],
  technologies: [...MONO_WEB.technologies, ...MONO_API.technologies],
  targets: [MONO_API, MONO_WEB],
  activeTargetId: "apps/web",
  capabilities: { ...UNIVERSAL, ...NEXT_TARGET.capabilities },
  findings: ["pnpm-workspace.yaml found — pnpm workspace"],
  warnings: [],
  discovery: {
    dirsVisited: 8,
    manifestsRead: 3,
    metadataBytes: 1400,
    targetsFound: 2,
    elapsedMs: 3,
    truncated: false,
  },
};

const STATIC_TARGET = {
  id: "root",
  name: "arena",
  relativeRoot: "",
  absoluteRoot: "C:/fixture/arena",
  kind: "static-web",
  framework: "static-web",
  frameworkVersion: null,
  languages: ["JavaScript"],
  technologies: [],
  packageManager: "unknown",
  devScript: null,
  runnerCandidates: [],
  selectedRunner: null,
  capabilities: {
    ...UNIVERSAL,
    run: UNAVAIL("no declared dev script — RootRay does not fabricate a server command"),
    browserOpen: UNAVAIL("no dev server to produce a URL"),
    domInspect: UNAVAIL("runtime source adapter for this framework is not implemented yet"),
    styleInspect: UNAVAIL("runtime source adapter for this framework is not implemented yet"),
    sourceMapping: UNAVAIL("runtime source adapter for this framework is not implemented yet"),
    componentIntelligence: {
      state: "not-applicable",
      reason: "not a React project",
    },
    hmrAware: NA,
  },
  evidence: ["index.html present"],
};

const STATIC_WORKSPACE = {
  root: "C:/fixture/arena",
  name: "arena",
  workspaceKind: "no-manifest",
  packageManager: "unknown",
  manifests: [],
  technologies: [],
  targets: [STATIC_TARGET],
  activeTargetId: "root",
  capabilities: { ...UNIVERSAL, ...STATIC_TARGET.capabilities },
  findings: ["static web entry found: root/index.html"],
  warnings: [],
  discovery: {
    dirsVisited: 2,
    manifestsRead: 0,
    metadataBytes: 0,
    targetsFound: 1,
    elapsedMs: 1,
    truncated: false,
  },
};

function cannedFor(workspace: Record<string, unknown>) {
  const runtime = {
    phase: "ready",
    workspace,
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
      analyze_project: workspace,
      get_runtime_state: { ...runtime, phase: "idle", workspace: null },
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
      detect_editors: [],
      list_project_files: {
        paths: ["src/App.tsx", "package.json"],
        truncated: false,
      },
      search_workspace: {
        query: "x",
        truncated: false,
        filesScanned: 2,
        matches: [],
      },
      collect_source_files: { files: [], truncated: false, totalBytes: 0 },
      "plugin:dialog|open": null,
    } as Record<string, unknown>,
  };
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

// ---- CASE A — Next.js workspace ------------------------------------------------

test("Next.js workspace: detected, runnable, no unsupported dead-end", async ({ page }) => {
  const { canned, runtime } = cannedFor(NEXT_WORKSPACE);
  await stubTauri(page, { canned, runtime });
  await page.goto(URL);
  await expect(page.locator("text=Open a workspace")).toBeVisible();
  await page.getByRole("button", { name: "Open Project" }).click();

  await expect(page.locator("text=clientflow-crm")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".fact code", { hasText: "Next.js 16.2.12" })).toBeVisible();
  await expect(page.getByText("npm", { exact: true })).toBeVisible();
  await expect(page.locator("text=npm run dev")).toBeVisible();
  await expect(page.locator("text=Partial runtime support")).toBeVisible();
  // The global dead-end is gone.
  await expect(page.locator("text=Unsupported")).toHaveCount(0);
  await expect(page.locator("text=UNSUPPORTED PROJECT")).toHaveCount(0);

  // Universal workspace capabilities are shown as available.
  for (const label of ["Explorer", "Quick Open", "Search", "Quick Edit"]) {
    await expect(page.locator(".cap-row", { hasText: label })).toBeVisible();
  }
  // Run is available; source mapping is honestly unavailable with reason.
  await expect(page.getByRole("button", { name: "Run Project" })).toBeVisible();
  const mapping = page.locator(".cap-row", { hasText: "Source mapping" });
  await expect(mapping).toContainText("Next.js runtime adapter is not implemented yet");

  // Universal features work — Ctrl+P, Ctrl+Shift+F, Explorer rows render.
  await expect(page.locator(".ex-row", { hasText: "src" })).toBeVisible();
  await page.keyboard.press("Control+p");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.keyboard.press("Escape");
});

// ---- CASE B — monorepo target selection -----------------------------------------

test("monorepo: target selector switches runtime, workspace stays put", async ({ page }) => {
  const { canned, runtime } = cannedFor(MONO_WORKSPACE);
  await stubTauri(page, { canned, runtime });
  await page.goto(URL);
  await page.getByRole("button", { name: "Open Project" }).click();

  await expect(page.locator("text=mono-fixture")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=pnpm workspace")).toBeVisible();

  const select = page.getByLabel("Active target");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("apps/web");
  await expect(page.locator(".fact code", { hasText: "Next.js 16.2.12" })).toBeVisible();

  // Switch to the API target — runtime facts swap, root stays the same.
  await select.selectOption("apps/api");
  await expect(page.locator(".fact code", { hasText: "Node.js" })).toBeVisible();
  await expect(page.locator("text=mono-fixture")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (
          window as unknown as { __RR_CALLS__: { cmd: string; args: { targetId: string } }[] }
        ).__RR_CALLS__.some((c) => c.cmd === "set_active_target" && c.args.targetId === "apps/api"),
      ),
    )
    .toBe(true);
});

// ---- CASE C — static web stays usable -------------------------------------------

test("static web workspace: usable without a runner", async ({ page }) => {
  const { canned, runtime } = cannedFor(STATIC_WORKSPACE);
  await stubTauri(page, { canned, runtime });
  await page.goto(URL);
  await page.getByRole("button", { name: "Open Project" }).click();

  await expect(page.getByRole("heading", { name: "arena" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=Static Web")).toBeVisible();
  await expect(page.locator("text=Workspace support")).toBeVisible();
  // No fabricated run command — the Run button must not appear.
  await expect(page.getByRole("button", { name: "Run Project" })).toHaveCount(0);
  // Universal features still render.
  await expect(page.locator(".ex-row", { hasText: "src" })).toBeVisible();
  await expect(page.locator(".cap-row", { hasText: "Quick Edit" })).toBeVisible();
  await expect(page.locator("text=Unsupported")).toHaveCount(0);
});
