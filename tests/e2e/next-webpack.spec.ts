/**
 * RootRay × Next.js webpack-path end-to-end test.
 *
 * Two suites, same production launch path (`node --require next-shim.cjs
 * next dev`):
 *   1. Next 16 with `--webpack` — the explicit webpack fallback flag.
 *   2. Next 15 — webpack is the default bundler there.
 *
 * Proves the `config.webpack` wrapper in the shim instruments project JSX
 * and boots the runtime on both bundler paths and major versions.
 */

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type NextFixtureRun, REPO_ROOT, startNextFixture, stopNextFixture } from "./harness";

test.setTimeout(300_000);
test.describe.configure({ mode: "serial" });

const NEXT16_PORT = 5446;
const NEXT15_PORT = 5447;

let run16: NextFixtureRun | undefined;
let run15: NextFixtureRun | undefined;

test.beforeAll(async () => {
  run16 = await startNextFixture(join(REPO_ROOT, "fixtures", "nextjs-inspector"), NEXT16_PORT, [
    "--webpack",
  ]);
  run15 = await startNextFixture(join(REPO_ROOT, "fixtures", "nextjs-15"), NEXT15_PORT);
});

test.afterAll(async () => {
  await stopNextFixture(run16);
  await stopNextFixture(run15);
});

test("next 16 --webpack: instrumented render + runtime handshake", async ({ page }) => {
  await page.goto(run16!.appUrl);
  await expect(page.locator("text=Inspector fixture")).toBeVisible({ timeout: 90_000 });

  const button = page.locator("button", { hasText: "Count is" }).first();
  expect(await button.getAttribute("data-rootray-file")).toBe("components/ActionButton.tsx");
  const nav = page.locator("nav").first();
  expect(await nav.getAttribute("data-rootray-file")).toBe("components/Navbar.tsx");

  await run16!.bridge.waitFor(() => run16!.bridge.ready, "runtime:ready (webpack)");
  expect(run16!.bridge.rejected).toEqual([]);

  // Selection carries exact source under webpack too.
  run16!.bridge.sendInspectSet(true);
  await button.click();
  await run16!.bridge.waitFor(
    () => run16!.bridge.selections.length > 0,
    "element:selected (webpack)",
  );
  const sel = run16!.bridge.selections.at(-1) as {
    source: { relativePath: string; componentName?: string };
  };
  expect(sel.source.relativePath).toBe("components/ActionButton.tsx");
  expect(sel.source.componentName).toBe("ActionButton");
});

test("next 15 webpack: instrumented render + runtime handshake", async ({ page }) => {
  await page.goto(run15!.appUrl);
  await expect(page.locator("text=Next 15 fixture")).toBeVisible({ timeout: 90_000 });

  const badge = page.locator("span.badge").first();
  expect(await badge.getAttribute("data-rootray-file")).toBe("components/Badge.tsx");
  const main = page.locator("main").first();
  expect(await main.getAttribute("data-rootray-file")).toBe("app/page.tsx");

  await run15!.bridge.waitFor(() => run15!.bridge.ready, "runtime:ready (next15)");
  expect(run15!.bridge.rejected).toEqual([]);
});
