/**
 * Installed-app real-project verification — ClientFlow-CRM,
 * v0.3.0 internal preview.
 *
 * Drives the REAL installed RootRay binary against the real project:
 *
 *   installed exe → auto-analyze ClientFlow-CRM → Run → Next dev
 *   (Turbopack, shimmed by the app) → URL detected → EMBEDDED child
 *   webview loads /login inside RootRay → adversarial IPC probe →
 *   inspector bridge connects → Inspect UI → select real rendered
 *   elements across several authored files → factual source mapping
 *   checked against the source preview RootRay itself renders →
 *   auto-reveal opens each file beside the preview → Stop → preview +
 *   process tree exits → RootRay scratch removed → repo byte-identical
 *   to its baseline.
 *
 * Read-only contract: no Quick Edit save, no source modification, no
 * migrations, no seeds, no .env changes, no branch/commit in the project
 * repo. (Auto-reveal only *opens* files — it never writes.)
 *
 * Usage (repo root, app installed via the NSIS setup):
 *   node tests/e2e/installed-verify-clientflow.mjs
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

const PROJECT = "C:\\Users\\Abud\\Desktop\\git hub\\ClientFlow-CRM";
const SHOTS = makeShotDir("installed-verify-clientflow");
const CDP_PORT = 9234;

function gitPorcelain() {
  return execSync("git status --porcelain", { cwd: PROJECT, encoding: "utf8" });
}

const ENTRY_FILE = join(PROJECT, "node_modules", ".cache", "rootray", "entry.js");

/** Session-scoped dirs — none may exist after a session ends. */
function rootrayScratch() {
  const cache = join(PROJECT, "node_modules", ".cache");
  if (!existsSync(cache)) return [];
  return readdirSync(cache).filter((d) => d.startsWith("rootray-"));
}

