/**
 * Installed-app golden path for STATIC targets (v0.2.0 Milestone 03).
 *
 * Drives the REAL installed RootRay binary against fixtures/static-web —
 * a project with NO package.json and NO dev script:
 *
 *   installed exe (WebView2 CDP) → auto-analyze → "Static Web" detected →
 *   Run Project → native loopback static server (Rust) → real Chromium
 *   loads the page → inspector runtime injected + authenticated →
 *   Inspect → authored <canvas> maps exactly to index.html →
 *   runtime-created element selects with facts but NO source →
 *   Quick Edit → save → SSE reload applies the change →
 *   Stop → owned server exits, URL dead.
 *
 * Usage (repo root, app already installed via the NSIS setup):
 *   node tests/e2e/installed-golden-static.mjs
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
const FIXTURE = join(REPO_ROOT, "fixtures", "static-web");
const EXE = join(process.env.LOCALAPPDATA ?? "", "RootRay", "rootray-desktop.exe");
const CFG_DIR = join(process.env.APPDATA ?? "", "dev.rootray.app");
const SHOTS = join(REPO_ROOT, "target", "installed-verify");
const CDP_PORT = 9230;

const INDEX = join(FIXTURE, "index.html");
const ORIGINAL_HTML = readFileSync(INDEX, "utf8");
const CANVAS_LINE =
  ORIGINAL_HTML.split(/\r?\n/).findIndex((l) => l.includes("<canvas")) + 1;
assert.ok(CANVAS_LINE > 0, "canvas not found in fixture index.html");
const EDITED_HTML = ORIGINAL_HTML.replace(
  '<canvas id="arena"></canvas>',
  '<canvas id="arena"></canvas>\n    <p id="edited-marker">static edit applied</p>',
);
assert.notEqual(EDITED_HTML, ORIGINAL_HTML, "edit needle must exist in fixture");

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
    await waitText(appPage, "fixture-static-web", 60_000).catch(() =>
      waitText(appPage, "static-web", 60_000),
    );
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /Static Web/, "framework not resolved to Static Web");
    await shot(appPage, "01-analyzed");
    console.log("  ok  analysis: Static Web target detected");

    // ---- Run → native static server ---------------------------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 60_000 });
    } catch (e) {
      await shot(appPage, "run-timeout");
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
    await shot(appPage, "02-running");
    console.log(`  ok  static server running: ${appUrl}`);

    // ---- real browser loads the rendered app -----------------------------
    fixtureBrowser = await chromium.launch();
    const devPage = await fixtureBrowser.newPage();
    await devPage.goto(appUrl);
    const canvas = devPage.locator("#arena");
    await canvas.waitFor({ timeout: 30_000 });
    // HTML instrumentation is visible on the served DOM.
    assert.equal(await canvas.getAttribute("data-rootray-file"), "index.html");
    console.log("  ok  fixture rendered; authored canvas carries data-rootray-* stamp");

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, "03-bridge-connected");
    console.log("  ok  inspector bridge connected");

    // ---- inspect → authored element maps to index.html --------------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);
    await canvas.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await shot(devPage, "04-inspect-overlay");
    await canvas.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    assert.equal(selFile, "index.html");
    assert.match(selPos, new RegExp(`Line ${CANVAS_LINE} · Column \\d+`), selPos);
    await shot(appPage, "05-selected");
    console.log(`  ok  source mapping: ${selFile} ${selPos} (authored line ${CANVAS_LINE})`);

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
    // Source-dependent actions stay disabled.
    const qeDisabled = await appPage
      .locator("button", { hasText: "Quick Edit" })
      .isDisabled();
    assert.ok(qeDisabled, "Quick Edit must be disabled for source-less selection");
    await shot(appPage, "06-unmapped-selection");
    console.log("  ok  runtime-created element: facts + styles, honestly unmapped");

    // ---- Quick Edit → save → SSE reload -----------------------------------
    // Select the authored canvas again so Quick Edit targets index.html.
    await canvas.click();
    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    await appPage.locator(".sel-file").waitFor({ timeout: 10_000 });
    await appPage.locator("button", { hasText: "Quick Edit" }).click();
    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    assert.match(await editor.locator(".qe-path").innerText(), /index\.html/);
    await appPage.locator(".cm-content").click();
    await appPage.keyboard.press("ControlOrMeta+a");
    await appPage.keyboard.insertText(EDITED_HTML);
    await appPage.locator(".qe-foot button", { hasText: "Save" }).click();
    await waitText(appPage, "Saved", 15_000);
    await shot(appPage, "07-quick-edit-saved");
    console.log("  ok  Quick Edit saved index.html");

    // SSE reload: the running page must reload and show the new content.
    await devPage.locator("#edited-marker").waitFor({ timeout: 20_000 });
    await shot(devPage, "08-sse-reload");
    console.log("  ok  SSE reload applied the saved file to the running page");

    // ---- Stop → owned server exits ----------------------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, "09-stopped");

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

    console.log("\nINSTALLED GOLDEN PATH (STATIC): PASS");
  } finally {
    writeFileSync(INDEX, ORIGINAL_HTML, "utf8");
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
  console.error(`\nINSTALLED GOLDEN PATH (STATIC): FAIL — ${e.message}`);
  process.exit(1);
});
