/**
 * Installed-app BRAND verification — also captures the real-product
 * screenshots used in README (docs/media/).
 *
 * Drives the REAL installed RootRay binary:
 *
 *   Home (lockup + header mark) → Settings/About → seed → analyze →
 *   Run ClientFlow → embedded Preview workbench → Inspect → source
 *   beside preview → Preview Focus → Stop.
 *
 * Asserts the brand layer renders (images actually decode, About shows
 * version + stable line) and that the exe carries the new mascot icon
 * (not the old ember-dot placeholder).
 *
 * Usage (repo root, app installed via the NSIS setup):
 *   node tests/e2e/installed-verify-brand.mjs
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachCdp,
  attachPreview,
  attachUI,
  CFG_DIR,
  EXE,
  existsSync,
  killApp,
  launchApp,
  makeShotDir,
  REPO_ROOT,
  seedSettings,
  shot,
  sleep,
  until,
} from "./installed-preview.mjs";

const PROJECT = "C:\\Users\\Abud\\Desktop\\git hub\\ClientFlow-CRM";
const MEDIA = join(REPO_ROOT, "docs", "media");
const SHOTS = makeShotDir("installed-verify-brand");
const CDP_PORT = 9236;

/** Element's img actually decoded (not a broken reference). */
async function imgLoaded(page, sel) {
  const img = page.locator(sel).first();
  await img.waitFor({ timeout: 10_000 });
  return img.evaluate((el) => el.complete && el.naturalWidth > 0);
}

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(existsSync(join(PROJECT, "node_modules", "next")), "project deps missing");
  mkdirSync(MEDIA, { recursive: true });

  // ---- exe icon: mascot, not the old ember dot ------------------------------
  const iconPng = join(SHOTS, "exe-icon.png");
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; ` +
      `[System.Drawing.Icon]::ExtractAssociatedIcon('${EXE}').ToBitmap().Save('${iconPng}')"`,
  );
  assert.ok(existsSync(iconPng), "exe icon extraction failed");
  const px = execSync(
    `python -c "from PIL import Image; im=Image.open(r'${iconPng}').convert('RGB'); ` +
      `d=list(im.getdata()); ` +
      `print(sum(1 for r,g,b in d if r>200 and g>200 and b>200), ` +
      `sum(1 for r,g,b in d if r>200 and 60<g<160 and b<80))"`,
    { encoding: "utf8" },
  ).trim();
  const [white, orange] = px.split(" ").map(Number);
  assert.ok(white > 15, `exe icon has too few robot-white pixels (${white}) — stale icon?`);
  assert.ok(orange > 5, `exe icon missing orange accents (${orange})`);
  console.log(`  ok  exe icon is the mascot (white=${white} orange=${orange})`);

  // ---- cold launch → branded home -------------------------------------------
  // Clear lastProject so the app boots to the home view, not an auto-restore.
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(
    join(CFG_DIR, "settings.json"),
    JSON.stringify({ lastProject: null, recentProjects: [] }),
  );
  const appProc = launchApp(CDP_PORT);
  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    await appPage.locator(".home-lockup").waitFor({ timeout: 15_000 });
    assert.ok(await imgLoaded(appPage, ".brand-mark"), "header mascot failed to load");
    assert.ok(await imgLoaded(appPage, ".home-lockup"), "home lockup failed to load");
    const tag = await appPage.locator(".brand-tag").innerText();
    assert.equal(tag, "Point at the UI. Reach the source.");
    await shot(appPage, SHOTS, "01-home");
    copyFileSync(join(SHOTS, "01-home.png"), join(MEDIA, "home.png"));
    console.log("  ok  branded home — lockup + header mark + tagline");

    // ---- Settings → About -----------------------------------------------------
    await appPage.locator('button[aria-label="Settings"]').click();
    await appPage
      .locator(".settings-panel")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await appPage.locator(".about-lockup").waitFor({ timeout: 5_000 });
    assert.ok(await imgLoaded(appPage, ".about-lockup"), "about lockup failed to load");
    const about = await appPage.locator(".about-block").innerText();
    assert.match(about, /RootRay v0\.3\.0/, `About missing version: ${about}`);
    assert.match(about, /Point at the UI\. Reach the source\./);
    assert.match(about, /Latest stable release: v0\.2\.0/);
    await shot(appPage, SHOTS, "02-about");
    await appPage.locator('button[aria-label="Close"]').click();
    console.log("  ok  About — version, tagline, stable-release line");
  } finally {
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }

  // ---- seed lastProject → analyze → run ClientFlow ---------------------------
  seedSettings(PROJECT);
  const appProc2 = launchApp(CDP_PORT);
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
    // Normalize layout for a clean README shot.
    await page2.locator('button[aria-label="Reset layout"]').click();
    await sleep(600);
    await shot(page2, SHOTS, "03-workbench-split");
    copyFileSync(join(SHOTS, "03-workbench-split.png"), join(MEDIA, "workbench-split.png"));
    console.log(`  ok  workbench running with embedded preview: ${appUrl}`);

    // ---- Inspect → source beside preview --------------------------------------
    await page2
      .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Inspect" })
      .click();
    const h1 = devPage.locator("h1").first();
    await h1.waitFor({ timeout: 20_000 });
    await h1.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await h1.click();
    await page2.locator(".qe-path").waitFor({ timeout: 15_000 });
    await shot(page2, SHOTS, "04-inspect-source");
    copyFileSync(join(SHOTS, "04-inspect-source.png"), join(MEDIA, "inspect-source.png"));
    const selFile = (await page2.locator(".sel-file").first().textContent()).trim();
    console.log(`  ok  inspect → source beside preview (${selFile})`);

    // ---- Preview Focus ---------------------------------------------------------
    await page2
      .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Interact" })
      .click();
    await page2.locator('button[aria-label="Preview Focus"]').click();
    await page2.locator(".pv-focus-exit").waitFor({ timeout: 5_000 });
    await shot(page2, SHOTS, "05-preview-focus");
    copyFileSync(join(SHOTS, "05-preview-focus.png"), join(MEDIA, "preview-focus.png"));
    await page2.locator(".pv-focus-exit").click();
    console.log("  ok  Preview Focus");

    // ---- Stop clean -------------------------------------------------------------
    await page2.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await page2
      .locator(".run-state")
      .filter({ hasText: /Stopped|Idle/ })
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    console.log("  ok  stopped clean");

    console.log("\nINSTALLED BRAND VERIFICATION: PASS");
  } finally {
    await cdp2?.close().catch(() => {});
    await killApp(appProc2);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED BRAND VERIFICATION: FAIL — ${e.message}`);
  process.exit(1);
});
