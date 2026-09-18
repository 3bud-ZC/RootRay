/**
 * Captures REAL product screenshots for README/docs via PrintWindow —
 * the OS-level capture that includes the native WebView2 preview surface
 * (page.screenshot only sees the DOM, which blanks the preview region).
 *
 * Flow: seed ClientFlow → launch → run → workbench → inspect → source →
 * preview focus → stop. Images land in docs/media/.
 *
 * Usage (repo root, app installed):
 *   node tests/e2e/installed-shots.mjs
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachCdp,
  attachPreview,
  attachUI,
  CFG_DIR,
  existsSync,
  killApp,
  launchApp,
  REPO_ROOT,
  seedSettings,
  sleep,
  until,
} from "./installed-preview.mjs";

const PROJECT = "C:\\Users\\Abud\\Desktop\\git hub\\ClientFlow-CRM";
const MEDIA = join(REPO_ROOT, "docs", "media");
const CDP_PORT = 9238;
const CAP_PS1 = join(REPO_ROOT, "tests", "e2e", "capture-window.ps1");

/** OS-level window capture including the native preview surface. */
function cap(pid, name) {
  const out = join(MEDIA, `${name}.png`);
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${CAP_PS1}" ` +
      `-ProcId ${pid} -Out "${out}"`,
  );
  console.log(`  shot ${name}.png`);
}

async function main() {
  assert.ok(existsSync(join(PROJECT, "node_modules", "next")), "project deps missing");
  mkdirSync(MEDIA, { recursive: true });
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(
    join(CFG_DIR, "settings.json"),
    JSON.stringify({ lastProject: null, recentProjects: [] }),
  );

  // ---- Home (DOM shot is fine — no native surface on home) -------------------
  const p1 = launchApp(CDP_PORT);
  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const page = await attachUI(cdp);
    await page.locator(".home-lockup").waitFor({ timeout: 15_000 });
    await sleep(400);
    cap(p1.pid, "home");
  } finally {
    await cdp?.close().catch(() => {});
    await killApp(p1);
  }

  // ---- Workbench -------------------------------------------------------------
  seedSettings(PROJECT);
  const p2 = launchApp(CDP_PORT);
  let cdp2;
  try {
    cdp2 = await attachCdp(CDP_PORT);
    const page2 = await attachUI(cdp2);
    const runBtn = page2.locator("button", { hasText: "Run Project" });
    await runBtn.waitFor({ timeout: 90_000 });
    await runBtn.click();
    const urlChip = page2.locator(".url-chip");
    await urlChip.waitFor({ timeout: 120_000 });
    const appUrl = (await urlChip.innerText()).trim();
    await page2.locator(".preview-toolbar").waitFor({ timeout: 15_000 });
    const devPage = await attachPreview(cdp2, appUrl);
    await devPage.goto(new URL("/login", appUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await devPage.locator("input#email").waitFor({ timeout: 60_000 });
    await until(
      () =>
        page2
          .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Inspect" })
          .isEnabled(),
      "inspector bridge to connect",
      60_000,
    );
    await page2.locator('button[aria-label="Reset layout"]').click();
    await sleep(800);
    cap(p2.pid, "workbench-split");

    // Inspect → source beside preview.
    await page2
      .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Inspect" })
      .click();
    const h1 = devPage.locator("h1").first();
    await h1.waitFor({ timeout: 20_000 });
    await h1.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await h1.click();
    await page2.locator(".qe-path").waitFor({ timeout: 15_000 });
    await sleep(500);
    cap(p2.pid, "inspect-source");

    // Preview Focus.
    await page2
      .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Interact" })
      .click();
    await page2.locator('button[aria-label="Preview Focus"]').click();
    await page2.locator(".pv-focus-exit").waitFor({ timeout: 5_000 });
    await sleep(400);
    cap(p2.pid, "preview-focus");
    await page2.locator(".pv-focus-exit").click();

    await page2.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await sleep(800);
    console.log("\nSCREENSHOT CAPTURE: PASS");
  } finally {
    await cdp2?.close().catch(() => {});
    await killApp(p2);
  }
}

main().catch((e) => {
  console.error(`\nSCREENSHOT CAPTURE: FAIL — ${e.message}`);
  process.exit(1);
});
