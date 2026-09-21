/**
 * Installed-app golden path verification (v0.3.0 Integrated Browser
 * Workbench acceptance).
 *
 * Drives the REAL installed RootRay binary — no stubs, no external
 * browser:
 *
 *   installed exe (WebView2 CDP) → auto-analyze fixture → Run Project →
 *   real Vite dev server (spawned by the app) → URL detected →
 *   EMBEDDED child webview loads the page inside RootRay → adversarial
 *   IPC probe proves the preview holds no command access → inspector
 *   bridge connects from inside the preview → Inspect → click element →
 *   source auto-opens beside the preview → Quick Edit → save → Vite HMR
 *   inside the embedded preview → Back/Forward/Reload/popup policy →
 *   Escape + Ctrl+Shift+C → Stop → preview + process tree cleanup.
 *
 * Usage (repo root, app already installed via the NSIS setup):
 *   node tests/e2e/installed-golden.mjs
 *
 * Screenshots land in target/installed-verify/.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allPages,
  assertPreviewHasNoIpc,
  attachCdp,
  attachPreview,
  attachUI,
  childProcs,
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
  waitText,
} from "./installed-preview.mjs";

const FIXTURE = join(REPO_ROOT, "fixtures", "vite-react-inspector");
const SHOTS = makeShotDir("installed-verify");
const CDP_PORT = 9229;

const EDIT_TARGET = join(FIXTURE, "src", "components", "ActionButton.tsx");
const ORIGINAL_SOURCE = readFileSync(EDIT_TARGET, "utf8");
const EDITED_SOURCE = ORIGINAL_SOURCE.replace("Count is {count}", "Count is now {count}");
assert.notEqual(EDITED_SOURCE, ORIGINAL_SOURCE, "edit needle must exist in fixture");

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(
    existsSync(join(FIXTURE, "node_modules", "vite")),
    "fixture deps missing — run `npm install` in fixtures/vite-react-inspector",
  );

  seedSettings(FIXTURE);
  const appProc = launchApp(CDP_PORT);

  let cdp;
  try {
    // ---- attach to the installed app's WebView2 -------------------------
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- analyze (auto-restored via lastProject) -------------------------
    await waitText(appPage, "fixture-vite-react-inspector", 60_000);
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /React \+ Vite 7\.1\.0/, "framework not resolved");
    assert.match(facts, /\bnpm\b/, "package manager not resolved to npm");
    assert.match(facts, /npm run dev/, "dev command not resolved");
    await shot(appPage, SHOTS, "01-analyzed");
    console.log("  ok  analysis: React + Vite 7.1.0 · npm · npm run dev");

    // ---- Run → the workbench appears with the preview toolbar ------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 120_000 });
    } catch (e) {
      await shot(appPage, SHOTS, "run-timeout");
      const notice = await appPage
        .locator(".notice")
        .innerText()
        .catch(() => "");
      const logs = await appPage
        .locator(".logs, .log-panel")
        .innerText()
        .catch(() => "");
      console.error(`notice=${notice}\nlogs=${logs}`);
      throw e;
    }
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);
    await appPage.locator(".preview-toolbar").waitFor({ timeout: 15_000 });
    console.log(`  ok  dev server running: ${appUrl}`);

    // ---- the embedded preview IS the browser ------------------------------
    // No external browser is launched anywhere in this script: the child
    // WebView2 surface appears as a second CDP target at the dev URL.
    const devPage = await attachPreview(cdp, appUrl);
    await waitText(devPage, "Inspector fixture", 30_000);
    const button = devPage.locator("button", { hasText: "Count is" }).first();
    await button.waitFor();
    await appPage.locator(".preview-phase-ready").waitFor({ timeout: 30_000 });
    await shot(appPage, SHOTS, "02-internal-preview");
    console.log("  ok  project rendered INSIDE RootRay (embedded WebView2 surface)");

    // ---- adversarial: project content must hold no command access ---------
    await assertPreviewHasNoIpc(devPage);

    // ---- inspector bridge connects from inside the preview ----------------
    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, SHOTS, "03-bridge-connected");
    console.log("  ok  inspector bridge connected from the embedded preview");

    // ---- interact first: a real click reaches the app ----------------------
    await button.click();
    await until(
      async () => /Count is 1/.test(await button.innerText()),
      "interact click to increment the counter",
    );
    console.log("  ok  Interact mode: app clicks work normally in the preview");

    // ---- inspect → select → source auto-opens beside the preview -----------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    await button.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await button.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "src/components/ActionButton.tsx");
    assert.match(selPos, /\d+:\d+/, selPos);
    const selComponent = (await appPage.locator(".sel-component").innerText()).trim();
    assert.equal(selComponent, "ActionButton");
    // The inspected click was suppressed — counter is still 1.
    assert.match(await button.innerText(), /Count is 1/);

    // Auto-reveal: the source opened beside the preview with no Quick Edit
    // click — this IS the workbench's click-to-source contract.
    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /ActionButton\.tsx/);
    await editor.locator(".cm-rootray-marked-line").waitFor({ timeout: 10_000 });
    // …and the preview host is still there — code revealed beside it.
    await appPage.locator(".preview-host").waitFor({ timeout: 5_000 });
    await shot(appPage, SHOTS, "04-click-to-source");
    console.log(`  ok  click-to-source: ${selFile} ${selPos} opened beside the preview`);

    await appPage.locator(".intel-section").first().waitFor({ timeout: 10_000 });
    const intelText = await appPage.locator(".inspector").innerText();
    assert.match(intelText, /ActionButton/, "component intelligence missing");
    await appPage.locator(".boxmodel").waitFor({ timeout: 10_000 });
    console.log("  ok  component + style intelligence rendered");

    // ---- edit in place → save → HMR inside the embedded preview ------------
    // .cm-content's box can extend past the scrollport under the right
    // pane — click a line instead: its box is inside the visible editor.
    await appPage.locator(".cm-line").first().click();
    await appPage.keyboard.press("ControlOrMeta+a");
    await appPage.keyboard.insertText(EDITED_SOURCE);
    await appPage.locator(".qe-foot button", { hasText: "Save" }).click();
    await waitText(appPage, "Saved", 15_000);
    await shot(appPage, SHOTS, "05-saved");

    await devPage
      .locator("button", { hasText: "Count is now 1" })
      .first()
      .waitFor({ timeout: 20_000 });
    await shot(devPage, SHOTS, "06-hmr-in-preview");
    console.log("  ok  Quick Edit saved; Vite HMR updated the embedded preview");

    // ---- re-inspect after HMR ----------------------------------------------
    await appPage.locator('button[aria-label="Clear selection"]').click();
    await button.click(); // still inspecting — select again
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    assert.equal(
      (await appPage.locator(".sel-file").innerText()).trim(),
      "src/components/ActionButton.tsx",
    );
    console.log("  ok  re-inspection after HMR resolves the same source");

    // ---- Escape inside the preview returns to Interact ----------------------
    await devPage.keyboard.press("Escape");
    await waitText(appPage, "Browser Connected", 15_000);
    console.log("  ok  Escape inside the preview exits Inspect mode");

    // ---- Ctrl+Shift+C inside the preview toggles Inspect --------------------
    await devPage.keyboard.press("Control+Shift+C");
    await waitText(appPage, "Inspecting", 15_000);
    await devPage.keyboard.press("Control+Shift+C");
    await waitText(appPage, "Browser Connected", 15_000);
    console.log("  ok  Ctrl+Shift+C toggles Inspect mode from the preview");

    // ---- toolbar: navigate / back / forward / reload -------------------------
    const urlInput = appPage.locator(".preview-url");
    const base = appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
    const navUrl = `${base}?nav=1`;
    await urlInput.fill(navUrl);
    await urlInput.press("Enter");
    await until(() => devPage.url().includes("nav=1"), "preview navigate", 15_000);

    await appPage.locator('button[aria-label="Back"]').click();
    await until(() => !devPage.url().includes("nav=1"), "preview back", 15_000);
    await appPage.locator('button[aria-label="Forward"]').click();
    await until(() => devPage.url().includes("nav=1"), "preview forward", 15_000);

    // Reload: a page-global marker must not survive a real reload.
    await devPage.evaluate(() => {
      window.__rr_marker = 1;
    });
    await appPage.locator('button[aria-label="Reload"]').click();
    await until(
      async () => (await devPage.evaluate(() => window.__rr_marker)) === undefined,
      "preview reload to clear page globals",
      20_000,
    );
    await waitText(devPage, "Inspector fixture", 30_000);
    console.log("  ok  toolbar: navigate · back · forward · reload all work");

    // ---- popup policy: local window.open navigates the preview itself -------
    await devPage.evaluate(() => window.open("?popup=1"));
    await until(() => devPage.url().includes("popup=1"), "local popup to navigate preview", 15_000);
    // No extra top-level window/target was spawned for it.
    const stray = allPages(cdp).filter((p) => p.url().includes("popup=1") && p !== devPage);
    assert.equal(stray.length, 0, "local popup must not spawn a second surface");
    await devPage.goto(base);
    console.log("  ok  window.open stays inside the preview — no child windows");

    // ---- Stop → preview teardown + process tree cleanup ----------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, SHOTS, "07-stopped");

    // The preview surface is gone — its CDP target must disappear. Match
    // on the dev-server origin, not "localhost" — the app UI itself is
    // served from tauri.localhost.
    const origin = base.slice(0, -1);
    await until(
      () => !allPages(cdp).some((p) => p.url().startsWith(origin)),
      "preview CDP target teardown",
      15_000,
    ).catch(async () => {
      // A detached target can linger as closed — assert it is gone-or-dead.
      await until(() => devPage.isClosed(), "preview page close", 10_000);
    });
    console.log("  ok  embedded preview surface torn down on stop");

    await sleep(1500);
    const kids = childProcs(appProc.pid).filter((n) => /node|npm|vite|cmd/i.test(n));
    assert.deepEqual(kids, [], `dev process tree still alive: ${kids.join(", ")}`);
    let urlDead = false;
    const urlDeadline = Date.now() + 6000;
    do {
      try {
        await fetch(appUrl, { signal: AbortSignal.timeout(2000) });
      } catch {
        urlDead = true;
        break;
      }
      await sleep(250);
    } while (Date.now() < urlDeadline);
    assert.ok(urlDead, "dev server still responds after Stop");
    console.log("  ok  dev server stopped; owned process tree exited; URL dead");

    console.log("\nINSTALLED GOLDEN PATH (INTERNAL PREVIEW): PASS");
  } finally {
    writeFileSync(EDIT_TARGET, ORIGINAL_SOURCE, "utf8");
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED GOLDEN PATH (INTERNAL PREVIEW): FAIL — ${e.message}`);
  process.exit(1);
});
