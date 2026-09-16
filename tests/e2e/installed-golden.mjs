/**
 * Installed-app golden path verification (v0.2.0 Milestone 01 acceptance).
 *
 * Drives the REAL installed RootRay binary — not a dev server, not a stub:
 *
 *   installed exe (WebView2 CDP) → auto-analyze fixture → Run Project →
 *   real Vite dev server (spawned by the app) → URL detected →
 *   real Chromium loads the page → inspector bridge connects →
 *   Inspect UI → click element → source mapping → component/style
 *   intelligence → Quick Edit → save → Vite HMR → re-inspect →
 *   Stop → owned process tree exits.
 *
 * Usage (repo root, app already installed via the NSIS setup):
 *   node tests/e2e/installed-golden.mjs
 *
 * Screenshots land in target/installed-verify/.
 */

import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "fixtures", "vite-react-inspector");
const EXE = join(process.env.LOCALAPPDATA ?? "", "RootRay", "rootray-desktop.exe");
const CFG_DIR = join(process.env.APPDATA ?? "", "dev.rootray.app");
const SHOTS = join(REPO_ROOT, "target", "installed-verify");
const CDP_PORT = 9229;

const EDIT_TARGET = join(FIXTURE, "src", "components", "ActionButton.tsx");
const ORIGINAL_SOURCE = readFileSync(EDIT_TARGET, "utf8");
const EDITED_SOURCE = ORIGINAL_SOURCE.replace("Count is {count}", "Count is now {count}");
assert.notEqual(EDITED_SOURCE, ORIGINAL_SOURCE, "edit needle must exist in fixture");

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

/** Child processes of the installed app, via CIM. */
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
  assert.ok(
    existsSync(join(FIXTURE, "node_modules", "vite")),
    "fixture deps missing — run `npm install` in fixtures/vite-react-inspector",
  );

  // Seed settings: auto-restore this workspace on launch; never auto-open a
  // browser — the harness opens the page itself in controlled Chromium.
  const settings = {
    lastProject: FIXTURE,
    recentProjects: [FIXTURE],
    preferredLauncher: null,
    openBrowserAutomatically: false,
  };
  writeFileSync(join(CFG_DIR, "settings.json"), JSON.stringify(settings), { encoding: "utf8" });
  console.log(`seeded lastProject = ${FIXTURE}`);

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
    // ---- attach to the installed app's WebView2 -------------------------
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

    // ---- analyze (auto-restored via lastProject) -------------------------
    await waitText(appPage, "fixture-vite-react-inspector", 60_000);
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /React \+ Vite 7\.1\.0/, "framework not resolved");
    assert.match(facts, /\bnpm\b/, "package manager not resolved to npm");
    assert.match(facts, /npm run dev/, "dev command not resolved");
    await appPage
      .locator(".run-state")
      .waitFor({ state: "detached", timeout: 5000 })
      .catch(() => {});
    await shot(appPage, "01-analyzed");
    console.log("  ok  analysis: React + Vite 7.1.0 · npm · npm run dev");

    // ---- Run ------------------------------------------------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 120_000 });
    } catch (e) {
      // Capture what the app actually shows before failing.
      await shot(appPage, "run-timeout");
      const notice = await appPage
        .locator(".notice")
        .innerText()
        .catch(() => "");
      const logs = await appPage
        .locator(".logs, .log-panel")
        .innerText()
        .catch(() => "");
      const runtime = await appPage
        .evaluate(() => (window.__TAURI_INTERNALS__ ? "has-tauri" : "no-tauri"))
        .catch(() => "eval-failed");
      console.error(`notice=${notice}\nlogs=${logs}\nruntime=${runtime}`);
      throw e;
    }
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);
    await shot(appPage, "02-running");
    console.log(`  ok  dev server running: ${appUrl}`);

    // ---- real browser loads the rendered app -----------------------------
    fixtureBrowser = await chromium.launch();
    const devPage = await fixtureBrowser.newPage();
    await devPage.goto(appUrl);
    await waitText(devPage, "Inspector fixture", 30_000);
    const button = devPage.locator("button", { hasText: "Count is" }).first();
    await button.waitFor();
    console.log("  ok  fixture rendered in Chromium");

    // Inspector bridge: runtime in the page connected back to the app.
    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, "03-bridge-connected");
    console.log("  ok  inspector bridge connected");

    // ---- inspect → select → source mapping -------------------------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    await button.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await shot(devPage, "04-inspect-overlay");
    await button.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "src/components/ActionButton.tsx");
    assert.match(selPos, /Line \d+ · Column \d+/, selPos);
    const selComponent = (await appPage.locator(".sel-component").innerText()).trim();
    assert.equal(selComponent, "ActionButton");
    // Inspected click was suppressed — counter still 0.
    assert.match(await button.innerText(), /Count is 0/);
    await shot(appPage, "05-selected");
    console.log(`  ok  source mapping: ${selFile} ${selPos} · component ActionButton`);

    // Component + style intelligence sections rendered from the selection.
    await appPage.locator(".intel-section").first().waitFor({ timeout: 10_000 });
    const intelText = await appPage.locator(".inspector").innerText();
    assert.match(intelText, /ActionButton/, "component intelligence missing");
    // Style intelligence: box model + matched CSS rules for the selection.
    await appPage.locator(".boxmodel").waitFor({ timeout: 10_000 });
    console.log("  ok  component + style intelligence rendered");

    // ---- Quick Edit → save → HMR -------------------------------------------
    await appPage.locator("button", { hasText: "Quick Edit" }).click();
    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /ActionButton\.tsx/);
    await appPage.locator(".cm-content").click();
    await appPage.keyboard.press("ControlOrMeta+a");
    await appPage.keyboard.insertText(EDITED_SOURCE);
    await appPage.locator(".qe-foot button", { hasText: "Save" }).click();
    await waitText(appPage, "Saved", 15_000);
    await shot(appPage, "06-quick-edit-saved");
    console.log("  ok  Quick Edit saved through the installed app");

    // HMR: the running dev server must hot-update the rendered page.
    await devPage
      .locator("button", { hasText: "Count is now 0" })
      .first()
      .waitFor({ timeout: 20_000 });
    await shot(devPage, "07-hmr-updated");
    console.log("  ok  Vite HMR applied the edit in the rendered page");

    // ---- re-inspect after HMR ----------------------------------------------
    await appPage.locator('button[aria-label="Clear selection"]').click();
    await button.click(); // still in inspect mode — select again
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    assert.equal(
      (await appPage.locator(".sel-file").innerText()).trim(),
      "src/components/ActionButton.tsx",
    );
    console.log("  ok  re-inspection after HMR resolves the same source");

    // ---- Stop → process tree cleanup ----------------------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, "08-stopped");

    await sleep(1500);
    const kids = childProcs(appProc.pid).filter((n) => /node|npm|vite|cmd/i.test(n));
    assert.deepEqual(kids, [], `dev process tree still alive: ${kids.join(", ")}`);
    let urlDead = false;
    try {
      await devPage.goto(appUrl, { timeout: 5000 });
    } catch {
      urlDead = true;
    }
    assert.ok(urlDead, "dev server still responds after Stop");
    console.log("  ok  dev server stopped; owned process tree exited; URL dead");

    console.log("\nINSTALLED GOLDEN PATH: PASS");
  } finally {
    // Always restore the fixture and kill the app.
    writeFileSync(EDIT_TARGET, ORIGINAL_SOURCE, "utf8");
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
  console.error(`\nINSTALLED GOLDEN PATH: FAIL — ${e.message}`);
  process.exit(1);
});
