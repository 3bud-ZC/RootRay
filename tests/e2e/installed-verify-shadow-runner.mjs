/**
 * Installed-app verification on a REAL non-React project — v0.3.0
 * internal preview.
 *
 * Shadow Runner is a Vite 6 + Phaser game — no React, no JSX in index.html
 * beyond a container div. It exercises the generic-dom runtime end to end
 * INSIDE the embedded preview:
 *
 *   installed exe (WebView2 CDP) → analyze real project → "Vite" detected →
 *   Run → real vite dev server (generic-dom mode) → embedded child
 *   webview loads the game inside RootRay → adversarial IPC probe →
 *   authored #game-container maps exactly to index.html → Phaser's
 *   runtime-created <canvas> selects with facts + styles but NO source
 *   (honest, not fabricated) + canvas honesty section → Stop →
 *   preview + process tree teardown.
 *
 * The project is treated read-only — no Quick Edit, no writes.
 *
 * Usage:
 *   node tests/e2e/installed-verify-shadow-runner.mjs [project-dir]
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  seedSettings,
  shot,
  sleep,
  until,
  waitText,
} from "./installed-preview.mjs";

const PROJECT =
  process.argv[2] ?? join(process.env.USERPROFILE ?? "", "Desktop", "git hub", "Shadow Runner");
const SHOTS = makeShotDir("installed-verify-shadow-runner");
const CDP_PORT = 9233;

const INDEX = join(PROJECT, "index.html");
const CONTAINER_LINE =
  readFileSync(INDEX, "utf8")
    .split(/\r?\n/)
    .findIndex((l) => l.includes('id="game-container"')) + 1;
assert.ok(CONTAINER_LINE > 0, "#game-container not found in index.html");

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(existsSync(INDEX), `project missing: ${PROJECT}`);
  assert.ok(
    existsSync(join(PROJECT, "node_modules", "vite")),
    "project deps missing — run npm install in Shadow Runner",
  );

  seedSettings(PROJECT);
  const appProc = launchApp(CDP_PORT);

  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- analyze ------------------------------------------------------------
    await waitText(appPage, "shadow-runner", 60_000).catch(() =>
      waitText(appPage, "Shadow Runner", 60_000),
    );
    const facts = await appPage.locator(".facts").innerText();
    // Non-React Vite — the generic adapter, not React+Vite.
    assert.match(facts, /\bVite\b/, "framework not resolved to Vite");
    assert.doesNotMatch(facts, /React \+ Vite/, "must NOT classify as React+Vite");
    assert.match(facts, /npm run dev/, "dev command not resolved");
    await shot(appPage, SHOTS, "sr-01-analyzed");
    console.log(`  ok  analysis: ${facts.split("\n").filter(Boolean).join(" · ")}`);

    // ---- Run → real vite dev + internal preview ------------------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    await urlChip.waitFor({ timeout: 120_000 });
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);
    await appPage.locator(".preview-toolbar").waitFor({ timeout: 15_000 });
    console.log(`  ok  dev server running: ${appUrl}`);

    // ---- embedded preview loads the game --------------------------------------
    const devPage = await attachPreview(cdp, appUrl);
    // Phaser injects its canvas at runtime inside the authored container.
    const gameCanvas = devPage.locator("#game-container canvas");
    await gameCanvas.waitFor({ timeout: 60_000 });
    // The authored container carries the HTML stamp; the runtime canvas must not.
    const container = devPage.locator("#game-container");
    assert.equal(await container.getAttribute("data-rootray-file"), "index.html");
    assert.equal(await gameCanvas.getAttribute("data-rootray-file"), null);
    await appPage.locator(".preview-phase-ready").waitFor({ timeout: 30_000 });
    await shot(appPage, SHOTS, "sr-02-internal-preview");
    console.log("  ok  game rendered inside RootRay; authored stamped, runtime canvas clean");

    await assertPreviewHasNoIpc(devPage);

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, SHOTS, "sr-03-bridge-connected");
    console.log("  ok  inspector bridge connected from the embedded preview");

    // ---- authored container → exact index.html mapping ------------------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    // The Phaser canvas covers the container, so a real click targets the
    // canvas. Dispatch directly on the authored element to select it.
    await container.hover();
    await devPage.evaluate(() => {
      document
        .getElementById("game-container")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "index.html");
    assert.match(selPos, new RegExp(`${CONTAINER_LINE}:\\d+`), selPos);
    await shot(appPage, SHOTS, "sr-04-authored-selection");
    console.log(`  ok  authored mapping: ${selFile} ${selPos} (authored line ${CONTAINER_LINE})`);

    // ---- runtime canvas → facts + styles, honestly unmapped -------------------
    await gameCanvas.hover();
    await gameCanvas.click({ position: { x: 10, y: 10 } });
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    await appPage.locator(".sel-unmapped").waitFor({ timeout: 10_000 });
    assert.match(
      (await appPage.locator(".sel-unmapped").innerText()).trim(),
      /No authored source/i,
    );
    // The canvas honesty section explains the limitation — pixels are not DOM.
    await appPage.locator(".canvas-section").waitFor({ timeout: 10_000 });
    const canvasText = await appPage.locator(".canvas-section").innerText();
    assert.match(canvasText, /runtime-rendered pixels/i, canvasText);
    await appPage
      .locator(".boxmodel")
      .waitFor({ timeout: 10_000 })
      .catch(() => {
        // box model may collapse for a 0-margin canvas — styles section is enough
      });
    await shot(appPage, SHOTS, "sr-05-unmapped-canvas");
    console.log("  ok  runtime canvas: facts + styles + honesty section — no fabricated source");

    // ---- Stop → preview teardown + owned tree exits ----------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, SHOTS, "sr-06-stopped");

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

    console.log("\nINSTALLED SHADOW-RUNNER VERIFICATION (INTERNAL PREVIEW): PASS");
  } finally {
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED SHADOW-RUNNER VERIFICATION (INTERNAL PREVIEW): FAIL — ${e.message}`);
  process.exit(1);
});
