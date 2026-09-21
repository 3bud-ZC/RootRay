/**
 * Installed-app golden path for STATIC targets — v0.3.0 internal preview.
 *
 * Drives the REAL installed RootRay binary against fixtures/static-web —
 * a project with NO package.json and NO dev script:
 *
 *   installed exe (WebView2 CDP) → auto-analyze → "Static Web" detected →
 *   Run Project → native loopback static server (Rust) → EMBEDDED child
 *   webview loads the page inside RootRay → adversarial IPC probe →
 *   inspector runtime injected + authenticated → Inspect → authored
 *   <canvas> maps exactly to index.html + canvas honesty section →
 *   runtime-created element selects with facts but NO source →
 *   source auto-open + Quick Edit → save → SSE reload inside the
 *   embedded preview → Escape → Stop → surface + server teardown.
 *
 * Usage (repo root, app already installed via the NSIS setup):
 *   node tests/e2e/installed-golden-static.mjs
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

const FIXTURE = join(REPO_ROOT, "fixtures", "static-web");
const SHOTS = makeShotDir("installed-verify-static");
const CDP_PORT = 9231;

const INDEX = join(FIXTURE, "index.html");
const ORIGINAL_HTML = readFileSync(INDEX, "utf8");
const CANVAS_LINE = ORIGINAL_HTML.split(/\r?\n/).findIndex((l) => l.includes("<canvas")) + 1;
assert.ok(CANVAS_LINE > 0, "canvas not found in fixture index.html");
const EDITED_HTML = ORIGINAL_HTML.replace(
  '<canvas id="arena"></canvas>',
  '<canvas id="arena"></canvas>\n    <p id="edited-marker">static edit applied</p>',
);
assert.notEqual(EDITED_HTML, ORIGINAL_HTML, "edit needle must exist in fixture");

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  seedSettings(FIXTURE);
  const appProc = launchApp(CDP_PORT);

  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- analyze (auto-restored via lastProject) -------------------------
    await waitText(appPage, "fixture-static-web", 60_000).catch(() =>
      waitText(appPage, "static-web", 60_000),
    );
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /Static Web/, "framework not resolved to Static Web");
    await shot(appPage, SHOTS, "01-analyzed");
    console.log("  ok  analysis: Static Web target detected");

    // ---- Run → native static server + internal preview --------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 60_000 });
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
    console.log(`  ok  static server running: ${appUrl}`);

    // ---- embedded preview renders the served page ---------------------------
    const devPage = await attachPreview(cdp, appUrl);
    const canvas = devPage.locator("#arena");
    await canvas.waitFor({ timeout: 30_000 });
    assert.equal(await canvas.getAttribute("data-rootray-file"), "index.html");
    await appPage.locator(".preview-phase-ready").waitFor({ timeout: 30_000 });
    await shot(appPage, SHOTS, "02-internal-preview");
    console.log("  ok  fixture rendered inside RootRay; authored canvas stamped");

    await assertPreviewHasNoIpc(devPage);

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, SHOTS, "03-bridge-connected");
    console.log("  ok  inspector bridge connected from the embedded preview");

    // ---- inspect → authored element maps to index.html --------------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    await canvas.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await shot(devPage, SHOTS, "04-inspect-overlay");
    await canvas.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "index.html");
    assert.match(selPos, new RegExp(`${CANVAS_LINE}:\\d+`), selPos);
    // Canvas honesty: the section explains runtime-rendered pixels while the
    // canvas element itself still maps to its authored source.
    await appPage.locator(".canvas-section").waitFor({ timeout: 10_000 });
    await shot(appPage, SHOTS, "05-selected");
    console.log(`  ok  source mapping: ${selFile} ${selPos} (authored line ${CANVAS_LINE})`);

    // Auto-reveal opened index.html beside the preview.
    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /index\.html/);
    console.log("  ok  click-to-source opened index.html beside the preview");

    // ---- runtime-created element: facts + styles, NO source ---------------
    await devPage.evaluate(() => {
      const el = document.createElement("p");
      el.id = "runtime-note";
      el.textContent = "made at runtime";
      document.body.appendChild(el);
    });
    const note = devPage.locator("#runtime-note");
    await note.hover();
    await note.click();
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    await appPage.locator(".sel-unmapped").waitFor({ timeout: 10_000 });
    const unmapped = (await appPage.locator(".sel-unmapped").innerText()).trim();
    assert.match(unmapped, /No authored source/i);
    const qeDisabled = await appPage.locator("button", { hasText: "Quick Edit" }).isDisabled();
    assert.ok(qeDisabled, "Quick Edit must be disabled for source-less selection");
    await shot(appPage, SHOTS, "06-unmapped-selection");
    console.log("  ok  runtime-created element: facts + styles, honestly unmapped");

    // ---- select authored canvas → edit → save → SSE reload ------------------
    await canvas.click();
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    await appPage.locator(".sel-file").waitFor({ timeout: 10_000 });
    // The auto-reveal already targets index.html — the editor is open.
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /index\.html/);
    await appPage.locator(".cm-content").click();
    await appPage.keyboard.press("ControlOrMeta+a");
    await appPage.keyboard.insertText(EDITED_HTML);
    await appPage.locator(".qe-foot button", { hasText: "Save" }).click();
    await waitText(appPage, "Saved", 15_000);
    await shot(appPage, SHOTS, "07-quick-edit-saved");
    console.log("  ok  Quick Edit saved index.html");

    // SSE reload: the embedded preview reloads and shows the new content.
    await devPage.locator("#edited-marker").waitFor({ timeout: 20_000 });
    await shot(devPage, SHOTS, "08-sse-reload");
    console.log("  ok  SSE reload applied the save inside the embedded preview");

    // ---- Escape exits inspect ------------------------------------------------
    await devPage.keyboard.press("Escape");
    await waitText(appPage, "Browser Connected", 15_000);
    console.log("  ok  Escape inside the preview exits Inspect mode");

    // ---- Stop → preview teardown + owned server exits ------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, SHOTS, "09-stopped");

    const origin = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
    await until(
      () => !allPages(cdp).some((p) => p.url().startsWith(origin)),
      "preview CDP target teardown",
      15_000,
    ).catch(async () => {
      await until(() => devPage.isClosed(), "preview page close", 10_000);
    });
    console.log("  ok  embedded preview surface torn down on stop");

    await sleep(1500);
    const kids = childProcs(appProc.pid).filter((n) => /node|npm|vite|cmd/i.test(n));
    assert.deepEqual(kids, [], `server process tree still alive: ${kids.join(", ")}`);
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
    assert.ok(urlDead, "static server still responds after Stop");
    console.log("  ok  static server stopped; URL dead");

    console.log("\nINSTALLED GOLDEN PATH (STATIC, INTERNAL PREVIEW): PASS");
  } finally {
    writeFileSync(INDEX, ORIGINAL_HTML, "utf8");
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED GOLDEN PATH (STATIC, INTERNAL PREVIEW): FAIL — ${e.message}`);
  process.exit(1);
});
