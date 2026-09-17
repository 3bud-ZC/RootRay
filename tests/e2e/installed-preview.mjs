/**
 * Shared helpers for the v0.3.0 installed-app verification scripts.
 *
 * The embedded preview is a native WebView2 child surface in the same
 * browser process as the RootRay UI, so the single WebView2 remote
 * debugging endpoint exposes BOTH pages: the privileged UI (tauri://)
 * and the unprivileged preview (the dev-server URL). Attaching to the
 * preview page over CDP lets a script drive the real embedded browser —
 * hover, click, keyboard — exactly where a user's project runs.
 */

import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const EXE = join(process.env.LOCALAPPDATA ?? "", "RootRay", "rootray-desktop.exe");
export const CFG_DIR = join(process.env.APPDATA ?? "", "dev.rootray.app");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function shot(page, dir, name) {
  try {
    await page.screenshot({ path: join(dir, `${name}.png`) });
  } catch (e) {
    console.warn(`  (screenshot ${name} failed: ${e.message})`);
  }
}

export async function waitText(page, text, timeout = 30_000) {
  await page.locator(`text=${text}`).first().waitFor({ timeout });
}

export function makeShotDir(name) {
  const dir = join(REPO_ROOT, "target", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Child processes of the installed app, via CIM. */
export function childProcs(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${pid}\\" | Select-Object -Expand Name"`,
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Seeds settings.json so the installed app auto-restores `projectDir` and
 * auto-opens the INTERNAL preview. `openBrowserAutomatically:false` stays
 * in the file on purpose — it is the legacy field the migration must not
 * let override the explicit new preference.
 */
export function seedSettings(projectDir) {
  const settings = {
    lastProject: projectDir,
    recentProjects: [projectDir],
    preferredLauncher: null,
    openBrowserAutomatically: false,
    openPreviewAutomatically: true,
  };
  writeFileSync(join(CFG_DIR, "settings.json"), JSON.stringify(settings), {
    encoding: "utf8",
  });
  console.log(`seeded lastProject = ${projectDir}`);
}

/** Launches the installed exe with the WebView2 CDP endpoint enabled. */
export function launchApp(cdpPort) {
  const proc = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
    stdio: "ignore",
  });
  console.log(`launched installed app (pid ${proc.pid})`);
  return proc;
}

/** Connects Playwright to the app's WebView2 browser process. */
export async function attachCdp(cdpPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch {
      await sleep(500);
    }
  }
  assert.fail("could not attach to installed app WebView2 over CDP");
}

/** Every page target the WebView2 browser process exposes. */
export function allPages(cdp) {
  return cdp.contexts().flatMap((ctx) => ctx.pages());
}

/** Finds the privileged RootRay UI page (tauri:// origin). */
export async function attachUI(cdp, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of allPages(cdp)) {
      const url = p.url();
      if (url.includes("tauri.localhost") || url.startsWith("tauri:")) return p;
      try {
        if ((await p.title()) === "RootRay") return p;
      } catch {
        /* target mid-teardown */
      }
    }
    await sleep(500);
  }
  const seen = allPages(cdp)
    .map((p) => p.url())
    .join(", ");
  assert.fail(`RootRay app page not found over CDP (targets: ${seen})`);
}

/**
 * Finds the embedded preview page — a CDP page target whose URL lives
 * under the dev-server URL. `urlBase` may be exact or a prefix.
 */
export async function attachPreview(cdp, urlBase, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const normalized = urlBase.endsWith("/") ? urlBase.slice(0, -1) : urlBase;
  while (Date.now() < deadline) {
    for (const p of allPages(cdp)) {
      if (p.url() === normalized || p.url().startsWith(`${normalized}/`)) return p;
    }
    await sleep(500);
  }
  const seen = allPages(cdp)
    .map((p) => p.url())
    .join(", ");
  assert.fail(`embedded preview page for ${urlBase} not found (targets: ${seen})`);
}

/**
 * Adversarial IPC check — project content must hold ZERO Tauri command
 * access. Whatever the page's IPC surface looks like (no injected
 * internals, a rejected invoke, or an invoke that goes nowhere because
 * no IPC channel exists), a privileged command must never resolve.
 */
export async function assertPreviewHasNoIpc(previewPage) {
  const probe = await previewPage.evaluate(async () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return "no-ipc-surface";
    const attempt = (cmd, args) =>
      Promise.race([
        Promise.resolve()
          .then(() => internals.invoke(cmd, args))
          .then(() => "RESOLVED")
          .catch((e) => `denied:${String(e).slice(0, 120)}`),
        new Promise((r) => setTimeout(() => r("no-channel"), 5000)),
      ]);
    return {
      runtime: await attempt("get_runtime_state"),
      browser: await attempt("open_browser", { url: "https://example.com" }),
      fs: await attempt("plugin:fs|read_text_file", { path: "C:/Windows/win.ini" }),
    };
  });
  if (probe === "no-ipc-surface") {
    console.log("  ok  preview page has no Tauri IPC surface at all");
    return;
  }
  for (const [cmd, result] of Object.entries(probe)) {
    assert.notEqual(
      result,
      "RESOLVED",
      `preview webview reached privileged command ${cmd}: ${result}`,
    );
  }
  console.log(`  ok  preview IPC present but every command denied: ${JSON.stringify(probe)}`);
}

/** Waits until `predicate` holds, polling every `step` ms. */
export async function until(predicate, what, timeoutMs = 15_000, step = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      /* keep polling */
    }
    await sleep(step);
  }
  assert.fail(`timeout waiting for ${what}`);
}

/** Kills the installed app and its whole process tree. */
export async function killApp(appProc) {
  try {
    process.kill(appProc.pid);
  } catch {}
  await sleep(1000);
  try {
    execFileSync("taskkill", ["/PID", String(appProc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

export { existsSync };
