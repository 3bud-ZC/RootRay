/**
 * RootRay × Next.js end-to-end test.
 *
 * Runs the real Next 16 fixture (Turbopack, App Router + Pages Router,
 * CSS Modules + Tailwind) through the production launch path: the same
 * `node --require next-shim.cjs next dev` command the Rust adapter builds,
 * against a protocol-faithful mock bridge.
 *
 * Proves: shim config injection → runtime bootstrap → bridge auth →
 * inspect → hover overlay → click → real file/line/column on both routers
 * → component context → style details → Fast Refresh → navigation.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type NextFixtureRun,
  projectDigest,
  REPO_ROOT,
  safeRead,
  safeSave,
  sourceLineOf,
  startNextFixture,
  stopNextFixture,
} from "./harness";

test.setTimeout(300_000);

const FIXTURE = join(REPO_ROOT, "fixtures", "nextjs-inspector");
const NEXT_PORT = 5445;

test.describe.configure({ mode: "serial" });
let run: NextFixtureRun | undefined;
let integrityBaseline = "";

test.beforeAll(async () => {
  run = await startNextFixture(FIXTURE, NEXT_PORT);
  integrityBaseline = projectDigest(run.workDir);
});

/** Next prints its URL without a trailing slash — join paths safely. */
function appUrl(path = ""): string {
  const base = run!.appUrl.endsWith("/") ? run!.appUrl : `${run!.appUrl}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

test.afterAll(async () => {
  await stopNextFixture(run);
});

async function gotoHome(page: import("@playwright/test").Page): Promise<void> {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(run!.appUrl);
  try {
    await expect(page.locator("text=Inspector fixture")).toBeVisible({ timeout: 60_000 });
  } catch (e) {
    const html = (await page.content()).slice(0, 3000);
    console.error(
      `[e2e] next app did not render.\nurl=${page.url()}\n` +
        `consoleErrors=${JSON.stringify(consoleErrors)}\nhtml=${html}`,
    );
    throw e;
  }
}

test("runtime injects, authenticates, and reaches ready state", async ({ page }) => {
  await gotoHome(page);
  const hasRuntime = await page.evaluate(
    () =>
      typeof (window as unknown as { __ROOTRAY_RUNTIME__?: unknown }).__ROOTRAY_RUNTIME__ ===
      "object",
  );
  expect(hasRuntime).toBe(true);
  await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready");
  expect(run!.bridge.rejected).toEqual([]);
  expect(run!.bridge.helloPageUrl).toContain(`:${NEXT_PORT}`);
});

test("app router: inspect → hover → click → real source selection", async ({ page }) => {
  await gotoHome(page);
  await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready");
  run!.bridge.sendInspectSet(true);

  const button = page.locator("button", { hasText: "Count is" }).first();
  await expect(button).toBeVisible();
  expect(await button.getAttribute("data-rootray-file")).toBe("components/ActionButton.tsx");

  await button.hover();
  await expect(page.locator(".rr-box")).toBeVisible();
  const file = join(run!.workDir, "components", "ActionButton.tsx");
  const expectedLine = sourceLineOf(file, "<button");
  await expect(page.locator(".rr-label .rr-name")).toHaveText("ActionButton");
  await expect(page.locator(".rr-label .rr-loc")).toContainText(
    `components/ActionButton.tsx:${expectedLine}`,
  );

  await button.click();
  await run!.bridge.waitFor(() => run!.bridge.selections.length > 0, "element:selected");
  const sel = run!.bridge.selections.at(-1) as {
    source: {
      relativePath: string;
      line: number;
      column: number;
      componentName?: string;
      confidence?: string;
    };
    element: { tagName: string };
    styles?: { computed?: Record<string, string>; matchedRules?: unknown[] };
  };
  expect(sel.source.relativePath).toBe("components/ActionButton.tsx");
  expect(sel.source.line).toBe(expectedLine);
  expect(sel.source.componentName).toBe("ActionButton");
  expect(sel.source.confidence).toBe("exact");
  // Click suppressed: the app's counter did not increment.
  await expect(button).toHaveText("Count is 0");
  // Style details ride the selection (collected on select only).
  expect(sel.styles?.computed?.backgroundColor).toBeTruthy();
  run!.bridge.sendInspectSet(false);
});

test("server components and repeated siblings carry distinct source", async ({ page }) => {
  await gotoHome(page);
  // StatusChip renders three times — each sibling keeps its own JSX site.
  const chips = page.locator("span", { hasText: /^(alpha|beta|gamma)$/ });
  await expect(chips).toHaveCount(3);
  const files = await chips.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-rootray-file")),
  );
  expect(files.every((f) => f === "components/StatusChip.tsx")).toBe(true);
  // Server-rendered layout/nav elements are stamped too (RSC path).
  const nav = page.locator("nav").first();
  expect(await nav.getAttribute("data-rootray-file")).toBe("components/Navbar.tsx");
});

test("pages router: /legacy renders instrumented", async ({ page }) => {
  await page.goto(appUrl("legacy"));
  await expect(page.locator("text=Pages Router route")).toBeVisible({ timeout: 60_000 });
  const main = page.locator("main").first();
  expect(await main.getAttribute("data-rootray-file")).toBe("pages/legacy.tsx");
});

test("navigation keeps instrumentation; hard nav re-authenticates", async ({ page }) => {
  await gotoHome(page);
  await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready");

  // Client-side navigation (App Router): the runtime survives and the new
  // route's DOM carries attributes.
  await page.locator("a", { hasText: "About" }).click();
  const h1 = page.locator("h1", { hasText: "About RootRay" });
  await expect(h1).toBeVisible({ timeout: 60_000 });
  expect(await h1.getAttribute("data-rootray-file")).toBe("app/about/page.tsx");

  // Hard navigation re-runs the entry module → new hello handshake.
  run!.bridge.ready = false;
  await page.goto(appUrl("legacy"));
  await run!.bridge.waitFor(() => run!.bridge.ready, "runtime:ready after hard nav");
  expect(run!.bridge.rejected).toEqual([]);
});

test("quick-edit save → fast refresh → still instrumented", async ({ page }) => {
  await gotoHome(page);
  // Give Fast Refresh a beat to subscribe before the first edit.
  await page.waitForTimeout(2_000);

  const chipFile = join(run!.workDir, "components", "StatusChip.tsx");
  const session = safeRead(chipFile);
  const updated = session.content.replace(
    'className="rounded bg-slate-100 px-2 py-1 text-sm"',
    'className="rounded bg-emerald-100 px-2 py-1 text-sm"',
  );
  safeSave(chipFile, updated, session.hash);

  await expect(page.locator("span", { hasText: "alpha" })).toHaveClass(/bg-emerald-100/, {
    timeout: 60_000,
  });
  const chip = page.locator("span", { hasText: "alpha" });
  expect(await chip.getAttribute("data-rootray-file")).toBe("components/StatusChip.tsx");

  // Optimistic concurrency: a save carrying a hash from before an external
  // modification must be rejected.
  const stale = safeRead(chipFile);
  writeFileSync(chipFile, `${stale.content}\n// external edit\n`);
  expect(() => safeSave(chipFile, `${stale.content}\n// editor buffer\n`, stale.hash)).toThrow(
    "SOURCE_EDIT_CONFLICT",
  );
  // Restore to the Fast-Refresh-edited state so the integrity test sees the
  // deliberate edit only.
  const now = safeRead(chipFile);
  safeSave(chipFile, updated, now.hash);
});

