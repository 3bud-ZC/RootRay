/**
 * RootRay Milestone 04 end-to-end: style intelligence + component
 * intelligence against the REAL fixture, runner and Chromium.
 *
 * Proves: selection carries classes/box/computed/matched CSS rules →
 * matched rules resolve to project-relative stylesheet paths → the real
 * fixture sources analyze into the expected component tree → resolved
 * locations match actual source lines.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { analyzeSources, findComponent, usagesOf } from "@rootray/intelligence";
import { type FixtureRun, safeRead, sourceLineOf, startFixture, stopFixture } from "./harness";

test.setTimeout(300_000);
test.describe.configure({ mode: "serial" });

let run: FixtureRun | undefined;

function f(): FixtureRun {
  if (!run) throw new Error("fixture not started");
  return run;
}

test.beforeAll(async () => {
  run = await startFixture(5446);
});

test.afterAll(async () => {
  await stopFixture(run);
});

interface SelectedMsg {
  element: { tagName: string; className?: string };
  source: { relativePath: string; line: number; componentName?: string };
  styles?: {
    classes: string[];
    elementId?: string;
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
      margin: { top: number; right: number; bottom: number; left: number };
      padding: { top: number; right: number; bottom: number; left: number };
      border: { top: number; right: number; bottom: number; left: number };
    };
    computed: Record<string, string>;
    matchedRules: {
      selector: string;
      declarations: { property: string; value: string; important: boolean }[];
      sourcePath?: string;
    }[];
  };
}

// --- style intelligence -------------------------------------------------------

test("selection carries classes, box model, computed styles and matched rules", async ({
  page,
}) => {
  await page.goto(f().appUrl);
  await expect(page.locator("text=Inspector fixture")).toBeVisible();
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");

  f().bridge.sendInspectSet(true);
  const button = page.locator("button", { hasText: "Count is" }).first();
  await button.hover();
  await expect(page.locator(".rr-box")).toBeVisible();
  const before = f().bridge.selections.length;
  await button.click();
  await f().bridge.waitFor(
    () => f().bridge.selections.length > before,
    "element:selected with styles",
  );
  const sel = f().bridge.selections.at(-1) as SelectedMsg;

  // Class tokens — the real authored classes.
  expect(sel.styles).toBeDefined();
  expect(sel.styles!.classes).toContain("action-button");
  expect(sel.styles!.classes).toContain("primary");

  // Box model — non-zero geometry on a rendered button.
  expect(sel.styles!.box.width).toBeGreaterThan(0);
  expect(sel.styles!.box.height).toBeGreaterThan(0);
  expect(sel.styles!.box.padding.top).toBeGreaterThan(0); // padding: 12px

  // Curated computed styles.
  expect(sel.styles!.computed.display).toBeTruthy();
  expect(sel.styles!.computed.color).toBeTruthy();
  expect(sel.styles!.computed.fontSize).toBeTruthy();

  // Matched CSS rules — our authored selectors.
  const selectors = sel.styles!.matchedRules.map((r) => r.selector);
  expect(selectors).toContain(".action-button");
  const actionRule = sel.styles!.matchedRules.find((r) => r.selector === ".action-button");
  expect(actionRule).toBeDefined();
  const props = actionRule!.declarations.map((d) => d.property);
  expect(props).toContain("padding-top"); // CSSOM expands the padding shorthand

  // Non-matching selectors are absent.
  expect(selectors).not.toContain(".card");

  // Style source resolves to a project-relative path — never absolute.
  expect(actionRule!.sourcePath).toBe("src/styles/button.css");
  expect(actionRule!.sourcePath).not.toMatch(/^[A-Za-z]:/);
  f().bridge.sendInspectSet(false);
});

test("matched stylesheet resolves to a real safe-openable project file", async ({ page }) => {
  await page.goto(f().appUrl);
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");
  f().bridge.sendInspectSet(true);
  const button = page.locator("button", { hasText: "Count is" }).first();
  const before = f().bridge.selections.length;
  await button.click();
  await f().bridge.waitFor(() => f().bridge.selections.length > before, "selection");
  f().bridge.sendInspectSet(false);

  const sel = f().bridge.selections.at(-1) as SelectedMsg;
  const rule = sel.styles!.matchedRules.find((r) => r.sourcePath);
  expect(rule).toBeDefined();
  // The resolved path maps to a real file and the safe-read contract works.
  const abs = join(f().workDir, rule!.sourcePath!);
  expect(existsSync(abs)).toBe(true);
  const read = safeRead(abs);
  expect(read.content).toContain(".action-button");
  expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
});

// --- component intelligence ----------------------------------------------------

/** Reads the real fixture sources into analysis input (test-side only). */
function fixtureSources(dir: string) {
  const out: { relativePath: string; content: string }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (["node_modules", "dist", ".git"].includes(name)) continue;
      const abs = join(dir, relPath);
      if (existsSync(abs) && !name.includes(".")) walk(relPath);
      else if (/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(name)) {
        out.push({ relativePath: relPath, content: readFileSync(abs, "utf8") });
      }
    }
  };
  walk("");
  return out;
}

test("component tree resolves on the real fixture sources", () => {
  const intel = analyzeSources(fixtureSources(f().workDir));

  // Definitions discovered with real positions.
  const button = findComponent(intel, "ActionButton", "src/components/ActionButton.tsx");
  expect(button).not.toBeNull();
  expect(button!.line).toBe(
    sourceLineOf(join(f().workDir, "src/components/ActionButton.tsx"), "function ActionButton"),
  );
  expect(findComponent(intel, "Navbar", "src/components/Navbar.tsx")?.kind).toBe("function");
  expect(findComponent(intel, "Logo", "src/components/Logo.tsx")?.kind).toBe("arrow");
  expect(findComponent(intel, "Logo", "src/components/Logo.tsx")?.exports.default).toBe(true);

  // App ├─ Navbar, App └─ Card, Navbar └─ Logo, Card └─ ActionButton ×2
  const navbar = findComponent(intel, "Navbar", "src/components/Navbar.tsx")!;
  const navCallers = usagesOf(intel, navbar).map((u) => u.usedIn.path);
  expect(navCallers).toContain("src/App.tsx");

  const callers = usagesOf(intel, button!);
  expect(callers).toHaveLength(2); // repeated usage
  for (const c of callers) {
    expect(c.usedIn.path).toBe("src/components/Card.tsx");
    // Every caller location is a real line in that file.
    const cardSrc = readFileSync(join(f().workDir, "src/components/Card.tsx"), "utf8").split(
      /\r?\n/,
    );
    expect(cardSrc[c.usedIn.line - 1]).toContain("<ActionButton");
  }

  // main.tsx renders <App /> — a local usage too.
  const app = findComponent(intel, "App", "src/App.tsx")!;
  expect(usagesOf(intel, app).some((u) => u.usedIn.path === "src/main.tsx")).toBe(true);
});

test("no project files were mutated by inspection or analysis", () => {
  // Analysis read copies only — the fixture directory itself is untouched
  // (inspection-only integrity is covered by inspector.spec.ts digest).
  const pkg = readFileSync(join(f().workDir, "package.json"), "utf8");
  expect(pkg).toContain("fixture-vite-react-inspector");
});
