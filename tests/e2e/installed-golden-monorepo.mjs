/**
 * Installed-app monorepo verification — nested Next.js target
 * (v0.2.0 Milestone 02 acceptance, GAP 2).
 *
 * Drives the REAL installed RootRay binary against the pnpm workspace
 * fixture `fixtures/pnpm-monorepo`, where workspace root ≠ target root:
 *
 *   workspace root = fixtures/pnpm-monorepo      (security/explorer/search root)
 *   active target  = fixtures/pnpm-monorepo/apps/web   (Next.js app, dev cwd)
 *
 *   installed exe → auto-analyze workspace → apps/web auto-selected →
 *   Run → next dev from apps/web → URL → real Chromium → bridge →
 *   Inspect UI → click <h1> rendered by apps/web/components/Banner.tsx →
 *   selection must report WORKSPACE-relative `apps/web/...` (not `src/...`,
 *   not an absolute path) → Quick Edit opens that file (no save) →
 *   Explorer still shows workspace-root dirs outside apps/web →
 *   workspace Search finds + opens files OUTSIDE the target root
 *   (search/security root = workspace root) →
 *   Stop → owned tree exits → scratch cleaned.
 *
 * Usage (repo root, app installed via the NSIS setup):
 *   node tests/e2e/installed-golden-monorepo.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const WORKSPACE = join(REPO_ROOT, "fixtures", "pnpm-monorepo");
const TARGET = join(WORKSPACE, "apps", "web");
const EXE = join(process.env.LOCALAPPDATA ?? "", "RootRay", "rootray-desktop.exe");
const CFG_DIR = join(process.env.APPDATA ?? "", "dev.rootray.app");
const SHOTS = join(REPO_ROOT, "target", "installed-verify-monorepo");
const CDP_PORT = 9232;

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  try {
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  } catch {}
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

const ENTRY_FILE = join(TARGET, "node_modules", ".cache", "rootray", "entry.js");

/** Legacy session-scoped dirs — none may exist after a session ends. */
function rootrayScratch() {
  const cache = join(TARGET, "node_modules", ".cache");
  if (!existsSync(cache)) return [];
  return readdirSync(cache).filter((d) => d.startsWith("rootray-"));
}