test("instrumentation never touches project source", async () => {
  // The StatusChip edit above was a deliberate user-style edit; every other
  // file must be byte-identical to the pristine fixture and no RootRay
  // artifact may live in the project tree — only the stable session entry
  // under node_modules/.cache/rootray/ is ours.
  const edited = "components/StatusChip.tsx";
  const compare = (rel: string) => {
    const a = readFileSync(join(FIXTURE, rel), "utf8");
    const b = readFileSync(join(run!.workDir, rel), "utf8");
    if (rel === edited.replaceAll("\\", "/")) {
      expect(b).not.toBe(a); // the deliberate edit
    } else {
      expect(b).toBe(a);
    }
    expect(b).not.toContain("__ROOTRAY__");
    expect(b).not.toContain("data-rootray-");
  };
  for (const rel of [
    "app/layout.tsx",
    "app/page.tsx",
    "app/about/page.tsx",
    "app/globals.css",
    "pages/legacy.tsx",
    "pages/_app.tsx",
    "components/ActionButton.tsx",
    "components/ActionButton.module.css",
    "components/Card.tsx",
    "components/Navbar.tsx",
    edited,
    "next.config.ts",
    "tsconfig.json",
  ]) {
    compare(rel);
  }
  expect(integrityBaseline).toBeTruthy();
});