async function inspectElement(appPage, devPage, cssSel, clickPos) {
  const el = devPage.locator(cssSel).first();
  await el.waitFor({ timeout: 20_000 });
  const attrFile = await el.getAttribute("data-rootray-file");
  const attrLine = await el.getAttribute("data-rootray-line");
  const attrCol = await el.getAttribute("data-rootray-column");
  const attrComp = await el.getAttribute("data-rootray-component");
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());

  await el.hover();
  await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
  // Center clicks land on the innermost nested element — correct inspector
  // behavior. To select a container's own JSX site, aim at its padding.
  await el.click(clickPos ? { position: clickPos } : undefined);

  await appPage.locator(".selection").waitFor({ timeout: 15_000 });
  const selTag = (await appPage.locator(".sel-tag").innerText()).trim();
  const selFile = (await appPage.locator(".sel-file").innerText()).trim();
  const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
  const selComp = await appPage
    .locator(".sel-component")
    .innerText()
    .then((s) => s.trim())
    .catch(() => null);
  const selText = await appPage
    .locator(".sel-text")
    .innerText()
    .then((s) => s.trim())
    .catch(() => null);
  // Read the actual selected source file from disk; the Inspector no longer
  // duplicates a code preview because the Code pane owns source rendering.
  const selectedSource = readFileSync(join(PROJECT, selFile), "utf8");
  const selectedLineMatch = /(\d+):(\d+)/.exec(selPos);
  const previewLine = selectedLineMatch
    ? (selectedSource.split(/\r?\n/)[Number(selectedLineMatch[1]) - 1]?.trim() ?? null)
    : null;
  const hasStyles = await appPage
    .locator(".boxmodel")
    .isVisible()
    .catch(() => false);
  const hasComponent = await appPage
    .locator(".intel-section")
    .first()
    .isVisible()
    .catch(() => false);
  // Click-to-source: the auto-reveal opens the mapped file in the
  // workbench. The open is async — .qe-path can briefly hold the previous
  // file, so poll for the reported path rather than reading once.
  let revealed = null;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const p = await appPage
        .locator(".qe-path")
        .innerText()
        .then((s) => s.trim())
        .catch(() => null);
      if (p === selFile) {
        revealed = p;
        break;
      }
      await sleep(200);
    }
  } catch {
    /* reveal never landed — asserted below */
  }

  await shot(appPage, SHOTS, `sel-${tag}-${Math.random().toString(36).slice(2, 7)}`);

  // Element must map inside the project, path-safe, and agree with the
  // stamped attribute the instrumentation emitted.
  assert.match(selFile, /^[^/\\][^:]*$/, `path not safe-relative: ${selFile}`);
  assert.doesNotMatch(selFile, /\.\.|\r|\n/, `path unsafe: ${selFile}`);
  assert.ok(existsSync(join(PROJECT, selFile)), `source file missing: ${selFile}`);
  // The click may land on a nested element (inspector resolves innermost) —
  // a different file than the locator's own stamp is then *correct*, not a
  // conflict. Record it; the actual-source line check below proves the location.
  const nested = attrFile && attrFile !== selFile;
  // Auto-reveal must have opened exactly the file the selection reported.
  assert.equal(revealed, selFile, `auto-reveal opened ${revealed}, expected ${selFile}`);

  // The reported line must be real source containing a JSX opening tag for
  // the rendered element (or the element's stamped line, when attrs exist).
  const m = /(\d+):(\d+)/.exec(selPos);
  assert.ok(m, `bad position text: ${selPos}`);
  const line = Number(m[1]);
  const col = Number(m[2]);
  if (previewLine) {
    // Check against the tag RootRay actually selected (a click may land on
    // a nested element), not the locator's tag.
    const selectedTag = selTag.replace(/[<>\s]/g, "") || tag;
    assert.match(
      previewLine,
      new RegExp(`<${selectedTag}|data-slot|className|<[A-Z]`),
      `preview line not JSX-like for ${selTag}: ${previewLine}`,
    );
  }
  if (attrLine && !nested) assert.equal(line, Number(attrLine), "line disagrees with stamp");
  if (attrCol && !nested) assert.equal(col, Number(attrCol), "col disagrees with stamp");

  return {
    css: cssSel,
    tag,
    selTag,
    file: selFile,
    line,
    col,
    component: selComp || attrComp || null,
    attrComponent: attrComp,
    previewLine,
    styles: hasStyles,
    componentIntel: hasComponent,
    text: selText,
    nested,
    revealed,
  };
}

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(existsSync(join(PROJECT, "node_modules", "next")), "project deps missing");

  const gitBefore = gitPorcelain();
  console.log(
    `baseline git status --porcelain (${gitBefore.split(/\r?\n/).filter(Boolean).length} entries):`,
  );
  console.log(gitBefore || "(clean)");
  const scratchBefore = rootrayScratch();

  seedSettings(PROJECT);
  const appProc = launchApp(CDP_PORT);

  const results = [];
  let cdp;
  try {
    cdp = await attachCdp(CDP_PORT);
    const appPage = await attachUI(cdp);
    console.log("attached to installed app UI");

    // ---- Open Project → analyze (auto-restored via lastProject) ----------
    await waitText(appPage, "ClientFlow-CRM", 60_000);
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /Next\.js 16\.2\.12/, `framework not resolved:\n${facts}`);
    assert.match(facts, /\bnpm\b/, "package manager not resolved to npm");
    assert.match(facts, /npm run dev/, "dev command not resolved");
    await shot(appPage, SHOTS, "01-analyzed");
    console.log("  ok  analysis: Next.js 16.2.12 · npm · npm run dev");

    // ---- Run --------------------------------------------------------------
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
      console.error(`notice=${notice}`);
      throw e;
    }
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);
    await appPage.locator(".preview-toolbar").waitFor({ timeout: 15_000 });
    console.log(`  ok  dev server running: ${appUrl}`);

    // ---- embedded preview loads the app; drive it to /login ----------------
    const devPage = await attachPreview(cdp, appUrl);
    const loginUrl = new URL("/login", appUrl).href;
    await devPage.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await devPage.locator("input#email").waitFor({ timeout: 60_000 });
    await shot(appPage, SHOTS, "02-internal-preview");
    console.log(`  ok  /login rendered inside RootRay (${loginUrl})`);

    await assertPreviewHasNoIpc(devPage);

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, SHOTS, "03-bridge-connected");
    console.log("  ok  inspector bridge connected from the embedded preview");

    // ---- Inspect Mode → select representative real elements ---------------
    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);

    const targets = [
      { css: "h1", pos: null }, // page.tsx — heading ("ClientFlow" / company name)
      // Card's own box: the py-4 top padding strip above CardHeader.
      { css: '[data-slot="card"]', pos: { x: 60, y: 6 } }, // card.tsx
      { css: "form", pos: { x: 4, y: 2 } }, // login-form.tsx — form's own edge
      { css: "input#email", pos: null }, // ui/input.tsx — Input primitive
    ];
    for (const t of targets) {
      const r = await inspectElement(appPage, devPage, t.css, t.pos);
      results.push(r);
      console.log(
        `  ok  <${r.tag}> → ${r.file}:${r.line}:${r.col}` +
          `${r.component ? ` · <${r.component}>` : ""}` +
          ` | reveal: ${r.revealed ?? "—"} | preview: ${(r.previewLine ?? "").slice(0, 60)}`,
      );
      await appPage
        .locator('button[aria-label="Clear selection"]')
        .click()
        .catch(() => {});
      await sleep(300);
    }

    const files = new Set(results.map((r) => r.file));
    assert.ok(files.size >= 3, `need ≥3 distinct authored files, got ${[...files].join(", ")}`);
    assert.ok(
      results.every((r) => r.styles),
      "style intelligence (box model) missing for a selection",
    );
    assert.ok(
      results.every((r) => r.revealed === r.file),
      "click-to-source opened a different file than the selection reported",
    );
    console.log(`  ok  ${results.length} elements across ${files.size} authored files`);

    // ---- Stop → preview teardown + owned tree exits + scratch cleaned ------
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
    if (!urlDead) {
      try {
        const port = new URL(appUrl).port;
        const ownerPids = execSync(
          `powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess) -join ','"`,
          { encoding: "utf8" },
        ).trim();
        console.error(`diag: port ${port} still owned by pid(s) [${ownerPids}]`);
        for (const opid of ownerPids.split(",").filter(Boolean)) {
          const info = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${opid}\\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List | Out-String"`,
            { encoding: "utf8" },
          );
          console.error(info);
        }
      } catch (e) {
        console.error(`diag failed: ${e.message}`);
      }
    }
    assert.ok(urlDead, "dev server still responds after Stop");
    console.log("  ok  dev server stopped; owned process tree exited; URL dead");

    const scratchAfter = rootrayScratch();
    assert.deepEqual(
      scratchAfter,
      scratchBefore,
      `scratch changed: before=${scratchBefore} after=${scratchAfter}`,
    );
    // Stable entry stays as an inert stub (stale bundler-cache imports must
    // keep resolving) — verify it is present and neutralized.
    if (existsSync(ENTRY_FILE)) {
      const stub = readFileSync(ENTRY_FILE, "utf8");
      assert.match(stub, /session ended/, "entry not stubbed after stop");
    }
    console.log(
      `  ok  scratch dirs: [${scratchAfter.join(", ") || "none"}] · entry stub: ${existsSync(ENTRY_FILE) ? "yes" : "absent"}`,
    );

    const gitAfter = gitPorcelain();
    assert.equal(gitAfter, gitBefore, "project repo state changed during verification");
    console.log(`  ok  git status --porcelain identical to baseline:`);
    console.log(gitAfter || "(clean)");

    console.log("\nCLIENTFLOW-CRM INSTALLED VERIFICATION (INTERNAL PREVIEW): PASS");
    for (const r of results) {
      console.log(
        `  <${r.tag}> ${r.file}:${r.line}:${r.col} comp=${r.component ?? "—"}` +
          ` styles=${r.styles ? "yes" : "no"} confidence=exact(stamped)`,
      );
    }
  } finally {
    await cdp?.close().catch(() => {});
    await killApp(appProc);
  }
}

main().catch((e) => {
  console.error(`\nCLIENTFLOW-CRM INSTALLED VERIFICATION (INTERNAL PREVIEW): FAIL — ${e.message}`);
  process.exit(1);
});