async function main() {
  assert.ok(existsSync(EXE), `installed exe missing: ${EXE}`);
  assert.ok(
    existsSync(join(TARGET, "node_modules", "next", "dist", "bin", "next")),
    "fixture deps missing — run `pnpm install` in fixtures/pnpm-monorepo",
  );
  const scratchBefore = rootrayScratch();

  const settings = {
    lastProject: WORKSPACE,
    recentProjects: [WORKSPACE],
    preferredLauncher: null,
    openBrowserAutomatically: false,
  };
  writeFileSync(join(CFG_DIR, "settings.json"), JSON.stringify(settings), { encoding: "utf8" });
  console.log(`seeded lastProject = ${WORKSPACE}`);

  const appProc = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
  });
  console.log(`launched installed app (pid ${appProc.pid})`);

  let cdp;
  let browser;
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

    // ---- workspace analysis; nested Next target must be active -----------
    await waitText(appPage, "fixture-pnpm-monorepo", 60_000);
    const facts = await appPage.locator(".facts").innerText();
    assert.match(facts, /pnpm workspace/, `workspace kind not recognized:\n${facts}`);
    const targetSelect = appPage.locator(".target-select");
    await targetSelect.waitFor({ timeout: 10_000 });
    const targetOptions = await targetSelect.locator("option").allInnerTexts();
    assert.ok(
      targetOptions.some((t) => t.startsWith("apps/web — Next.js")),
      `apps/web target missing: ${targetOptions.join(" | ")}`,
    );
    const activeTarget = await targetSelect.inputValue();
    if (activeTarget !== "apps/web") {
      await targetSelect.selectOption("apps/web");
      await waitText(appPage, "Next.js", 15_000);
    }
    assert.equal(await targetSelect.inputValue(), "apps/web");
    const factsAfter = await appPage.locator(".facts").innerText();
    assert.match(factsAfter, /Next\.js/, "framework not resolved for apps/web");
    assert.match(factsAfter, /pnpm run dev/, "runner not resolved");
    await shot(appPage, "01-workspace-analyzed");
    console.log(
      `  ok  workspace: pnpm workspace · active target apps/web (${await targetSelect.inputValue()})`,
    );
    console.log(`  ok  workspace root = ${WORKSPACE}`);
    console.log(`  ok  target root    = ${TARGET}`);

    // ---- Run → next dev must serve the nested app -------------------------
    await appPage.locator("button", { hasText: "Run Project" }).click();
    const urlChip = appPage.locator(".url-chip");
    try {
      await urlChip.waitFor({ timeout: 120_000 });
    } catch (e) {
      await shot(appPage, "run-timeout");
      const notice = await appPage
        .locator(".notice")
        .innerText()
        .catch(() => "");
      console.error(`notice=${notice}`);
      throw e;
    }
    const appUrl = (await urlChip.innerText()).trim();
    assert.match(appUrl, /^https?:\/\/(localhost|127\.0\.0\.1):\d+/, `bad URL: ${appUrl}`);

    // The session entry must appear under the TARGET's node_modules/.cache
    // at the stable path — factual proof the dev server rooted at apps/web
    // (cwd = target root). Bundler caches may still import this path after
    // the session, so it is stubbed on stop rather than deleted.
    let entrySeen = false;
    for (let i = 0; i < 30 && !entrySeen; i++) {
      await sleep(500);
      entrySeen = existsSync(ENTRY_FILE);
    }
    if (!entrySeen) {
      const logs = await appPage
        .locator(".logbox")
        .innerText()
        .catch(() => "");
      console.error(`app logs:\n${logs}`);
    }
    assert.ok(entrySeen, "no RootRay entry under apps/web/node_modules/.cache/rootray");
    console.log(`  ok  dev server running: ${appUrl} (entry: .cache/rootray/entry.js)`);
    await shot(appPage, "02-running");

    // ---- real browser → bridge → inspect → workspace-relative mapping -----
    browser = await chromium.launch();
    const devPage = await browser.newPage();
    await devPage.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const banner = devPage.locator("h1.mono-banner");
    await banner.waitFor({ timeout: 60_000 });
    console.log("  ok  apps/web page rendered in Chromium");

    await waitText(appPage, "Browser Connected", 30_000);
    await shot(appPage, "03-bridge-connected");
    console.log("  ok  inspector bridge connected");

    await appPage.locator("button", { hasText: "Inspect UI" }).click();
    await waitText(appPage, "Inspecting", 15_000);

    await banner.hover();
    await devPage.locator(".rr-box").waitFor({ timeout: 15_000 });
    await banner.click();

    await appPage.locator(".selection").waitFor({ timeout: 15_000 });
    const selTag = (await appPage.locator(".sel-tag").innerText()).trim();
    const selFile = (await appPage.locator(".sel-file").innerText()).trim();
    const selPos = (await appPage.locator(".sel-pos").innerText()).trim();
    const selComp = await appPage
      .locator(".sel-component")
      .innerText()
      .then((s) => s.trim())
      .catch(() => null);
    const previewLine = await appPage
      .locator(".src-line.selected .src-t")
      .innerText()
      .then((s) => s.trim())
      .catch(() => null);
    await shot(appPage, "04-selected");

    // THE acceptance condition: workspace-relative, path-safe identity.
    assert.equal(
      selFile,
      "apps/web/components/Banner.tsx",
      `expected workspace-relative path, got: ${selFile}`,
    );
    assert.doesNotMatch(selFile, /[:\\]|\.\./, `absolute/unsafe path leaked: ${selFile}`);
    assert.equal(selTag, "<h1>", selTag);
    assert.ok(existsSync(join(WORKSPACE, selFile)), `file missing at workspace root: ${selFile}`);
    assert.ok(previewLine?.includes("<h1"), `preview not the <h1> JSX: ${previewLine}`);
    console.log(
      `  ok  workspace-relative mapping: ${selFile} ${selPos} · component ${selComp ?? "—"}`,
    );

    await appPage.locator(".boxmodel").waitFor({ timeout: 10_000 });
    console.log("  ok  style intelligence rendered for nested-target selection");

    // ---- Quick Edit opens the workspace-rooted file (no save) -------------
    await appPage.locator("button", { hasText: "Quick Edit" }).click();
    const editor = appPage.locator(".qeditor");
    await editor.waitFor({ timeout: 15_000 });
    const qePath = (await editor.locator(".qe-path").innerText()).trim();
    assert.equal(qePath, "apps/web/components/Banner.tsx", `Quick Edit opened: ${qePath}`);
    await shot(appPage, "05-quick-edit-open");
    await appPage.locator('button[aria-label="Close editor"]').click();
    await editor.waitFor({ state: "detached", timeout: 10_000 });
    console.log(`  ok  Quick Edit opened ${qePath} (closed without saving)`);

    // ---- Explorer/Search scope stays at the workspace root -----------------
    const treeText = await appPage.locator(".ex-tree").innerText();
    assert.match(treeText, /(^|\n)\s*apps\b/, "explorer missing workspace dir 'apps'");
    assert.match(treeText, /(^|\n)\s*packages\b/, "explorer missing workspace dir 'packages'");
    console.log("  ok  Explorer rooted at workspace root (apps/ + packages/ visible)");

    // Workspace Search must cover the whole workspace root — not just the
    // active target. `express` only exists in apps/api/src/index.js, which
    // lives OUTSIDE the target root (apps/web) but INSIDE the workspace root.
    await appPage.keyboard.press("Control+Shift+F");
    const palette = appPage.locator(".palette");
    await palette.waitFor({ timeout: 10_000 });
    await appPage.locator(".palette-input").fill("express");
    const hits = appPage.locator(".search-item");
    await hits.first().waitFor({ timeout: 15_000 });
    const locs = await hits.locator(".palette-loc").allInnerTexts();
    assert.ok(
      locs.some((l) => l.startsWith("apps/api/src/index.js:")),
      `search missed apps/api (workspace root leak): ${locs.join(" | ")}`,
    );
    for (const l of locs) {
      assert.doesNotMatch(l, /[:\\]{2}|^\//, `absolute path leaked in results: ${l}`);
    }
    console.log(`  ok  Workspace Search rooted at workspace root (${locs[0]} …)`);

    // Security root proof: open the search hit — a file outside the target
    // root must still be readable/editable (bounded at the workspace root).
    await hits.filter({ hasText: "apps/api/src/index.js" }).first().click();
    await editor.waitFor({ timeout: 15_000 });
    const apiPath = (await editor.locator(".qe-path").innerText()).trim();
    assert.equal(apiPath, "apps/api/src/index.js", `security-rooted open failed: ${apiPath}`);
    await appPage.locator('button[aria-label="Close editor"]').click();
    await editor.waitFor({ state: "detached", timeout: 10_000 });
    console.log(`  ok  Security root = workspace root (opened ${apiPath} outside target root)`);

    // ---- Stop → process tree + scratch cleanup -----------------------------
    await appPage.locator(".runner-actions button", { hasText: "Stop" }).first().click();
    await waitText(appPage, "Stopped", 30_000).catch(async () => {
      await appPage.locator(".run-state").waitFor({ timeout: 30_000 });
    });
    await shot(appPage, "06-stopped");

    await sleep(1500);
    const kids = childProcs(appProc.pid).filter((n) => /node|pnpm|next|cmd/i.test(n));
    assert.deepEqual(kids, [], `dev process tree still alive: ${kids.join(", ")}`);
    // Probe the TCP listener directly — a browser navigation can be served
    // by a service worker / cache with the server already dead.
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

    const scratchAfter = rootrayScratch();
    assert.deepEqual(
      scratchAfter,
      scratchBefore,
      `scratch not cleaned: before=${scratchBefore} after=${scratchAfter}`,
    );
    // The stable entry must remain as an inert stub — deleting it would
    // break stale bundler-cache imports on later (even unshimmed) runs.
    const stub = existsSync(ENTRY_FILE) ? readFileSync(ENTRY_FILE, "utf8") : "";
    assert.match(stub, /session ended/, `entry not stubbed after stop: ${stub.slice(0, 120)}`);
    console.log(
      `  ok  scratch dirs: [${scratchAfter.join(", ") || "none"}] · entry stubbed in place`,
    );

    console.log("\nMONOREPO INSTALLED VERIFICATION: PASS");
    console.log(`  workspace root : ${WORKSPACE}`);
    console.log(`  target root    : ${TARGET}`);
    console.log(`  selected source: ${selFile} ${selPos}`);
  } finally {
    await browser?.close().catch(() => {});
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
  console.error(`\nMONOREPO INSTALLED VERIFICATION: FAIL — ${e.message}`);
  process.exit(1);
});
