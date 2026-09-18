/**
 * Installed-app layout + runtime-transition verification — ClientFlow-CRM.
 *
 * Drives the REAL installed RootRay binary through the manual-user
 * workflow that motivated the v0.3.0 fix pass:
 *
 *   Run ClientFlow → embedded preview → hide Explorer → hide Inspector →
 *   collapse Output → Preview Focus → exit → Split → resize → Inspect a
 *   real element → source auto-reveals → hide Inspector while selected →
 *   selection survives → restore → resize Output → Restart → Stop →
 *   Run again → Change Project WHILE RUNNING (native dialog filled via
 *   UIAutomation) → the app stops first, then analyzes — no
 *   "illegal runtime state transition" notice anywhere.
 *
 * Asserts after every step that no notice contains the transition error.
 *
 * Usage (repo root, app installed via the NSIS setup):
 *   node tests/e2e/installed-verify-layout.mjs
 */

import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import {
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

const PROJECT = "C:\\Users\\Abud\\Desktop\\git hub\\ClientFlow-CRM";
const CHANGE_TARGET = join(REPO_ROOT, "fixtures", "static-web");
const SHOTS = makeShotDir("installed-verify-layout");
const CDP_PORT = 9235;
const PICK_PS1 = join(REPO_ROOT, "tests", "e2e", "pick-folder.ps1");

const box = async (page, sel) => page.locator(sel).first().boundingBox();

/** No notice bar may carry the transition error — checked after every step. */
async function assertNoIllegalTransition(page, where) {
  const notices = await page
    .locator(".notice")
    .allInnerTexts()
    .catch(() => []);
  const bad = notices.find((t) => /illegal runtime state/i.test(t));
  assert.ok(!bad, `illegal transition notice after ${where}: ${bad}`);
}

/** Spawn the folder-picker helper for the native dialog owned by the app. */
function pickFolder(procPid, folder) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PICK_PS1,
    "-ProcId",
    String(procPid),
    "-Folder",
    folder,
  ];
  return spawn("powershell", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function gitPorcelain() {
  return execSync("git status --porcelain", { cwd: PROJECT, encoding: "utf8" });
}

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(existsSync(join(PROJECT, "node_modules", "next")), "project deps missing");
  assert.ok(existsSync(CHANGE_TARGET), `change target missing: ${CHANGE_TARGET}`);

  const gitBefore = gitPorcelain();
  seedSettings(PROJECT);
  const appProc = launchApp(CDP_PORT);

  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- analyze + run ----------------------------------------------------
    // "ClientFlow-CRM" also appears as a recent item on the home screen, so
    // the analyzed-state marker is the Run button itself — analysis of a
    // real project can take a while on a cold cache.
    const runBtn = appPage.locator("button", { hasText: "Run Project" });
    await runBtn.waitFor({ timeout: 90_000 });
    await runBtn.click();
    const urlChip = appPage.locator(".url-chip");
    await urlChip.waitFor({ timeout: 120_000 });
    const appUrl = (await urlChip.innerText()).trim();
    await appPage.locator(".preview-toolbar").waitFor({ timeout: 15_000 });
    const devPage = await attachPreview(cdp, appUrl);
    await devPage.goto(new URL("/login", appUrl).href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await devPage.locator("input#email").waitFor({ timeout: 60_000 });
    // The bridge-status text lives inside the (possibly hidden) inspector
    // pane — the toolbar Inspect button enabling is the visible proof.
    // Next's first compile can delay the runtime bridge well past 30s.
    await until(
      () =>
        appPage
          .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Inspect" })
          .isEnabled(),
      "inspector bridge to connect",
      60_000,
    ).catch(async (e) => {
      await shot(appPage, SHOTS, "bridge-timeout");
      throw e;
    });
    await assertNoIllegalTransition(appPage, "run + preview");
    console.log(`  ok  running with embedded preview: ${appUrl}`);
    await shot(appPage, SHOTS, "01-running");

    // ---- normalize: persisted layout survives between launches, so a
    // previous session may have left panes hidden. Reset to defaults first —
    // this also exercises the Reset Layout control itself.
    await appPage.locator('button[aria-label="Reset layout"]').click();
    await appPage.locator(".wb-left:not(.wb-hidden)").waitFor({ timeout: 5_000 });
    await appPage.locator(".wb-right:not(.wb-hidden)").waitFor({ timeout: 5_000 });
    console.log("  ok  Reset Layout restored the default panes");

    // ---- pane collapse ------------------------------------------------------
    const hostBefore = await box(appPage, ".preview-host");
    assert.ok(hostBefore, "preview host missing");

    await appPage.locator('button[aria-label="Toggle explorer (Ctrl+B)"]').click();
    await appPage.locator(".wb-left.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    const afterExplorer = await box(appPage, ".preview-host");
    assert.ok(
      afterExplorer.width > hostBefore.width + 40,
      `host did not grow when explorer hid (${hostBefore.width} -> ${afterExplorer.width})`,
    );

    await appPage.locator('button[aria-label="Toggle inspector"]').click();
    await appPage.locator(".wb-right.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    const afterInspector = await box(appPage, ".preview-host");
    assert.ok(
      afterInspector.width > afterExplorer.width + 40,
      `host did not grow when inspector hid (${afterExplorer.width} -> ${afterInspector.width})`,
    );

    // Output defaults collapsed — expand it (preview must shrink), then
    // collapse it back (preview must regain the space).
    await appPage.locator('button[aria-label="Toggle output (Ctrl+J)"]').click();
    await appPage
      .locator('button[aria-label="Collapse output (Ctrl+J)"]')
      .waitFor({ timeout: 5_000 });
    const expandedLog = await box(appPage, ".logpanel");
    const hostExpanded = await box(appPage, ".preview-host");
    assert.ok(expandedLog.height > 60, `output did not expand (${expandedLog.height})`);
    assert.ok(
      hostExpanded.height < afterInspector.height - 30,
      `expanded output did not shrink the preview (${afterInspector.height} -> ${hostExpanded.height})`,
    );
    await appPage.locator('button[aria-label="Collapse output (Ctrl+J)"]').click();
    await appPage
      .locator('button[aria-label="Expand output (Ctrl+J)"]')
      .waitFor({ timeout: 5_000 });
    const afterOutput = await box(appPage, ".preview-host");
    assert.ok(
      afterOutput.height > hostExpanded.height + 30,
      `host did not grow when output collapsed (${hostExpanded.height} -> ${afterOutput.height})`,
    );
    await shot(appPage, SHOTS, "02-panes-collapsed");
    console.log(
      `  ok  explorer+inspector hidden, output collapsed — host ${Math.round(hostBefore.width)}x${Math.round(hostBefore.height)} -> ${Math.round(afterOutput.width)}x${Math.round(afterOutput.height)}`,
    );
    await assertNoIllegalTransition(appPage, "pane collapse");

    // ---- Preview Focus ------------------------------------------------------
    await appPage.locator('button[aria-label="Preview Focus"]').click();
    await appPage.locator(".pv-focus-exit").waitFor({ timeout: 5_000 });
    // Focus must hide every chrome pane — even ones still toggled visible.
    await appPage.locator(".wb-left.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    await appPage.locator(".wb-right.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await appPage.locator(".logpanel").count(), 0, "logpanel mounted in focus");
    const focusBox = await box(appPage, ".preview-host");
    const bodyBox = await box(appPage, ".preview-body");
    assert.ok(
      focusBox.width > bodyBox.width * 0.9,
      `focus preview not dominant (${focusBox.width} of ${bodyBox.width})`,
    );
    await shot(appPage, SHOTS, "03-preview-focus");
    console.log("  ok  Preview Focus — preview fills the workbench");

    // Exit focus — the user's toggles return exactly as they left them.
    await appPage.locator(".pv-focus-exit").click();
    await appPage.locator('button[aria-label="Preview Focus"]').waitFor({ timeout: 5_000 });
    // Explorer/inspector were toggled off BEFORE focus — they must stay off.
    await appPage.locator(".wb-left.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    await appPage.locator(".wb-right.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    await assertNoIllegalTransition(appPage, "exit focus");
    console.log("  ok  exit focus restores the user's pane toggles");

    // ---- Split + resize ------------------------------------------------------
    await appPage.locator("button", { hasText: "Split" }).click();
    await appPage.locator('hr[aria-label="Preview/Code split"]').waitFor({ timeout: 5_000 });
    const splitBefore = await box(appPage, ".preview-host");
    const split = appPage.locator('hr[aria-label="Preview/Code split"]');
    await split.focus();
    await split.press("ArrowRight");
    await split.press("ArrowRight");
    await split.press("ArrowRight");
    await split.press("ArrowRight");
    const splitAfter = await box(appPage, ".preview-host");
    assert.ok(
      splitAfter.width > splitBefore.width + 40,
      `split nudge did not resize preview (${splitBefore.width} -> ${splitAfter.width})`,
    );
    console.log(
      `  ok  Preview/Code split resizes — preview ${Math.round(splitBefore.width)} -> ${Math.round(splitAfter.width)}`,
    );

    // ---- Inspect a real element → source auto-reveals ------------------------
    // The inspector pane is still hidden from the collapse step — selection
    // must resolve and reveal anyway (the pane is optional, per spec).
    await appPage
      .locator('fieldset[aria-label="Interaction mode"] button', { hasText: "Inspect" })
      .click();
    // The phase text lives inside the inspector pane (hidden) — the in-page
    // hover box on the preview is the reliable inspect-mode signal.
    const h1 = devPage.locator("h1").first();
    await h1.waitFor({ timeout: 20_000 });
    await h1.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await h1.click();
    // .selection lives inside the hidden pane — attached, not visible.
    await appPage.locator(".selection").waitFor({ state: "attached", timeout: 15_000 });
    const selFile = (await appPage.locator(".sel-file").first().textContent()).trim();
    assert.ok(existsSync(join(PROJECT, selFile)), `source file missing: ${selFile}`);
    // Auto-reveal opens the mapped file beside the preview even with the
    // inspector hidden — the editor path is the visible proof.
    let revealed = null;
    await until(
      async () => {
        revealed = await appPage
          .locator(".qe-path")
          .innerText()
          .then((s) => s.trim())
          .catch(() => null);
        return revealed === selFile;
      },
      "auto-reveal to open the selected file",
      10_000,
    );
    await shot(appPage, SHOTS, "04-inspect-source");
    console.log(`  ok  inspected <h1> -> ${selFile} revealed (inspector hidden)`);

    // ---- Restore inspector → same selection; hide again → source stays -------
    await appPage.locator('button[aria-label="Toggle inspector"]').click();
    await appPage.locator(".wb-right:not(.wb-hidden)").waitFor({ timeout: 5_000 });
    const selBack = await appPage
      .locator(".sel-file")
      .first()
      .textContent()
      .then((s) => s.trim())
      .catch(() => null);
    assert.equal(selBack, selFile, "restored inspector lost the selection");
    await appPage.locator('button[aria-label="Toggle inspector"]').click();
    await appPage.locator(".wb-right.wb-hidden").waitFor({ state: "attached", timeout: 5_000 });
    const stillOpen = await appPage
      .locator(".qe-path")
      .innerText()
      .then((s) => s.trim())
      .catch(() => null);
    assert.equal(stillOpen, selFile, "hiding the inspector lost the revealed source");
    // Leave it restored for the rest of the flow.
    await appPage.locator('button[aria-label="Toggle inspector"]').click();
    await appPage.locator(".wb-right:not(.wb-hidden)").waitFor({ timeout: 5_000 });
    console.log("  ok  inspector hidden + restored — selection and source intact");
    await assertNoIllegalTransition(appPage, "inspector hide/restore");

    // ---- Output expand + resize ----------------------------------------------
    await appPage.locator('button[aria-label="Expand output (Ctrl+J)"]').click();
    await appPage.locator(".logpanel").waitFor({ timeout: 5_000 });
    const outBefore = await box(appPage, ".logpanel");
    const outSplit = appPage.locator('hr[aria-label="Output height"]');
    await outSplit.focus();
    await outSplit.press("ArrowUp");
    await outSplit.press("ArrowUp");
    await outSplit.press("ArrowUp");
    const outAfter = await box(appPage, ".logpanel");
    assert.ok(
      outAfter.height > outBefore.height + 20,
      `output splitter did not resize (${outBefore.height} -> ${outAfter.height})`,
    );
    console.log(
      `  ok  output expanded + resized — height ${Math.round(outBefore.height)} -> ${Math.round(outAfter.height)}`,
    );

    // ---- Restart — no illegal transition --------------------------------------
    await appPage.locator("button", { hasText: "Restart" }).first().click();
    await until(
      async () => (await urlChip.innerText().catch(() => "")).trim().length > 0,
      "restart to reach running",
      60_000,
    );
    await assertNoIllegalTransition(appPage, "restart");
    console.log("  ok  Restart — no illegal transition");

    // ---- Stop — no illegal transition -----------------------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(() =>
      appPage.locator(".run-state").waitFor({ timeout: 30_000 }),
    );
    await assertNoIllegalTransition(appPage, "stop");
    console.log("  ok  Stop — no illegal transition");

    // ---- Change Project WHILE RUNNING -----------------------------------------
    // Run again, then change. The pick happens before the stop, so the
    // dialog appears while the server is still live — then the app must go
    // running -> stopping -> stopped -> analyzing, never running->analyzing.
    await appPage.locator("button", { hasText: "Run Project" }).click();
    // .run-state renders the synced store phase — waiting for "Running"
    // proves the UI left the stopped view. (The url chip lingers across
    // stop, so it can't be used as the readiness signal here.)
    await until(
      async () =>
        (await appPage
          .locator(".run-state")
          .first()
          .innerText()
          .catch(() => "")) === "Running",
      "run state to reach Running",
      120_000,
    );
    await urlChip.waitFor({ timeout: 120_000 });
    const url2 = (await urlChip.innerText()).trim();
    await shot(appPage, SHOTS, "05-running-again");
    console.log(`  ok  re-running: ${url2}`);

    const picker = pickFolder(appProc.pid, CHANGE_TARGET);
    let pickOut = "";
    picker.stdout.on("data", (d) => {
      pickOut += d;
    });
    picker.stderr.on("data", (d) => {
      pickOut += d;
    });

    await appPage.locator("button", { hasText: "Change" }).first().click();
    const pickCode = await new Promise((r) => picker.on("exit", r));
    assert.match(pickOut, /PICKED/, `folder picker failed (${pickCode}): ${pickOut}`);
    console.log("  ok  native folder dialog filled with fixtures/static-web");

    // The new project must analyze — the header name flips to static-web.
    await waitText(appPage, "static-web", 60_000).catch(async (e) => {
      await shot(appPage, SHOTS, "change-timeout");
      const name = await appPage
        .locator(".project-name")
        .innerText()
        .catch(() => "?");
      const phase = await appPage
        .locator(".run-state")
        .innerText()
        .catch(() => "?");
      const notices = await appPage
        .locator(".notice")
        .allInnerTexts()
        .catch(() => []);
      console.error(`diag: project=${name} phase=${phase} notices=${JSON.stringify(notices)}`);
      throw e;
    });
    await assertNoIllegalTransition(appPage, "change project while running");
    await shot(appPage, SHOTS, "06-changed-while-running");
    console.log("  ok  Change Project while running — stopped first, then analyzed");

    // The old dev server must be dead — the ClientFlow URL goes down.
    let urlDead = false;
    const deadline = Date.now() + 10_000;
    do {
      try {
        await fetch(url2, { signal: AbortSignal.timeout(1500) });
      } catch {
        urlDead = true;
        break;
      }
      await sleep(300);
    } while (Date.now() < deadline);
    assert.ok(urlDead, "previous dev server still responds after Change Project");
    const kids = childProcs(appProc.pid).filter((n) => /node|npm|next|cmd/i.test(n));
    assert.deepEqual(kids, [], `old dev process tree alive after change: ${kids.join(", ")}`);
    console.log("  ok  previous server dead — no orphaned process tree");

    // The change-project analysis is a fresh workspace — it may not be
    // running, and no transition error may be showing.
    await assertNoIllegalTransition(appPage, "post-change state");

    const gitAfter = gitPorcelain();
    assert.equal(gitAfter, gitBefore, "project repo state changed during verification");

    console.log("\nINSTALLED LAYOUT + TRANSITION VERIFICATION: PASS");
  } finally {
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nINSTALLED LAYOUT + TRANSITION VERIFICATION: FAIL — ${e.message}`);
  process.exit(1);
});
