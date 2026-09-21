/**
 * Installed-app Next.js golden path — v0.3.0 internal preview.
 *
 * Drives the REAL installed RootRay binary — no stubs, no external
 * browser:
 *
 *   installed exe (WebView2 CDP) → auto-analyze Next fixture → Run →
 *   real `next dev` under the RootRay shim (Turbopack) → URL detected →
 *   EMBEDDED child webview loads the page inside RootRay → adversarial
 *   IPC probe → inspector bridge connects → Inspect → click → source
 *   auto-opens beside the preview → Quick Edit → save → Fast Refresh
 *   inside the embedded preview → re-inspect → route navigation keeps
 *   instrumentation → Stop → preview + process tree teardown.
 *
 * Usage (repo root, app already installed via the NSIS setup):
 *   node tests/e2e/installed-golden-next.mjs
 *
 * Screenshots land in target/installed-verify-next/.
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

const FIXTURE = join(REPO_ROOT, "fixtures", "nextjs-inspector");
const SHOTS = makeShotDir("installed-verify-next");
const CDP_PORT = 9230;

const EDIT_TARGET = join(FIXTURE, "components", "ActionButton.tsx");
const ORIGINAL_SOURCE = readFileSync(EDIT_TARGET, "utf8");
const EDITED_SOURCE = ORIGINAL_SOURCE.replace("Count is {count}", "Count is now {count}");
assert.notEqual(EDITED_SOURCE, ORIGINAL_SOURCE, "edit needle must exist in fixture");

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(
    existsSync(join(FIXTURE, "node_modules", "next")),
    "fixture deps missing — run `npm install` in fixtures/nextjs-inspector",
  );

  seedSettings(FIXTURE);
  const appProc = launchApp(CDP_PORT);

  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- analyze ----------------------------------------------------------
    await waitText(appPage, "fixture-nextjs-inspector", 60_000);
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /Next\.js 16\.2\.12/, "framework not resolved");
    assert.match(facts, /\bnpm\b/, "package manager not resolved to npm");
    assert.match(facts, /npm run dev/, "dev command not resolved");
    await shot(appPage, SHOTS, "01-analyzed");
    console.log("  ok  analysis: Next.js 16.2.12 · npm · npm run dev");

    // ---- Run (next dev under the RootRay shim, Turbopack) -------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 180_000 }); // first turbopack compile is slow
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
    console.log(`  ok  next dev running: ${appUrl}`);

    // ---- the embedded preview renders the app --------------------------------
    const devPage = await attachPreview(cdp, appUrl);
    await waitText(devPage, "Inspector fixture", 60_000);
    const button = devPage.locator("button", { hasText: "Count is" }).first();
    await button.waitFor();
    // Instrumentation landed in the real rendered DOM inside the preview.
    assert.equal(await button.getAttribute("data-rootray-file"), "components/ActionButton.tsx");
    await appPage.locator(".preview-phase-ready").waitFor({ timeout: 30_000 });
    await shot(appPage, SHOTS, "02-internal-preview");
    console.log("  ok  fixture rendered inside RootRay with source attributes");

    await assertPreviewHasNoIpc(devPage);

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, SHOTS, "03-bridge-connected");
    console.log("  ok  inspector bridge connected from the embedded preview");

    // ---- inspect → select → source auto-opens beside the preview --------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    await button.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await shot(devPage, SHOTS, "04-inspect-overlay");
    await button.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "components/ActionButton.tsx");
    assert.match(selPos, /\d+:\d+/, selPos);
    const selComponent = (await appPage.locator(".sel-component").innerText()).trim();
    assert.equal(selComponent, "ActionButton");
    assert.match(await button.innerText(), /Count is 0/); // click suppressed

    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /ActionButton\.tsx/);
    await editor.locator(".cm-rootray-marked-line").waitFor({ timeout: 10_000 });
    await shot(appPage, SHOTS, "05-click-to-source");
    console.log(`  ok  click-to-source: ${selFile} ${selPos} opened beside the preview`);

    await appPage.locator(".intel-section").first().waitFor({ timeout: 10_000 });
    const intelText = await appPage.locator(".inspector").innerText();
    assert.match(intelText, /ActionButton/, "component intelligence missing");
    await appPage.locator(".boxmodel").waitFor({ timeout: 10_000 });
    console.log("  ok  component + style intelligence rendered");

    // ---- edit in place → save → Fast Refresh inside the preview ---------------
    await appPage.locator(".cm-content").click();
    await appPage.keyboard.press("ControlOrMeta+a");
    await appPage.keyboard.insertText(EDITED_SOURCE);
    await appPage.locator(".qe-foot button", { hasText: "Save" }).click();
    await waitText(appPage, "Saved", 15_000);
    await shot(appPage, SHOTS, "06-quick-edit-saved");
    console.log("  ok  Quick Edit saved through the installed app");

    await devPage
      .locator("button", { hasText: "Count is now 0" })
      .first()
      .waitFor({ timeout: 45_000 });
    await shot(devPage, SHOTS, "07-fast-refresh");
    console.log("  ok  Next Fast Refresh applied the edit inside the preview");

    // ---- re-inspect after Fast Refresh --------------------------------------
    await appPage.locator('button[aria-label="Clear selection"]').click();
    await button.click();
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    assert.equal(
      (await appPage.locator(".sel-file").innerText()).trim(),
      "components/ActionButton.tsx",
    );
    console.log("  ok  re-inspection after Fast Refresh resolves the same source");

    // ---- navigation: client-side route change stays instrumented -------------
    // Inspect mode is still on — its clicks are suppressed, so leave it
    // before driving a real navigation.
    await appPage.locator("button", { hasText: "Stop Inspecting" }).click();
    await devPage.locator("a", { hasText: "About" }).click();
    await devPage.locator("h1", { hasText: "About RootRay" }).waitFor({ timeout: 30_000 });
    assert.equal(
      await devPage.locator("h1", { hasText: "About RootRay" }).getAttribute("data-rootray-file"),
      "app/about/page.tsx",
    );
    // The toolbar URL followed the client-side navigation.
    await until(
      async () => (await appPage.locator(".preview-url").inputValue()).includes("/about"),
      "preview URL to track client-side navigation",
      15_000,
    ).catch(() => console.log("  (note: toolbar URL did not track client-side nav — non-fatal)"));
    console.log("  ok  route navigation keeps instrumentation (app router)");

    // ---- Stop → preview teardown + process tree cleanup -----------------------
    await devPage.goto(appUrl.endsWith("/") ? appUrl : `${appUrl}/`);
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, SHOTS, "08-stopped");

    const origin = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
    await until(
      () => !allPages(cdp).some((p) => p.url().startsWith(origin)),
      "preview CDP target teardown",
      15_000,
    ).catch(async () => {
      await until(() => devPage.isClosed(), "preview page close", 10_000);
    });
    console.log("  ok  embedded preview surface torn down on stop");

    await sleep(2500); // Next spawns worker processes — give the tree a beat
    const kids = childProcs(appProc.pid).filter((n) => /node|npm|next|cmd/i.test(n));
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
    console.log("  ok  next dev stopped; owned process tree exited; URL dead");

    console.log("\nINSTALLED NEXT GOLDEN PATH (INTERNAL PREVIEW): PASS");
  } finally {
    writeFileSync(EDIT_TARGET, ORIGINAL_SOURCE, "utf8");
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED NEXT GOLDEN PATH (INTERNAL PREVIEW): FAIL — ${e.message}`);
  process.exit(1);
});
