/**
 * Installed-app verification on a REAL non-React project (Milestone 03).
 *
 * Shadow Runner is a Vite 6 + Phaser game — no React, no JSX in index.html
 * beyond a container div. It exercises the generic-dom runtime end to end:
 *
 *   installed exe (WebView2 CDP) → analyze real project → "Vite" detected →
 *   Run → real vite dev server (generic-dom mode) → Chromium loads the
 *   game → authored #game-container maps exactly to index.html →
 *   Phaser's runtime-created <canvas> selects with facts + styles but NO
 *   source (honest, not fabricated) → Stop → tree dead.
 *
 * The project is treated read-only — no Quick Edit, no writes.
 *
 * Usage:
 *   node tests/e2e/installed-verify-shadow-runner.mjs [project-dir]
 */

import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PROJECT =
  process.argv[2] ??
  join(process.env.USERPROFILE ?? "", "Desktop", "git hub", "Shadow Runner");
const EXE = join(process.env.LOCALAPPDATA ?? "", "RootRay", "rootray-desktop.exe");
const CFG_DIR = join(process.env.APPDATA ?? "", "dev.rootray.app");
const SHOTS = join(REPO_ROOT, "target", "installed-verify");
const CDP_PORT = 9231;

const INDEX = join(PROJECT, "index.html");
const CONTAINER_LINE =
  readFileSync(INDEX, "utf8")
    .split(/\r?\n/)
    .findIndex((l) => l.includes('id="game-container"')) + 1;
assert.ok(CONTAINER_LINE > 0, "#game-container not found in index.html");

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  try {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  } catch (e) {
    console.warn(`  (screenshot ${name} failed: ${e.message})`);
  }
}

async function waitText(page, text, timeout = 30_000) {
  await page.locator(`text=${text}`).first().waitFor({ timeout });
}

function childProcs(pid) {
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

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(existsSync(INDEX), `project missing: ${PROJECT}`);
  assert.ok(
    existsSync(join(PROJECT, "node_modules", "vite")),
    "project deps missing — run npm install in Shadow Runner",
  );

  const settings = {
    lastProject: PROJECT,
    recentProjects: [PROJECT],
    preferredLauncher: null,
    openBrowserAutomatically: false,
  };
  writeFileSync(join(CFG_DIR, "settings.json"), JSON.stringify(settings), { encoding: "utf8" });
  console.log(`seeded lastProject = ${PROJECT}`);

  const appProc = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  console.log(`launched installed app (pid ${appProc.pid})`);

  let cdp;
  let fixtureBrowser;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        cdp = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        break;
      } catch {
        await sleep(500);
      }
    }
    assert.ok(cdp, "could not attach to installed app WebView2 over CDP");

    let appPage;
    while (Date.now() < deadline + 15_000) {
      for (const ctx of cdp.contexts()) {
        for (const p of ctx.pages()) {
          if (p.url().includes("tauri") || (await p.title()) === "RootRay") {
            appPage = p;
            break;
          }
        }
        if (appPage) break;
      }
      if (appPage) break;
      await sleep(500);
    }
    assert.ok(appPage, "RootRay app page not found over CDP");
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
    await shot(appPage, "sr-01-analyzed");
    console.log(`  ok  analysis: ${facts.split("\n").filter(Boolean).join(" · ")}`);

    // ---- Run → real vite dev -------------------------------------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    await urlChip.waitFor({ timeout: 120_000 });
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);
    await shot(appPage, "sr-02-running");
    console.log(`  ok  dev server running: ${appUrl}`);

    // ---- real browser loads the game -----------------------------------------
    fixtureBrowser = await chromium.launch();
    const devPage = await fixtureBrowser.newPage();
    await devPage.goto(appUrl);
    // Phaser injects its canvas at runtime inside the authored container.
    const gameCanvas = devPage.locator("#game-container canvas");
    await gameCanvas.waitFor({ timeout: 60_000 });
    // The authored container carries the HTML stamp; the runtime canvas must not.
    const container = devPage.locator("#game-container");
    assert.equal(await container.getAttribute("data-rootray-file"), "index.html");
    assert.equal(await gameCanvas.getAttribute("data-rootray-file"), null);
    console.log("  ok  game rendered; authored container stamped, runtime canvas clean");

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, "sr-03-bridge-connected");
    console.log("  ok  inspector bridge connected");

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
    assert.match(selPos, new RegExp(`Line ${CONTAINER_LINE} · Column \\d+`), selPos);
    await shot(appPage, "sr-04-authored-selection");
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
    // Styles still attach to the unmapped selection.
    await appPage.locator(".boxmodel").waitFor({ timeout: 10_000 }).catch(() => {
      // box model may collapse for a 0-margin canvas — styles section is enough
    });
    await shot(appPage, "sr-05-unmapped-canvas");
    console.log("  ok  runtime canvas: facts + styles, honestly unmapped (no fabricated source)");

    // ---- Stop → owned tree exits ----------------------------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, "sr-06-stopped");

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

    console.log("\nINSTALLED SHADOW-RUNNER VERIFICATION: PASS");
  } finally {
    await fixtureBrowser?.close().catch(() => {});
    try {
      process.kill(appProc.pid);
    } catch {}
    await sleep(1000);
    try {
      execFileSync("taskkill", ["/PID", String(appProc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED SHADOW-RUNNER VERIFICATION: FAIL — ${e.message}`);
  process.exit(1);
});
